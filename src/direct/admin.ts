// Implements: SPEC-MOD-018 (CA-01/02, interactive and non-interactive clients), SPEC-MOD-019 (CA-01/02, launch and stop).
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AdminDependencies } from "../admin/subcommands";
import { credentialStore } from "../auth/commands";
import { familyHelp, FAMILY_BY_NAME, parseSubcommand, orchestratorRefusal } from "../cli/families";
import { loadConfiguration } from "../config/load";
import { configuredNetworkSettings } from "../config/network";
import { PERMISSION_MODES } from "../config/settings-schema";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
import { InteractiveApp } from "../interactive/app";
import { authDialog } from "../interactive/auth-dialog";
import type { EngineEvent } from "../engine/events";
import { nativeCredentialVault } from "../platform/credential-vault";
import { detectCapabilities } from "../ui/capabilities";
import type { ApprovalRequest } from "../permissions/resolver";
import { parseDirectAddress, parseDirectListen } from "./address";
import { DirectClient } from "./client";
import { directServerToken, readDirectTokenFile } from "./token";
import { startDirectServer, type DirectSession } from "./server";

export const DIRECT_TOOLS = new Set(["read_file", "write_file", "edit_file", "find_files", "search_content", "update_todo_list"]);
export const DIRECT_SESSION_ARGS = ["--non-interactive", "--control-channel", "--request-format", "jsonl", "--result-format", "jsonl", "--minimal", "--ephemeral", "--no-hooks", "--toolset", [...DIRECT_TOOLS].join(",")];

export async function runDirectAdmin(argv: readonly string[], deps: AdminDependencies, runSession: (session: DirectSession) => Promise<number>): Promise<number> {
  let client: DirectClient | undefined, app: InteractiveApp | undefined;
  try {
    const parsed = parseSubcommand(argv), operation = parsed.operation;
    if (parsed.options.has("help") || !operation) { deps.streams.writeOut(familyHelp(deps.identity.get("PRODUCT_CLI"), FAMILY_BY_NAME.get("direct-server")!)); return 0; }
    if (parsed.options.has("orchestrator")) throw new Error(orchestratorRefusal("direct-server", operation));
    if (!buildFlag("remote_direct_connect")) throw new Error("Connexion directe absente de cette distribution.");
    if (deps.env.ownBoolean("OFFLINE_MINIMAL") === true) throw new Error("Connexion directe indisponible en mode minimal hors ligne.");
    if (!["start", "connect"].includes(operation)) throw new Error("Opération directe attendue : start ou connect.");
    const allowed = new Set(operation === "start" ? ["root", "listen", "credential-file", "verbose"] : ["non-interactive", "approval-mode", "verbose"]);
    for (const name of parsed.options.keys()) if (!allowed.has(name)) throw new Error(`Option directe non prise en charge : --${name}.`);
    // Parse the address before reading any credential, loading provider configuration or opening a connection.
    const address = operation === "connect" ? parseDirectAddress(parsed.args[0] ?? "") : undefined;
    if (parsed.args.length !== (operation === "connect" ? 1 : 0)) throw new Error("Usage : direct-server start [--root dossier] [--listen adresse] ; direct-server connect <adresse> [--non-interactive].");
    deps.assertPolicy?.();
    const configuration = loadConfiguration({ ...deps }), settings = configuration.firstPass;
    const signal = deps.signal ?? new AbortController().signal;
    const store = credentialStore(deps.identity, configuration.locations.configDir, settings, deps.credentialVault ?? nativeCredentialVault({ environment: deps.env.childEnvironment() }), text => deps.streams.writeErr(text + "\n"), () => loadConfiguration({ ...deps }).firstPass, false);
    if (operation === "start") {
      const certFile = deps.env.own("CONTROL_TLS_CERT"), keyFile = deps.env.own("CONTROL_TLS_KEY");
      if (!!certFile !== !!keyFile) throw new Error("Certificat et clé TLS doivent être fournis ensemble.");
      const listen = parseDirectListen(typeof parsed.options.get("listen") === "string" ? parsed.options.get("listen") as string : settings.get<string>("remote.transport.listenAddress"), !!certFile);
      const file = parsed.options.get("credential-file");
      const token = typeof file === "string" ? readDirectTokenFile(resolve(deps.cwd, file)) : await directServerToken({ store, directory: join(configuration.locations.configDir, "direct-server"), signal, assertPolicy: () => deps.assertPolicy?.(), ...(deps.streams.terminal && deps.streams.stdinIsTTY ? { confirmFallback: async () => await authDialog(deps.streams.terminal!, "Stocker le jeton du serveur dans un fichier non chiffré à droits privés ?", false, signal) === true } : {}) });
      signal.throwIfAborted(); deps.assertPolicy?.();
      const server = startDirectServer({ root: resolve(deps.cwd, typeof parsed.options.get("root") === "string" ? parsed.options.get("root") as string : "."), privateFiles: [typeof file === "string" ? resolve(deps.cwd, file) : undefined, keyFile].filter((path): path is string => !!path), listen, token, version: deps.identity.version,
        ...(certFile && keyFile ? { tls: { cert: readFileSync(certFile, "utf8"), key: readFileSync(keyFile, "utf8") } } : {}), maxFrameBytes: settings.get<number>("remote.transport.maxFrameBytes"), keepAliveMs: settings.get<number>("remote.transport.keepAliveSeconds") * 1000, resumeWindowMs: settings.get<number>("remote.transport.resumeWindowSeconds") * 1000, allowedOrigins: settings.get<string[]>("remote.transport.allowedOrigins"), refusal: () => { try { deps.assertPolicy?.(); return undefined; } catch { return "Politique distante invalide."; } }, runSession,
        notice: message => deps.streams.writeErr(message + "\n"),
      });
      deps.streams.writeOut(`Adresse de connexion : ${server.url}\nConnexion : ${deps.identity.get("PRODUCT_CLI")} direct-server connect ${server.url}\n`);
      try { if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true })); }
      finally { await server.stop(); }
      return signal.aborted ? 130 : 0;
    }
    const mode = parsed.options.get("approval-mode");
    if (mode !== undefined && !(PERMISSION_MODES as readonly unknown[]).includes(mode)) throw new Error("Mode de permission inconnu.");
    const nonInteractive = parsed.options.has("non-interactive");
    if (!nonInteractive && (!deps.streams.terminal || !deps.streams.stdinIsTTY || !deps.streams.stdoutIsTTY)) throw new Error("La connexion interactive exige un terminal ; utilisez --non-interactive.");
    const token = deps.env.own("SERVER_TOKEN") ?? await store.get("direct-server");
    if (!token || token.length > 512 || /[\u0000-\u0020\u007f]/.test(token)) throw new Error(`Jeton requis : variable ${deps.env.prefix}SERVER_TOKEN ou magasin d’identifiants.`);
    let model = "", permissionMode = "ask", connection = false;
    let currentTurn: AbortController | undefined;
    const turnSignal = () => currentTurn ? AbortSignal.any([signal, currentTurn.signal]) : signal;
    const answer = async (message: Readonly<Record<string, unknown>>) => {
      if (message["type"] !== "control_request" || message["request"] === "notify") return;
      const params = message["params"] as Record<string, unknown> | undefined;
      let result: Record<string, unknown> = { decision: "deny" };
      if (app && params && message["request"] === "approval_request") {
        const request: ApprovalRequest = { callId: String(params["callId"] ?? ""), toolName: String(params["toolName"] ?? ""), summary: String(params["summary"] ?? ""), reason: String(params["reason"] ?? ""), origin: "default", suggestions: [], ...(typeof params["preview"] === "string" ? { preview: params["preview"] } : {}), ...(typeof params["danger"] === "string" ? { danger: params["danger"] } : {}), ...(params["input"] && typeof params["input"] === "object" ? { input: params["input"] as Record<string, unknown> } : {}) };
        const decision = await app.approvals.request(request, turnSignal());
        if (decision.answer === "no_stop") currentTurn?.abort();
        result = decision.answer === "yes_modified" ? { decision: "allow_modified", input: decision.input } : { decision: ["yes", "yes_always"].includes(decision.answer) ? "allow" : "deny" };
      } else if (app && params && message["request"] === "confirm_escalation") {
        const detail = JSON.stringify({ mode: params["mode"], from: params["from"], rule: params["rule"], command: params["command"] }).slice(0, 2000);
        const approved = await app.confirm(`Le serveur demande une confirmation : ${String(params["kind"] ?? "opération")} ${detail}.`, "confirmer", "refuser", false, turnSignal());
        result = { decision: approved ? "confirm" : "deny", escalationId: params["escalationId"] };
      }
      try { client?.send({ type: "control_response", id: message["id"], ok: true, result }); } catch { app?.notice("warning", "Réponse non envoyée : connexion suspendue."); }
    };
    client = new DirectClient({ address: address!, token, version: deps.identity.version, network: configuredNetworkSettings(deps.env), signal, maxFrameBytes: settings.get<number>("remote.transport.maxFrameBytes"),
      onConnection: value => { connection = value; app?.refresh(); },
      onMessage: message => {
        if (nonInteractive && message["type"] !== "control_request" && message["type"] !== "control_init") deps.streams.writeOut(JSON.stringify(message) + "\n");
        if (message["type"] === "session") { model = String(message["model"] ?? ""); permissionMode = String(message["permissionMode"] ?? "ask"); app?.refresh(); }
        if (message["type"] === "control_response" && message["ok"] === true) {
          const result = message["result"] as Record<string, unknown> | undefined;
          if (typeof result?.["model"] === "string") model = result["model"];
          if (typeof result?.["mode"] === "string") permissionMode = result["mode"];
          if (typeof result?.["permissionMode"] === "string") permissionMode = result["permissionMode"];
          app?.refresh();
        }
        if (app) displayRemoteEvent(app, message);
        void answer(message);
      },
    });
    const metadata = await client.ready;
    if (!nonInteractive) {
      app = new InteractiveApp({ terminal: deps.streams.terminal!, capabilities: detectCapabilities({ colorMode: settings.get<string>("ui.colorMode"), unicodeLevel: settings.get("ui.unicodeLevel"), noColorOption: false, variable: name => deps.env.public(name), platform: deps.system.platform }), settings: {
        maxFramesPerSecond: settings.get("ui.maxFramesPerSecond"), minColumns: settings.get("ui.minColumns"), retainedLines: settings.get("ui.retainedLines"), inputMinHeight: settings.get("ui.inputMinHeight"), inputMaxHeight: settings.get("ui.inputMaxHeight"), inputMaxChars: settings.get("ui.input.maxChars"), inputWarnChars: settings.get("ui.input.warnChars"), queueMax: settings.get("ui.queue.maxMessages"), queueAutoSend: settings.get("ui.queue.autoSend"), draftsMax: settings.get("ui.drafts.maxStashed"), exitConfirmation: settings.get("ui.exitConfirmation"), exitDoublePressMs: settings.get("ui.exitDoublePressWindow"), dialogGuardMs: 350,
      }, status: () => ({ mode: permissionMode, model, remote: `${connection ? "connecté à" : "reconnexion à"} ${address!.kind === "websocket" ? address!.hostname : "socket local"}` }), describeCall: name => name });
      app.start(); app.notice("system", `Dossier du serveur : ${metadata.cwd}`);
    }
    client.initialize();
    if (typeof mode === "string") {
      try { await client.requestResult("set_approval_mode", { mode }, settings.get<number>("engine.control.responseTimeoutMs") + 1000); }
      catch (error) { try { client.request("shutdown"); } catch {} throw error; }
    }
    if (nonInteractive) {
      const input = await deps.streams.readAllStdin();
      if (!input.trim()) throw new Error("Un message est requis sur l’entrée standard.");
      const outcome = await client.turn(input, signal);
      client.request("shutdown"); const code = await client.done;
      return code || (outcome.stopCause === "completed" ? 0 : 1);
    }
    const finished = client.done.then(code => ({ kind: "closed" as const, code }));
    for (;;) {
      const queued = app!.takeQueued();
      const entry = queued !== undefined ? { kind: "message" as const, text: queued } : await Promise.race([app!.nextEntry(), finished]);
      if (entry.kind === "closed") return entry.code;
      if (entry.kind === "exit") { client.request("shutdown"); return await client.done; }
      const turn = new AbortController(); currentTurn = turn; app!.beginTurn(turn);
      try { const outcome = await client.turn(entry.text, AbortSignal.any([signal, turn.signal])); app!.endTurn(outcome); }
      finally { turn.abort(); currentTurn = undefined; }
      if (client.connected) client.request("get_state");
    }
  } catch (error) {
    // Parsing, certificates and authentication never echo the supplied address, token or credential file contents.
    deps.streams.writeErr(`${(error as Error).message}\n`); return deps.signal?.aborted ? 130 : 2;
  } finally { client?.close(); app?.stop(); }
}

function displayRemoteEvent(app: InteractiveApp, value: Readonly<Record<string, unknown>>): void {
  const string = (name: string) => typeof value[name] === "string" ? value[name] as string : "";
  let event: EngineEvent | undefined;
  switch (value["type"]) {
    case "assistant": event = value["partial"] ? { type: "text_delta", text: string("content") } : { type: "assistant_message", text: string("content"), toolCalls: [] }; break;
    case "thinking": event = { type: "thinking_delta", text: string("content") }; break;
    case "tool_call": event = { type: "tool_call", name: string("toolId"), callId: string("callId"), input: value["input"] }; break;
    case "tool_result": event = { type: "tool_result", callId: string("callId"), isError: value["errored"] === true, durationMs: typeof value["elapsedMs"] === "number" ? value["elapsedMs"] : 0, output: string("output") }; break;
    case "user": event = { type: "user_message", content: Array.isArray(value["content"]) ? value["content"].filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && part.type === "text" && typeof part.text === "string") : [] }; break;
    case "error": app.notice("warning", string("message")); break;
    case "command_output": app.notice("info", string("output")); break;
  }
  if (event) app.onEngineEvent(event);
}
