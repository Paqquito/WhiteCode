// Implements: SPEC-MCP-008 (validated helper output, cache, 401 refresh, CA-01, CA-02).
// Supports: gap E-155 (connector-scoped cache and bounded helper output).
import { runCommandHook, type ShellChoice } from "../hooks/command";
import type { PlatformName } from "../platform/system";
import { ConnectionError } from "./stdio-client";
export class ConnectorHeaders {
  #cached?: { headers: Record<string, string>; at: number };
  #loading?: Promise<Record<string, string>>;
  constructor(readonly options: { name: string; url: string; command: string; cwd: string; env: Record<string, string>; shell: ShellChoice; platform: PlatformName; ttlMs: number; timeoutMs: number; now?: () => number }) {}
  async get(signal: AbortSignal, force = false): Promise<Record<string, string>> {
    if (this.#loading) return this.#loading;
    if (!force && this.#cached && (this.options.now?.() ?? Date.now()) - this.#cached.at < this.options.ttlMs) return this.#cached.headers;
    const task = this.#load(signal); this.#loading = task;
    try { return await task; } finally { if (this.#loading === task) this.#loading = undefined; }
  }
  async #load(signal: AbortSignal): Promise<Record<string, string>> {
    const o = this.options;
    const result = await runCommandHook({ type: "command", command: o.command }, JSON.stringify({ name: o.name, url: o.url }), { cwd: o.cwd, env: o.env, shell: o.shell, platform: o.platform, timeoutMs: o.timeoutMs, outputMaxSize: 65536, signal });
    signal.throwIfAborted();
    // Arbitrary header values cannot be identified reliably in stderr. Never publish helper output on failure.
    if (result.timedOut || result.exitCode !== 0) throw new ConnectionError(`Programme d'en-têtes : ${result.timedOut ? "délai dépassé" : `échec (code ${result.exitCode})`}.`);
    let value: unknown; try { value = JSON.parse(result.stdout); } catch { throw new ConnectionError("Programme d'en-têtes : sortie invalide."); }
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 100 || Object.values(value).some(v => typeof v !== "string" || v.length > 8192)) throw new ConnectionError("Programme d'en-têtes : objet JSON de textes attendu.");
    try { new Headers(value as Record<string, string>); } catch { throw new ConnectionError("Programme d'en-têtes : en-têtes invalides."); }
    const headers = value as Record<string, string>; this.#cached = { headers, at: o.now?.() ?? Date.now() }; return headers;
  }
}
