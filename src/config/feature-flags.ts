// Implements: SPEC-CFG-014 (CA-01/02/03, EF-01/02/03/04/05, RG-01), gap E-153.
import { lstatSync, readFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { writeAtomic } from "../tools/text-file";
import type { PlatformName } from "../platform/system";
export interface DynamicValues { readonly scheduled_triggers: boolean; readonly schedule_jitter_ms: number; readonly remote_auto_connect?: boolean; readonly survey_probability?: number; readonly survey_share_probability?: number; }
export interface FeatureFlagOptions { url?: string; cache: string; compiled: boolean; remoteCompiled?: boolean; version: string; platform: PlatformName; disabled: boolean; intervalMs: number; fetch: (input: string, init?: RequestInit) => Promise<Response>; overrides?: string; internal: boolean; canRefresh?: () => boolean; }
export class FeatureFlags {
  readonly #o: FeatureFlagOptions;
  #values: DynamicValues; #id = randomUUID(); #lastRefresh?: string; #timer?: ReturnType<typeof setInterval>; #busy = false; #closed = false; #controller?: AbortController;
  constructor(options: FeatureFlagOptions) {
    this.#o = options; this.#values = Object.freeze({ scheduled_triggers: options.compiled, schedule_jitter_ms: 5000, ...(options.remoteCompiled === undefined ? {} : { remote_auto_connect: options.remoteCompiled }) });
    if (this.#configured()) try { const stat = lstatSync(options.cache); if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 20_000) { const data = JSON.parse(readFileSync(options.cache, "utf8")); if (/^[a-f0-9-]{36}$/i.test(data.id)) this.#id = data.id; this.#apply(data.values); if (typeof data.refreshedAt === "string") this.#lastRefresh = data.refreshedAt; } } catch { /* embedded defaults */ }
    if (options.internal && options.overrides) try { this.#apply(JSON.parse(options.overrides)); } catch { /* invalid local override */ }
  }
  #configured(): boolean { try { const url = new URL(this.#o.url ?? ""); return !this.#o.disabled && this.#o.canRefresh?.() !== false && url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { return false; } }
  #apply(input: unknown): void {
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    const row = input as Record<string, unknown>, next = { ...this.#values };
    for (const key of ["survey_probability", "survey_share_probability"] as const) if (typeof row[key] === "number" && Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= 1) next[key] = row[key];
    if (typeof row["remote_auto_connect"] === "boolean" && this.#o.remoteCompiled !== undefined) next.remote_auto_connect = this.#o.remoteCompiled && row["remote_auto_connect"];
    if (typeof row["scheduled_triggers"] === "boolean") next.scheduled_triggers = this.#o.compiled && row["scheduled_triggers"];
    if (typeof row["schedule_jitter_ms"] === "number" && Number.isInteger(row["schedule_jitter_ms"]) && row["schedule_jitter_ms"] >= 0 && row["schedule_jitter_ms"] <= 59_000) next.schedule_jitter_ms = row["schedule_jitter_ms"];
    this.#values = Object.freeze(next);
  }
  snapshot(): DynamicValues { return this.#values; }
  get lastRefresh(): string | undefined { return this.#lastRefresh; }
  start(): void { if (!this.#configured() || this.#timer || this.#closed) return; this.#timer = setInterval(() => { void this.refresh(); }, Math.max(1000, this.#o.intervalMs)); this.#timer.unref(); void this.refresh(); }
  async refresh(): Promise<void> {
    if (!this.#configured() || this.#busy || this.#closed) return; this.#busy = true;
    const controller = new AbortController(); this.#controller = controller; const timeout = setTimeout(() => controller.abort(), 5000); timeout.unref();
    try {
      const response = await this.#o.fetch(this.#o.url!, { method: "POST", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" }, body: JSON.stringify({ version: this.#o.version, platform: this.#o.platform, installation: this.#id }) });
      if (!response.ok || !response.body) return;
      const reader = response.body.getReader(); let size = 0, text = ""; const decoder = new TextDecoder();
      try { for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 20_000) throw new Error(); text += decoder.decode(chunk.value, { stream: true }); } } finally { await reader.cancel().catch(() => {}); }
      if (this.#closed || controller.signal.aborted || !this.#configured()) return;
      const value = JSON.parse(text + decoder.decode()); this.#apply(value.values);
      if (this.#o.internal && this.#o.overrides) try { this.#apply(JSON.parse(this.#o.overrides)); } catch { /* invalid override */ }
      this.#lastRefresh = new Date().toISOString(); mkdirSync(dirname(this.#o.cache), { recursive: true, mode: 0o700 });
      try { const stat = lstatSync(this.#o.cache); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return; }
      writeAtomic(this.#o.cache, Buffer.from(JSON.stringify({ id: this.#id, refreshedAt: this.#lastRefresh, values: this.#values }) + "\n"), this.#o.platform, true);
    } catch { /* offline and invalid values keep the latest valid snapshot */ } finally { clearTimeout(timeout); this.#controller = undefined; this.#busy = false; }
  }
  close(): void { this.#closed = true; clearInterval(this.#timer); this.#controller?.abort(); }
  recheck(): void { if (!this.#configured()) this.#controller?.abort(); }
}
