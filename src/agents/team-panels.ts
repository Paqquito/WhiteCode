// Supports: SPEC-AGT-012, SPEC-AGT-015 (private tmux panels, leader lease and reconnection).
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { storeExists, encryptedStore } from "../session/private-storage";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { securePrivateDirectory, ownedByCurrentUser } from "../platform/private-file";
import { tryFileLock } from "../platform/file-lock";
import { currentPlatform, findExecutable } from "../platform/system";
import { productProcess } from "../platform/product-process";
import { runToCompletion } from "../platform/process";
import { writeAtomic } from "../tools/text-file";
import { TeamChannel } from "./team-channel";
import type { TeamSnapshot, TeamNotice } from "./teams";
import type { PanelBootstrap, PanelSetup, PanelStatus } from "./team-worker";
import type { TurnResult } from "../engine/events";

interface Panel { readonly name: string; readonly nonce: string; readonly pane: string; readonly policy: string; peer?: string; sequence: number; delivered: number }
interface Saved { readonly version: 1; readonly binding: string; readonly folder: string; readonly token: string; team?: TeamSnapshot; readonly panels: Panel[]; inbox?: Array<{ id: string; notice: TeamNotice }> }
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
export class TeamPanels {
  readonly #state: Saved; readonly #channel: TeamChannel; readonly #release: () => void;
  readonly #handlers = new Map<string, (method: string, value: unknown, signal: AbortSignal) => Promise<unknown>>();
  readonly #attached = new Set<string>();
  readonly #leases = new Map<string, { seen: number; controller: AbortController }>();
  readonly #monitor: ReturnType<typeof setInterval>;
  readonly #mux: string; #closed = false; #announced = false;
  static available(mode: string, env: Readonly<Record<string, string>>): boolean { return currentPlatform() !== "windows" && ["auto", "multiplexer"].includes(mode) && !!env["TMUX"] && /^%\d+$/.test(env["TMUX_PANE"] ?? "") && !!findExecutable("tmux"); }
  constructor(readonly options: { file: string; binding: string; cwd: string; tmp: string; env: Readonly<Record<string, string>>; orphanMs: number; program?: (args: readonly string[]) => { file: string; args: string[] } }) {
    this.#mux = findExecutable("tmux")!;
    if (storeExists(options.file)) {
      if (!encryptedStore(options.file) && !ownedByCurrentUser(options.file)) throw new Error("Saved team belongs to another system user.");
      this.#state = JSON.parse(readPrivateText(options.file, 16 * 1024 * 1024)) as Saved;
      if (this.#state.version !== 1 || this.#state.binding !== options.binding || !/^[a-f0-9]{64}$/.test(this.#state.token) || resolve(this.#state.folder, "..") !== resolve(options.tmp) || !/^team-[a-f0-9]{24}$/.test(this.#state.folder.slice(resolve(options.tmp).length + 1)) || !Array.isArray(this.#state.panels) || this.#state.panels.length > 64 || this.#state.panels.some(panel => !panel || !/^[a-z][a-z0-9-]{0,47}$/.test(panel.name) || !/^%\d+$/.test(panel.pane) || !/^[a-f0-9-]{36}$/.test(panel.nonce) || !Number.isSafeInteger(panel.sequence) || panel.sequence < 0 || !Number.isSafeInteger(panel.delivered) || panel.delivered < 0 || panel.delivered > panel.sequence)) throw new Error("Saved team identity differs from the original leader, project or account.");
      if (new Set(this.#state.panels.map(panel => panel.name)).size !== this.#state.panels.length || this.#state.panels.some(panel => !/^[a-f0-9]{64}$/.test(panel.policy) || panel.peer !== undefined && !/^[a-f0-9-]{36}$/.test(panel.peer)) || this.#state.inbox !== undefined && (!Array.isArray(this.#state.inbox) || this.#state.inbox.length > 32 || this.#state.inbox.some(item => !/^[a-f0-9-]{36}$/.test(item?.id) || !item.notice || !["idle", "message", "stopped", "error"].includes(item.notice.type) || typeof item.notice.from !== "string" || typeof item.notice.text !== "string" || Buffer.byteLength(JSON.stringify(item.notice)) > 256 * 1024))) throw new Error("Invalid saved team members or inbox.");
    } else this.#state = { version: 1, binding: options.binding, folder: join(options.tmp, "team-" + randomBytes(12).toString("hex")), token: randomBytes(32).toString("hex"), panels: [] };
    ordinaryPrivateFile(join(this.#state.folder, "leader.lock"), 0); mkdirSync(this.#state.folder, { recursive: true, mode: 0o700 }); securePrivateDirectory(this.#state.folder);
    const release = tryFileLock(join(this.#state.folder, "leader.lock")); if (!release) throw new Error("This team already has a live leader."); this.#release = release;
    try { this.#save(); } catch (error) { release(); throw error; }
    this.#channel = new TeamChannel(this.#state.folder, options.cwd, "leader", async (from, method, raw, requestSignal) => {
      const envelope = raw as { token: string; name: string; nonce: string; value?: unknown };
      const member = this.#state.panels.find(panel => panel.name === envelope?.name && panel.nonce === envelope.nonce);
      if (!member || envelope.token !== this.#state.token || !this.#channel.peers.list().some(peer => peer.address === from && peer.cwd === options.cwd && peer.name === `${member.nonce}/${member.name}`) || member.peer && member.peer !== from) throw new Error("Foreign team process.");
      if (!member.peer) { member.peer = from; this.#save(); }
      if (method === "heartbeat") { this.#attached.add(member.name); let lease = this.#leases.get(member.name); if (!lease || lease.controller.signal.aborted) { lease = { seen: Date.now(), controller: new AbortController() }; this.#leases.set(member.name, lease); } lease.seen = Date.now(); return true; }
      const lease = this.#leases.get(member.name); if (!lease || lease.controller.signal.aborted || Date.now() - lease.seen > 3000) throw new Error("Teammate heartbeat expired; execution refused.");
      const handle = this.#handlers.get(member.name); if (!handle) throw new Error("Leader has not reattached this teammate; execution refused.");
      return handle(method, envelope.value, AbortSignal.any([requestSignal, lease.controller.signal]));
    });
    this.#monitor = setInterval(() => { try { const live = new Set(this.#channel.peers.list().map(peer => peer.address)); for (const [name, lease] of this.#leases) if (Date.now() - lease.seen > 3000 || !live.has(this.#state.panels.find(panel => panel.name === name)?.peer ?? "")) { lease.controller.abort(); this.#attached.delete(name); } } catch { for (const lease of this.#leases.values()) lease.controller.abort(); this.#attached.clear(); } }, 250); this.#monitor.unref();
  }
  get snapshot() { return this.#state.team; }
  get inboxRoom(): boolean { return (this.#state.inbox?.length ?? 0) < 32; }
  get unread() { return [...(this.#state.inbox ?? [])]; }
  remember(notice: TeamNotice): string { const inbox = this.#state.inbox ??= []; if (inbox.length >= 32 || Buffer.byteLength(JSON.stringify(notice)) > 256 * 1024) throw new Error("Leader team inbox is full."); const id = randomUUID(); inbox.push({ id, notice }); this.#save(); return id; }
  acknowledge(ids: readonly string[]): void { this.#state.inbox = this.#state.inbox?.filter(item => !ids.includes(item.id)); this.#save(); }
  has(name: string): boolean { return this.#state.panels.some(panel => panel.name === name); }
  save(team: TeamSnapshot | undefined): void { if (!team && this.#state.team) { this.#state.panels.length = 0; this.#state.inbox = []; } this.#state.team = team; this.#save(); }
  #save(): void { const bytes = Buffer.from(JSON.stringify(this.#state)); if (bytes.length > 16 * 1024 * 1024) throw new Error("Saved team exceeds its storage limit."); ordinaryPrivateFile(this.options.file, 16 * 1024 * 1024); writeAtomic(this.options.file, bytes, currentPlatform(), true); }
  async ready(): Promise<void> { await this.#channel.ready; if (this.#announced) return; const file = join(this.#state.folder, "leader.json"); ordinaryPrivateFile(file, 4096); if (storeExists(file) && JSON.parse(readPrivateText(file, 4096)).token !== this.#state.token) throw new Error("Team rendezvous ownership changed."); writeAtomic(file, Buffer.from(JSON.stringify({ token: this.#state.token, peer: this.#channel.self() })), currentPlatform(), true); this.#announced = true; }
  async reconnect(snapshot: TeamSnapshot, signal: AbortSignal): Promise<TeamSnapshot> {
    await this.ready(); const deadline = Date.now() + 3000;
    while (snapshot.members.some(member => member.state !== "stopped" && this.has(member.name) && !this.#attached.has(member.name)) && Date.now() < deadline) { signal.throwIfAborted(); await pause(); }
    const members = await Promise.all(snapshot.members.map(async member => {
      if (member.state === "stopped") return member;
      const panel = this.#state.panels.find(panel => panel.name === member.name);
      if (!panel || !this.#attached.has(member.name)) return { ...member, state: "stopped" as const };
      try { const status = await this.#request(panel, "status", undefined, signal) as PanelStatus; if (status.sequence !== panel.sequence) throw new Error("Teammate turn differs."); return { ...member, state: status.state === "active" || status.sequence > panel.delivered ? "active" as const : "idle" as const }; }
      catch { return { ...member, state: "stopped" as const }; }
    }));
    return { active: snapshot.active, members };
  }
  async run(name: string, prompt: string, setup: PanelSetup, policy: string, attach: boolean, signal: AbortSignal, handle: (method: string, value: unknown, signal: AbortSignal) => Promise<unknown>): Promise<TurnResult> {
    await this.ready(); signal.throwIfAborted();
    let member = this.#state.panels.find(panel => panel.name === name);
    if (!member) {
      if (attach) throw new Error("Teammate disappeared; its tasks were released.");
      const nonce = randomUUID(), file = join(this.#state.folder, nonce + ".json");
      const boot: PanelBootstrap = { folder: this.#state.folder, token: this.#state.token, name, nonce, cwd: this.options.cwd, orphanMs: this.options.orphanMs };
      writeAtomic(file, Buffer.from(JSON.stringify(boot)), currentPlatform(), true);
      const program = (this.options.program ?? productProcess)(["__team-worker", file]);
      if (readdirSync(this.#state.folder).some(name => name.startsWith(".env"))) throw new Error("Unexpected environment file in team bootstrap directory.");
      const result = runToCompletion(this.#mux, ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", this.options.env["TMUX_PANE"]!, "-c", this.#state.folder, ["/usr/bin/env", "-i", "TERM=xterm-256color", "LANG=C.UTF-8", program.file, ...program.args].map(quote).join(" ")], { cwd: this.options.cwd, env: this.options.env, timeoutMs: 2000 });
      const pane = result.stdout.trim(); if (result.code !== 0 || !/^%\d+$/.test(pane)) throw new Error("Terminal panel creation failed.");
      member = { name, nonce, pane, policy, sequence: 0, delivered: 0 }; this.#state.panels.push(member); this.#save();
      runToCompletion(this.#mux, ["select-pane", "-t", pane, "-T", name], { cwd: this.options.cwd, env: this.options.env, timeoutMs: 1000 });
    }
    if (member.policy !== policy) throw new Error("Teammate permissions, role or model changed; reconnection refused.");
    this.#handlers.set(name, handle);
    try {
      const deadline = Date.now() + 3000;
      while (!member.peer || !this.#attached.has(name)) { signal.throwIfAborted(); if (Date.now() >= deadline) throw new Error("Teammate did not become operational within three seconds."); await pause(); }
      let state = await this.#request(member, "status", undefined, signal) as PanelStatus;
      if (!attach) {
        if (state.state === "active") throw new Error("Teammate already has an active turn.");
        member.sequence = state.sequence + 1; this.#save();
        await this.#request(member, "turn", { setup, prompt, sequence: member.sequence }, signal);
      } else if (state.sequence !== member.sequence || state.sequence <= member.delivered) throw new Error("Saved teammate turn is no longer pending.");
      do { signal.throwIfAborted(); state = await this.#request(member, "status", undefined, signal) as PanelStatus; if (state.sequence !== member.sequence) throw new Error("Teammate sequence changed."); if (state.state === "idle" && state.result && this.inboxRoom) return state.result; await pause(); } while (!this.#closed);
      throw new Error("Team leader detached.");
    } finally { this.#handlers.delete(name); }
  }
  ack(name: string): void { const member = this.#state.panels.find(panel => panel.name === name); if (member && member.delivered !== member.sequence) { member.delivered = member.sequence; this.#save(); } }
  #request(member: Panel, method: string, value: unknown, signal: AbortSignal) { return this.#channel.request(member.peer!, method, { token: this.#state.token, value }, AbortSignal.any([signal, AbortSignal.timeout(3000)])); }
  async stop(name: string): Promise<void> { const member = this.#state.panels.find(panel => panel.name === name); if (!member) return; try { await this.#request(member, "stop", undefined, AbortSignal.timeout(2000)); } catch { /* Close only the pane recorded by this leader. */ } runToCompletion(this.#mux, ["kill-pane", "-t", member.pane], { cwd: this.options.cwd, env: this.options.env, timeoutMs: 2000 }); }
  async close(): Promise<void> { this.#closed = true; clearInterval(this.#monitor); for (const lease of this.#leases.values()) lease.controller.abort(); await this.#channel.close(); this.#release(); }
}
export const teamBinding = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
