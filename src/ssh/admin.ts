// Implements: SPEC-MOD-020 (CA-01/02: probe, verified deployment and locally authenticated session).
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { orchestratorRefusal, parseSubcommand } from "../cli/families";
import { EnvironmentView } from "../config/environment";
import { PERMISSION_MODES } from "../config/settings-schema";
import { runDirectAdmin } from "../direct/admin";
import type { RunDependencies } from "../headless/run";
import type { ModelProvider } from "../providers/types";
import type { ModelEntry, ResolvedModel } from "../providers/catalog";
import { startSshRelay } from "./relay";
import type { Child } from "../platform/process";
import { deploySsh, openSsh, parseProbe, shellQuote, sshCommand, sshHost } from "./transport";

export interface SshLocalProvider { readonly provider: ModelProvider; readonly model: ResolvedModel; readonly redact: (text: string) => string }
export async function runSshAdmin(argv: readonly string[], deps: RunDependencies, authenticate: (ready: (local: SshLocalProvider) => Promise<number>) => Promise<number>, assertPolicy: () => void): Promise<number> {
  const parsed = parseSubcommand(argv), mode = parsed.options.get("approval-mode"), env = new EnvironmentView(deps.identity.get("ENV_PREFIX"), deps.environment);
  if (parsed.options.has("orchestrator")) throw new Error(orchestratorRefusal("ssh-session", parsed.operation));
  if (parsed.operation !== "connect" || parsed.args.length < 1 || parsed.args.length > 2) throw new Error("Usage : ssh-session connect <hôte> [dossier] [--executable fichier] [--approval-mode mode] [--non-interactive].");
  for (const key of parsed.options.keys()) if (!["executable", "approval-mode", "non-interactive", "verbose"].includes(key)) throw new Error("Option SSH non prise en charge.");
  if (mode !== undefined && !(PERMISSION_MODES as readonly unknown[]).includes(mode)) throw new Error("Mode de permission SSH inconnu.");
  if (env.ownBoolean("OFFLINE_MINIMAL") === true) throw new Error("Session SSH indisponible en mode minimal hors ligne.");
  if (!parsed.options.has("non-interactive") && (!deps.streams.terminal || !deps.streams.stdinIsTTY || !deps.streams.stdoutIsTTY)) throw new Error("La session SSH interactive exige un terminal ; utilisez --non-interactive.");
  const host = sshHost(parsed.args[0]!), directory = parsed.args[1]; if (directory) shellQuote(directory);
  const signal = deps.signal ?? new AbortController().signal, transport = { host, signal, cwd: deps.cwd, env: env.childEnvironment() };
  assertPolicy();
  const probe = parseProbe(await sshCommand(transport, 'printf "%s\\n" "$(uname -s)" "$(uname -m)" "$HOME"'));
  const explicit = parsed.options.get("executable"), filename = `${deps.identity.get("PRODUCT_CLI")}-linux-${probe.arch}`;
  const local = typeof explicit === "string" ? resolve(deps.cwd, explicit) : [join(dirname(deps.installationExecutable ?? process.execPath), filename), join(deps.cwd, "dist", filename)].find(path => existsSync(path));
  if (!local) throw new Error("Livrable Linux absent ; fournissez l’exécutable de cette distribution avec --executable.");
  const cache = `${probe.home}/.cache/${deps.identity.get("PRODUCT_SLUG")}/ssh`, deployed = await deploySsh(transport, local, cache);
  deps.streams.writeErr(`SSH : ${host} · ${deployed.deployed ? "exécutable déployé" : "cache vérifié"} · SHA-256 ${deployed.sha256}\n`);
  return authenticate(async localProvider => {
    assertPolicy();
    const token = randomBytes(32).toString("base64url"), lifetime = new AbortController();
    const relay = await startSshRelay({ ...localProvider, token, allowed: assertPolicy });
    let child: Child | undefined, timeout: ReturnType<typeof setTimeout> | undefined, session: string | undefined, workerReady = false;
    const stop = () => { lifetime.abort(); void child?.killTree(200); };
    signal.addEventListener("abort", stop, { once: true });
    try {
    const reservation = createServer(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening"); const port = (reservation.address() as { port: number }).port; await new Promise<void>(resolve => reservation.close(() => resolve()));
    session = `/tmp/session-${randomUUID()}`;
    await sshCommand(transport, `umask 077; mkdir -m 700 ${shellQuote(session)}`);
    let output = "", resolveReady!: () => void, rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
    signal.throwIfAborted();
    child = openSsh(transport, `exec ${shellQuote(deployed.executable)} __ssh-session-worker ${shellQuote(session)}`, ["-L", `127.0.0.1:${port}:${session}/control.sock`, "-R", `${session}/auth.sock:127.0.0.1:${relay.port}`], chunk => { output += chunk.toString("utf8"); if (output.length > 16384) { rejectReady(new Error("Initialisation SSH trop volumineuse.")); lifetime.abort(); } else if (output.includes('{"ready":true}\n')) resolveReady(); }, () => {});
    timeout = setTimeout(() => rejectReady(new Error("Initialisation SSH hors délai.")), 15000);
    void child.exited.then(() => { rejectReady(new Error("Connexion SSH interrompue ; relancez ssh-session connect pour vous reconnecter.")); lifetime.abort(); });
      const model: ModelEntry = { id: localProvider.model.id, provider: localProvider.model.provider, family: localProvider.model.family, label: localProvider.model.label, contextWindow: localProvider.model.contextWindow, maxOutputTokens: localProvider.model.maxOutputTokens, capabilities: { ...localProvider.model.capabilities, effort: [...localProvider.model.capabilities.effort] }, ...(localProvider.model.pricing ? { pricing: localProvider.model.pricing } : {}) };
      child.input!.write(JSON.stringify({ token, model, currency: localProvider.model.currency, directory }) + "\n");
      await ready; workerReady = true; clearTimeout(timeout); assertPolicy();
      const clientEnv = new EnvironmentView(env.prefix, { ...deps.environment, [env.prefix + "SERVER_TOKEN"]: token });
      const code = await runDirectAdmin(["direct-server", "connect", `ws://127.0.0.1:${port}`, ...(parsed.options.has("non-interactive") ? ["--non-interactive"] : []), ...(typeof mode === "string" ? ["--approval-mode", mode] : [])], { ...deps, env: clientEnv, signal: AbortSignal.any([signal, lifetime.signal]), assertPolicy }, async () => { throw new Error("Unexpected server composition."); }, `SSH : ${host}`);
      if (lifetime.signal.aborted && !signal.aborted) deps.streams.writeErr("Connexion SSH interrompue ; relancez ssh-session connect pour vous reconnecter.\n");
      return code;
    } finally {
      clearTimeout(timeout); signal.removeEventListener("abort", stop); child?.input?.end();
      if (child) { let grace!: ReturnType<typeof setTimeout>; await Promise.race([child.exited, new Promise<void>(resolve => { grace = setTimeout(resolve, 3000); })]); clearTimeout(grace); await child.killTree(300); }
      await relay.close();
      if (session && !workerReady) await sshCommand({ ...transport, signal: AbortSignal.timeout(2000) }, `rmdir ${shellQuote(session)}`).catch(() => {});
    }
  });
}
