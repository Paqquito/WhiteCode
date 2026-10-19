// Implements: SPEC-MOD-020 (remote session lifecycle, no persisted provider credential).
import { lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { RunDependencies } from "../headless/run";
import { ModelCatalog, type ModelEntry } from "../providers/catalog";
import { startDirectServer, type DirectSession } from "../direct/server";
import { sshRelayProvider } from "./relay";

export interface SshWorkerSetup { readonly token: string; readonly model: ModelEntry; readonly currency: string; readonly directory?: string }
export async function runSshWorker(folder: string, deps: RunDependencies, runSession: (session: DirectSession, setup: SshWorkerSetup, environment: Record<string, string>, catalog: ModelCatalog) => Promise<number>): Promise<number> {
  if (deps.system.platform !== "linux") throw new Error("Le travailleur SSH exige Linux.");
  const path = resolve(folder), stat = lstatSync(path);
  if (dirname(path) !== "/tmp" || !/^session-[a-f0-9-]{36}$/.test(basename(path)) || !stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path || (stat.mode & 0o077) !== 0 || readdirSync(path).some(name => name !== "auth.sock") || !lstatSync(join(path, "auth.sock")).isSocket()) throw new Error("Dossier de session SSH non privé.");
  const lifetime = new AbortController(); const stop = () => lifetime.abort(); deps.signal?.addEventListener("abort", stop, { once: true });
  if (deps.signal?.aborted) lifetime.abort();
  const input = deps.streams.stdinLines()[Symbol.asyncIterator]();
  const timer = setTimeout(stop, 30000);
  let server: ReturnType<typeof startDirectServer> | undefined;
  try {
    lifetime.signal.throwIfAborted();
    const first = await Promise.race([input.next(), new Promise<never>((_, reject) => lifetime.signal.addEventListener("abort", () => reject(new Error("Initialisation SSH interrompue.")), { once: true }))]);
    clearTimeout(timer); if (first.done || first.value.length > 32768) throw new Error("Initialisation SSH invalide.");
    const setup = JSON.parse(first.value) as SshWorkerSetup;
    if (!/^[A-Za-z0-9_-]{43}$/.test(setup.token) || typeof setup.currency !== "string" || !setup.model || (setup.directory !== undefined && (typeof setup.directory !== "string" || setup.directory.length > 4096 || /[\u0000-\u001f]/.test(setup.directory)))) throw new Error("Initialisation SSH invalide.");
    const catalog = new ModelCatalog({ schemaVersion: 1, currency: setup.currency, models: [setup.model] });
    const prefix = deps.identity.get("ENV_PREFIX"), environment: Record<string, string> = {};
    for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR"]) if (deps.environment[key]) environment[key] = deps.environment[key]!;
    environment[prefix + "CONFIG_HOME"] = join(path, "config");
    environment[prefix + "PROVIDER"] = setup.model.provider;
    environment["OPENAI_API_KEY"] = setup.token; environment["ANTHROPIC_API_KEY"] = setup.token;
    environment["OPENAI_BASE_URL"] = "http://127.0.0.1";
    const signal = deps.signal ? AbortSignal.any([lifetime.signal, deps.signal]) : lifetime.signal;
    const root = realpathSync(setup.directory ? resolve(deps.system.home, setup.directory) : deps.system.home);
    server = startDirectServer({ root, privateFiles: [], listen: { kind: "unix", path: join(path, "control.sock") }, maxSessions: 1, token: setup.token, version: deps.identity.version, maxFrameBytes: 4 * 1024 * 1024, keepAliveMs: 15000, resumeWindowMs: 0, allowedOrigins: [], refusal: () => undefined, notice: () => {}, runSession: session => runSession({ ...session, signal: AbortSignal.any([signal, session.signal]) }, setup, environment, catalog) });
    deps.streams.writeOut(JSON.stringify({ ready: true }) + "\n");
    const watch = (async () => { for (;;) { const line = await input.next(); if (line.done) break; } lifetime.abort(); })();
    await Promise.race([watch, new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener("abort", () => resolve(), { once: true }); })]);
    return 0;
  } finally { clearTimeout(timer); lifetime.abort(); deps.signal?.removeEventListener("abort", stop); await server?.stop(); const current = lstatSync(path); if (current.dev === stat.dev && current.ino === stat.ino && !current.isSymbolicLink()) rmSync(path, { recursive: true, force: true }); }
}
export const workerProvider = (folder: string, token: string) => sshRelayProvider("http://localhost/request", token, join(folder, "auth.sock"));
