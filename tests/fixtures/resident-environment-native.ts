// Private Linux bench: real HTTPS/WSS and product processes, fictitious account and scripted model only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import identityText from "../../identity/dev.identity.json";
import catalogText from "./test.models.json";
import { Identity } from "../../src/identity/identity";
import { resolveIdentityText } from "../../src/identity/resolver";
import { ModelCatalog } from "../../src/providers/catalog";
import { runCli } from "../../src/headless/run";
import { systemInfo } from "../../src/platform/system";
import { processStreams } from "../../src/platform/io";
import { configuredCompanyAccount } from "../../src/auth/company-runtime";
import { configuredNetwork } from "../../src/config/network";
import { EnvironmentView } from "../../src/config/environment";
import { Settings } from "../../src/config/settings";
import { ScriptedProvider } from "../helpers/scripted-provider";
import type { CredentialVault } from "../../src/platform/credential-vault";

const [mode, directory] = process.argv.slice(2), root = ["bench-service", "bench-init", "bench-race"].includes(mode ?? "") ? directory! : process.env["BENCH_ROOT"]!;
if (!root?.startsWith("/var/tmp/re51-")) throw Error("Private native environment bench required.");
const config = join(root, "home/config"), project = join(root, "project"), home = join(root, "home");
const owner = { account: "member@example.test", organizationId: "org" }, deviceToken = "device_" + "d".repeat(48), environmentToken = "environment_" + "e".repeat(48);
const companyToken = "fixture-company-capability-5137", webToken = "fixture-web-capability-5137";
const log = (name: string, value: unknown) => appendFileSync(join(root, name), JSON.stringify(value) + "\n");
if (mode === "bench-service") {
  let peer: import("bun").ServerWebSocket<{}> | undefined, sequence = 0, registrations = 0, unregistrations = 0;
  const frames: Record<string, unknown>[] = [], commands: Record<string, unknown>[] = [];
  const server = Bun.serve<{}>({ hostname: "127.0.0.1", port: 0, tls: { cert: readFileSync(join(root, "cert.pem")), key: readFileSync(join(root, "key.pem")) },
    async fetch(request, native) {
      const url = new URL(request.url), path = url.pathname, authorization = request.headers.get("authorization");
      if (path === "/token") return Response.json({ token_type: "Bearer", access_token: companyToken, refresh_token: "fixture-refresh-capability-5137", expires_in: 3600 });
      if (path.startsWith("/web/")) {
        if (authorization !== "Web " + webToken) return new Response("Wrong account", { status: 403 });
        if (path === "/web/state") return Response.json({ frames, registrations, unregistrations, connected: !!peer });
        const body = await request.json() as Record<string, unknown>, type = path.slice(5);
        if (!["create", "message", "answer", "stop"].includes(type)) return new Response("Bad action", { status: 400 });
        const frame = { ...body, type, seq: ++sequence, environment: "env-1", ...owner };
        commands.push(frame); peer?.send(JSON.stringify(frame)); return Response.json({ accepted: true, seq: sequence });
      }
      if (path === "/sessions/environments/env-1/channel") {
        if (authorization !== "Environment " + environmentToken || request.headers.get("x-trusted-device") !== deviceToken) return new Response("Device rejected", { status: 403 });
        return native.upgrade(request, { data: {} }) ? undefined : new Response("Upgrade required", { status: 400 });
      }
      if (authorization !== "Bearer " + companyToken) return new Response("Wrong account", { status: 401 });
      if (path === "/api/account/profile") return Response.json({ account: owner.account, organization: { id: "org", name: "Fixture" }, roles: ["member"] });
      if (path === "/sessions/environments/register") {
        const body = await request.json() as Record<string, unknown>;
        if (body["directory"] !== project || body["capacity"] !== 1 || registrations && request.headers.get("x-trusted-device") !== deviceToken) return new Response("Binding refused", { status: 403 });
        if (registrations) { commands.length = 0; sequence = 0; }
        registrations++;
        const service = `https://localhost:${native.port}/sessions/`;
        return Response.json({ id: "env-1", ...owner, eligible: true, trustedDevice: true, url: `https://localhost:${native.port}/environments/env-1`, device: { id: "device-1", token: deviceToken, expiresAt: Date.now() + 3600000, owner, service }, channel: { url: `wss://localhost:${native.port}/sessions/environments/env-1/channel`, token: environmentToken, expiresAt: Date.now() + 3600000 } });
      }
      if (path.startsWith("/sessions/environments/env-1/")) {
        if (request.headers.get("x-trusted-device") !== deviceToken) return new Response("Proof missing", { status: 403 });
        if (path.endsWith("/unregister")) unregistrations++;
        return Response.json({ ok: true });
      }
      return Response.json({ eligible: false });
    },
    websocket: {
      open(socket) { peer = socket; writeFileSync(join(root, "channel-open"), "open"); log("service-events.jsonl", { type: "wss_open" }); },
      message(socket, text) {
        const frame = JSON.parse(String(text)) as Record<string, unknown>; frames.push(frame); if (frames.length > 2000) frames.shift();
        if (frame["type"] === "hello") for (const command of commands) if (Number(command["seq"]) > Number(frame["after"])) socket.send(JSON.stringify(command));
        log("service-frames.jsonl", frame);
      },
      close(socket) { if (peer === socket) peer = undefined; },
    },
  });
  writeFileSync(join(root, "service.json"), JSON.stringify({ port: server.port }));
  process.on("SIGTERM", () => { server.stop(true); process.exit(0); });
  await new Promise(() => {});
} else {
  const port = (JSON.parse(readFileSync(join(root, "service.json"), "utf8")) as { port: number }).port;
  const original = resolveIdentityText(JSON.stringify(identityText), { version: "0.1.0" }).identity!;
  const urls = { SERVICE_REMOTE_SESSIONS: `https://localhost:${port}/sessions/`, SERVICE_WEB_APP: `https://localhost:${port}/`, SERVICE_OAUTH_AUTHORIZE: `https://localhost:${port}/authorize`, SERVICE_OAUTH_TOKEN: `https://localhost:${port}/token`, OAUTH_CLIENT_ID: "native-fixture" };
  const identity = new Identity({ ...original, values: { ...original.values, ...Object.fromEntries(Object.entries(urls).map(([key, value]) => [key, { value, origin: "provided" as const }])) } }), prefix = identity.get("ENV_PREFIX");
  const vaultPath = join(root, "vault.json"), entries = () => existsSync(vaultPath) ? JSON.parse(readFileSync(vaultPath, "utf8")) as Record<string, string> : {};
  let rotated = false;
  const vault: CredentialVault = { read: (service, key) => {
    const current = entries();
    // Rotate only this client's next vault read after the real daemon has opened WSS.
    if (mode === "bench-race" && !rotated && key.startsWith("company-account-") && existsSync(join(root, "channel-open"))) {
      const token = JSON.parse(current[service + ":" + key]!) as Record<string, unknown>, generation = "a".repeat(32);
      token["generation"] = generation; current[service + ":" + key] = JSON.stringify(token);
      writeFileSync(vaultPath, JSON.stringify(current), { mode: 0o600 });
      const profilePath = join(config, "company-profile.json"), profile = JSON.parse(readFileSync(profilePath, "utf8")) as Record<string, unknown>;
      writeFileSync(profilePath, JSON.stringify({ ...profile, generation }), { mode: 0o600 });
      writeFileSync(join(root, "client-rotated-after-open"), "rotated"); rotated = true;
    }
    return current[service + ":" + key];
  }, write: (service, key, value) => { const current = entries(); current[service + ":" + key] = value; writeFileSync(vaultPath, JSON.stringify(current), { mode: 0o600 }); }, remove: (service, key) => { const current = entries(); delete current[service + ":" + key]; writeFileSync(vaultPath, JSON.stringify(current), { mode: 0o600 }); } };
  const environment = { ...process.env, HOME: home, [prefix + "CONFIG_HOME"]: config, [prefix + "EXTRA_CA_CERTS"]: join(root, "cert.pem"), [prefix + "NO_TELEMETRY"]: "1", [prefix + "NO_SURVEYS"]: "1", BENCH_ROOT: root } as Record<string, string>;
  if (mode === "bench-init") {
    for (const path of [config, home, project, join(root, "managed"), join(project, identity.get("PROJECT_DIR"))]) mkdirSync(path, { recursive: true });
    writeFileSync(join(project, "denied.txt"), "DENIED_NATIVE_SENTINEL");
    writeFileSync(join(project, ".env"), "NATIVE_DOTENV_WITNESS=should-not-load\n");
    writeFileSync(join(project, "bunfig.toml"), 'preload = ["../preload.ts"]\n');
    writeFileSync(join(root, "preload.ts"), `await Bun.write(${JSON.stringify(join(root, "preload-ran"))}, "bad");`);
    const settings = { api: { provider: "openai_compatible", baseUrl: "http://127.0.0.1:9/v1" }, models: { identifierMap: { large: "test-large", medium: "test-medium", small: "test-small" } }, permissions: { denyRules: ["read_file(denied.txt)"] }, daemon: { workers: [] }, extensions: { autoUpdate: "off" }, deepLinks: { registration: "disabled" }, integrations: { keepAwake: false }, sessions: { autoTitle: false }, config: { featureFlagsEnabled: false }, notifications: { channel: "disabled" }, ui: { exitConfirmation: false }, memory: { automatic: { enabled: false }, autoExtraction: { enabled: false }, session: { enabled: false } } };
    writeFileSync(join(config, "config.json"), JSON.stringify(settings));
    const account = configuredCompanyAccount(identity, config, () => Settings.load({ sources: [{ scope: "user", name: "fixture", text: JSON.stringify(settings) }], projectTrusted: false }), vault, configuredNetwork(new EnvironmentView(prefix, environment)))!;
    await account.signIn({ confirm: async () => true, authorize: async address => { const url = new URL(address), callback = new URL(url.searchParams.get("redirect_uri")!); callback.searchParams.set("state", url.searchParams.get("state")!); callback.searchParams.set("code", "fixture-code"); return callback.href; } }, AbortSignal.timeout(10000));
    writeFileSync(join(root, "prefix.txt"), prefix);
  } else {
    if (process.env["NATIVE_DOTENV_WITNESS"]) throw Error("Unexpected dotenv autoload.");
    const call = (name: string, input: unknown) => ({ toolCalls: [{ name, input }] });
    const basic = new ScriptedProvider([call("read_file", { path: join(project, "denied.txt") }), call("write_file", { path: join(project, "rejected.txt"), content: "REJECTED" }), call("write_file", { path: join(project, "accepted.txt"), content: "ACCEPTED" }), { text: "REMOTE_NATIVE_DONE" }]);
    const shell = new ScriptedProvider([call("run_shell", { command: `printf started > '${join(root, "tool-started")}'; sleep 8; printf LATE > '${join(project, "late.txt")}'` }), { text: "UNEXPECTED_LATE_COMPLETION" }]);
    const life = new AbortController(); process.on("SIGTERM", () => life.abort());
    const code = await runCli(mode === "bench-race" ? ["remote-access", "start", "--json"] : process.argv.slice(2), { identity, catalog: new ModelCatalog(catalogText), streams: processStreams(), environment, cwd: process.cwd(), system: { ...systemInfo(), home }, managedDir: join(root, "managed"), policyFileProtection: () => ({ writable: false }), credentialVault: vault, onboarding: false, signal: life.signal,
      providerFactory: () => ({ id: "simulated", async *stream(request, signal) { log("model-requests.jsonl", { pid: process.pid, cwd: process.cwd(), history: request.history }); yield* (JSON.stringify(request.history).includes("shell-stop") ? shell : basic).stream(request, signal); } }),
      onEvent: event => log("product-events.jsonl", { pid: process.pid, event }),
    });
    writeFileSync(join(root, `exit-${process.pid}.json`), JSON.stringify({ code })); process.exitCode = code;
  }
}
