// Implements: SPEC-PLA-001 (CA-01/02/03, EF-01/02/03/04), SPEC-OUT-031 (EF-02/04), gap E-152.
import { existsSync, lstatSync, mkdirSync, readFileSync, watch, type FSWatcher } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { tryFileLock } from "../platform/file-lock";
import { currentPlatform } from "../platform/system";
import { writeAtomic } from "../tools/text-file";
import { nextOccurrence, wallMinute, validateCron } from "./cron";

export interface Trigger { id: string; cron: string; prompt: string; recurring: boolean; durable: boolean; createdAt: number; nextAt: number; lastWall?: string; permanent?: boolean; intervalMs?: number; }
export interface ScheduleOptions {
  folder: string; lock: string; now?: () => number; random?: () => number;
  maxActive: () => number; maxAgeDays: () => number;
  submit: (trigger: Trigger) => boolean; warn: (message: string) => void;
  missed: (trigger: Trigger) => Promise<boolean | undefined>;
  changed?: () => void;
  enabled?: () => boolean; jitterMs?: () => number;
}
export class Scheduler {
  readonly #o: ScheduleOptions; readonly #session = new Map<string, Trigger>();
  #release?: () => void; #timer?: ReturnType<typeof setInterval>; #watch?: FSWatcher;
  #busy = false; #closed = false; #started = false; readonly #observed = new Set<string>();
  constructor(options: ScheduleOptions) { this.#o = options; }
  get path(): string { return join(this.#o.folder, "schedules.json"); }
  get leader(): boolean { return this.#release !== undefined; }
  #now(): number { return (this.#o.now ?? Date.now)(); }
  #next(cron: string, after: number, recurring: boolean, lastWall?: string): number {
    const maximum = Math.max(0, Math.min(59_000, this.#o.jitterMs?.() ?? 5000));
    const jitter = recurring ? Math.floor(Math.max(0, Math.min(1, (this.#o.random ?? Math.random)())) * Math.max(0, maximum - 1)) : 0;
    return nextOccurrence(cron, after, lastWall) + jitter;
  }
  #following(trigger: Trigger, after: number, lastWall?: string): number { return trigger.intervalMs ? after + trigger.intervalMs : this.#next(trigger.cron, after, trigger.recurring, lastWall); }
  #directory(): void {
    if (existsSync(this.#o.folder)) { const stat = lstatSync(this.#o.folder); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Le magasin planifié doit être un dossier ordinaire sans lien."); }
  }
  #read(strict = false): Trigger[] {
    this.#directory(); if (!existsSync(this.path)) return [];
    try {
      const stat = lstatSync(this.path); if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 3_000_000 || stat.nlink !== 1) throw new Error();
      const data = JSON.parse(readFileSync(this.path, "utf8")) as { version?: unknown; triggers?: unknown[] };
      if (data.version !== 1 || !Array.isArray(data.triggers) || data.triggers.length > 500) throw new Error();
      const rows: Trigger[] = [], seen = new Set<string>();
      for (const row of data.triggers) {
        const value = row as Trigger;
        try {
          if (!value || typeof value.id !== "string" || !/^[a-z0-9-]{1,80}$/i.test(value.id) || seen.has(value.id) || typeof value.prompt !== "string" || !value.prompt.trim() || value.prompt.length > 50_000 || typeof value.cron !== "string" || typeof value.recurring !== "boolean" || value.durable !== true || !Number.isFinite(value.nextAt) || !Number.isFinite(value.createdAt) || (value.lastWall !== undefined && !/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value.lastWall))) throw new Error();
          if (value.permanent !== undefined && typeof value.permanent !== "boolean") throw new Error();
          validateCron(value.cron); seen.add(value.id); rows.push({ id: value.id, cron: value.cron, prompt: value.prompt, recurring: value.recurring, durable: true, createdAt: value.createdAt, nextAt: value.nextAt, ...(value.lastWall ? { lastWall: value.lastWall } : {}), ...(value.permanent === true ? { permanent: true } : {}) });
        } catch { if (strict) throw new Error(); this.#o.warn("Déclencheur invalide ignoré."); }
      }
      return rows;
    } catch { if (strict) throw new Error("Magasin planifié invalide ; aucune modification."); this.#o.warn("Magasin planifié invalide ; aucune exécution."); return []; }
  }
  #mutate(change: (rows: Trigger[]) => Trigger[]): void {
    this.#directory(); mkdirSync(this.#o.folder, { recursive: true, mode: 0o700 });
    const release = tryFileLock(this.path + ".lock"); if (!release) throw new Error("Magasin planifié occupé ; réessayez.");
    try { const rows = change(this.#read(true)), bytes = Buffer.from(JSON.stringify({ version: 1, triggers: rows }) + "\n"); if (bytes.length > 3_000_000) throw new Error("Magasin planifié trop volumineux."); writeAtomic(this.path, bytes, currentPlatform(), true); } finally { release(); }
    this.#o.changed?.();
  }
  list(): Array<Trigger & { nextLocal: string }> { return [...this.#read(), ...this.#session.values()].map(t => ({ ...t, nextLocal: wallMinute(t.nextAt).replace("T", " ") })); }
  create(input: { cron?: string; prompt: string; recurring?: boolean; durable?: boolean; intervalSeconds?: number }): Trigger {
    if (this.#closed) throw new Error("Session terminée.");
    if (!input.prompt.trim() || input.prompt.length > 50_000) throw new Error("Consigne vide ou trop longue.");
    const recurring = input.recurring ?? true, durable = input.durable ?? false, createdAt = this.#now();
    const interval = input.intervalSeconds;
    if (interval !== undefined && (!Number.isInteger(interval) || interval < 30 || interval > 86400 || durable || !recurring || input.cron !== undefined)) throw new Error("Intervalle de session : 30 à 86400 secondes, récurrent, sans cron ni stockage durable.");
    if (interval === undefined && typeof input.cron !== "string") throw new Error("Expression cron ou intervalle requis.");
    const trigger: Trigger = { id: randomUUID(), cron: interval === undefined ? input.cron! : `every ${interval}s`, prompt: input.prompt, recurring, durable, createdAt, nextAt: interval === undefined ? this.#next(input.cron!, createdAt, recurring) : createdAt + interval * 1000, ...(interval === undefined ? {} : { intervalMs: interval * 1000 }) };
    if (durable) this.#mutate(rows => { if (rows.length + this.#session.size >= this.#o.maxActive()) throw new Error("Nombre maximal de déclencheurs atteint."); return [...rows, trigger]; });
    else { if (this.list().length >= this.#o.maxActive()) throw new Error("Nombre maximal de déclencheurs atteint."); this.#session.set(trigger.id, trigger); }
    this.#observed.add(trigger.id); this.#activate(); this.#o.changed?.(); return { ...trigger };
  }
  delete(id: string): void {
    if (!this.#session.delete(id)) this.#mutate(rows => { if (!rows.some(t => t.id === id)) throw new Error("Déclencheur inconnu."); return rows.filter(t => t.id !== id); });
    this.#o.changed?.();
  }
  start(): void {
    if (this.#started || this.#closed) return;
    this.#started = true;
    this.#watchStore();
    if (existsSync(this.path) || this.#session.size) this.#activate();
  }
  #watchStore(): void {
    const parent = existsSync(this.#o.folder) ? this.#o.folder : dirname(this.#o.folder);
    try { this.#watch = watch(parent, () => { if (parent !== this.#o.folder && existsSync(this.#o.folder)) { this.#watch?.close(); this.#watchStore(); } if (existsSync(this.path)) this.#activate(); this.#o.changed?.(); }); this.#watch.unref(); } catch { /* interval still rereads existing triggers */ }
  }
  runNow(id: string): void {
    if (this.#o.enabled?.() === false) throw new Error("Planification désactivée.");
    const trigger = this.list().find(t => t.id === id); if (!trigger) throw new Error("Déclencheur inconnu.");
    if (trigger.durable && !this.leader) throw new Error("Session passive : liste en lecture seule.");
    const next = trigger.recurring ? { ...trigger, nextAt: this.#following(trigger, this.#now()) } : undefined;
    if (this.#replace(trigger, next) && !this.#o.submit(trigger)) this.#o.warn("Consigne planifiée non soumise : file pleine.");
  }
  #activate(): void { if (!this.#started || this.#timer || this.#closed) return; this.#timer = setInterval(() => { void this.tick().catch(() => this.#o.warn("Planification indisponible ; nouvelle tentative au prochain passage.")); }, 1000); this.#timer.unref(); void this.tick().catch(() => this.#o.warn("Planification indisponible.")); }
  async tick(): Promise<void> {
    if (this.#busy || this.#closed || this.#o.enabled?.() === false) return; this.#busy = true;
    try {
      const rows = this.#read();
      if (rows.length && !this.#release) { mkdirSync(dirname(this.#o.lock), { recursive: true, mode: 0o700 }); this.#release = tryFileLock(this.#o.lock); if (this.#release) this.#o.warn("Pilotage des consignes planifiées pris par cette session."); }
      const now = this.#now(), ready = [...(this.#release ? rows : []), ...this.#session.values()];
      for (const trigger of ready) {
        if (this.#closed) return;
        const expire = trigger.recurring && !trigger.permanent && now - trigger.createdAt >= this.#o.maxAgeDays() * 86400_000;
        if (expire) { this.delete(trigger.id); this.#o.warn("Déclencheur planifié expiré."); continue; }
        const fresh = !this.#observed.has(trigger.id); this.#observed.add(trigger.id);
        if (trigger.nextAt > now) continue;
        if (fresh) {
          if (trigger.recurring) { this.#replace(trigger, { ...trigger, nextAt: this.#following(trigger, now, trigger.lastWall) }); continue; }
          const answer = await this.#o.missed(trigger);
          if (this.#closed || answer === undefined) { this.#observed.delete(trigger.id); continue; }
          if (!answer) { this.delete(trigger.id); continue; }
        }
        // Claim under the store lock before enqueueing: another leader never replays an accepted occurrence.
        const following = trigger.recurring ? { ...trigger, lastWall: wallMinute(trigger.nextAt), nextAt: this.#following(trigger, now, wallMinute(trigger.nextAt)) } : undefined;
        if (!this.#replace(trigger, following)) continue;
        if (!this.#o.submit({ ...trigger })) this.#o.warn(trigger.intervalMs ? "Consigne périodique : échéance sautée, session occupée ou file pleine." : "Consigne planifiée non soumise : file pleine ; échéance sautée.");
      }
    } finally { this.#busy = false; }
  }
  #replace(old: Trigger, next?: Trigger): boolean {
    let claimed = false;
    if (old.durable) this.#mutate(rows => rows.flatMap(row => { if (row.id !== old.id || row.nextAt !== old.nextAt) return [row]; claimed = true; return next ? [next] : []; }));
    else if (this.#session.get(old.id)?.nextAt === old.nextAt) { claimed = true; if (next) this.#session.set(old.id, next); else this.#session.delete(old.id); }
    this.#o.changed?.(); return claimed;
  }
  close(): void { this.#closed = true; clearInterval(this.#timer); this.#watch?.close(); this.#release?.(); this.#release = undefined; this.#session.clear(); }
}
