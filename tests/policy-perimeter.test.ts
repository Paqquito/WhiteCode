// A distribution's remote-only policy cannot disable independent local work.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Identity } from "../src/identity/identity";
import { resolveIdentity } from "../src/identity/resolver";
import { ManagedPolicyGuard } from "../src/config/managed-policy";
import { decide, type PermissionContext } from "../src/permissions/engine";
import { cli, ROOT, trustedPolicyFile, workspace } from "./helpers/env";
import { PROJECT_DIR, productEnv, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { listeningEngine, RemoteHost } from "./helpers/remote";
import { Host } from "./helpers/control";
import { interactive } from "./helpers/interactive";
import { listenWebSocket } from "../src/platform/websocket";
import { PREFIX, TOKEN } from "./helpers/remote";

const POLICY = JSON.stringify({ permissions: { denyRules: ["read_file(/input.txt)"] }, ui: { colorMode: "none" } });
function identityFor(text = POLICY): Identity {
  const seed = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
  const result = resolveIdentity({ ...seed, policyAnchor: { organizationId: "remote-test", policySha256: createHash("sha256").update(text).digest("hex"), perimeter: "remote" } }, { version: "0.1.0" });
  expect(result.identity).toBeDefined();
  return new Identity(result.identity!);
}
const remoteActions = [["--non-interactive", "--control-listen=127.0.0.1:0"], ["--non-interactive", "--control-connect", "ws://127.0.0.1:9"], ["connector-server", "start", "--transport", "network"], ["--remote-session", "test"], ["--reopen-remote", "test"], ["remote-access", "start"], ["ssh-session", "connect", "test.example"]];

test("SPEC-CFG-003/CA-13 — an invalid remote-only policy preserves local work and refuses every remote entry before provider creation", async () => {
  for (const text of [undefined, "{}", '{"permissions":']) {
    const ws = workspace();
    const identity = identityFor();
    ws.write("project/input.txt", "LOCAL-CONTENT");
    if (text !== undefined) ws.write("managed/policy.json", text);
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "input.txt") } }] }, { text: "done" }]);
    const local = await cli(["--non-interactive", "Read input.txt."], ws, { identity, provider });
    expect(local.code).toBe(0);
    expect(JSON.stringify(provider.requests[1]!.history)).toContain("LOCAL-CONTENT");
    let factories = 0;
    for (const argv of remoteActions) {
      const result = await cli(argv, ws, { identity, extra: { providerFactory: () => { factories++; return new ScriptedProvider([]); } } });
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("distant");
      expect(result.stderr).not.toContain("En écoute");
    }
    const inherited = await cli(["--non-interactive", "--config-scopes", "user", "Read the summary."], ws, { identity, extra: { policyCapability: "remote", providerFactory: () => { factories++; return new ScriptedProvider([]); } } });
    expect(inherited.code).toBe(4);
    expect(factories).toBe(0);
    expect((await cli(["diagnostic", "validate"], ws, { identity })).code).toBe(0);
    expect((await cli(["--non-interactive", "/diagnose"], ws, { identity })).code).toBe(0);
  }
});

test("SPEC-MOD-010/CA-09 — local startup loads trusted project hooks and extensions while remote startup remains blocked", async () => {
  const ws = workspace();
  const identity = identityFor();
  const hook = record(ws, "local-perimeter");
  const declarations = { session_opened: [{ actions: [{ type: "command", command: hook.command }] }] };
  ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ hooks: declarations }));
  ws.write("ext/local/extension.json", JSON.stringify({ name: "local", version: "1.0.0", description: "Checks local startup." }));
  ws.write("ext/local/event-hooks.json", JSON.stringify({ hooks: declarations }));
  ws.write("managed/policy.json", "{}");
  const provider = new ScriptedProvider([{ text: "done" }]);
  const result = await cli(["--non-interactive", "--allow-project-trust", "--extension-dir", join(ws.root, "ext/local"), "Read the summary."], ws, { identity, provider, env: productEnv(ws) });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("Extension de développement active");
  expect(hook.read()).toHaveLength(2);
  expect(provider.requests).toHaveLength(1);
});

test("SPEC-PER-001/CA-30 — a local model tool remains authorised; the remote policy invariant wins over unrestricted mode and hook approval", async () => {
  const ws = workspace();
  const identity = identityFor();
  ws.write("project/input.txt", "LOCAL-CONTENT");
  ws.write("managed/policy.json", "{}");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "input.txt") } }] }, { text: "done" }]);
  expect((await cli(["--non-interactive", "Read input.txt."], ws, { identity, provider })).code).toBe(0);
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("LOCAL-CONTENT");
  const guard = new ManagedPolicyGuard(join(ws.managed, "policy.json"), identity.resolved.policyAnchor, undefined, trustedPolicyFile);
  const ctx: PermissionContext = { mode: "unrestricted", rules: [], sessionAllows: [], managedRulesOnly: false, cwd: ws.project, home: ws.home, platform: "windows", policyRefusal: guard.check("remote").length > 0 ? "Remote policy unavailable." : undefined };
  const decision = decide({ toolName: "read_file", subject: { kind: "paths", access: "read", paths: [join(ws.project, "input.txt")] }, flags: { readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: false, openWorld: false }, available: true, hookDecision: "allow", contribution: "allow" }, ctx);
  expect(decision).toMatchObject({ kind: "deny", step: 1, reason: "Remote policy unavailable." });
  expect((await cli(remoteActions[0]!, ws, { identity })).code).toBe(4);
});

test("TECH — authorised remote-only restrictions and mandatory hooks do not constrain the local perimeter", async () => {
  const ws = workspace();
  const hook = record(ws, "remote-only-control");
  const policy = JSON.stringify({ permissions: { denyRules: ["read_file"] }, hooks: { before_tool: [{ id: "remote-control", mandatory: true, actions: [{ type: "command", command: `${hook.command}; exit 1` }] }] } });
  ws.write("managed/policy.json", policy);
  ws.write("project/input.txt", "LOCAL-CONTENT");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "input.txt") } }] }, { text: "done" }]);
  const result = await cli(["--non-interactive", "Read input.txt."], ws, { identity: identityFor(policy), provider, env: productEnv(ws) });
  expect(result.code).toBe(0);
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("LOCAL-CONTENT");
  expect(hook.read()).toHaveLength(0);
});

test("TECH — an authorised remote session applies its rules; corruption refuses new connections and commands while local work continues", async () => {
  const ws = workspace();
  const identity = identityFor();
  ws.write("managed/policy.json", POLICY);
  ws.write("project/input.txt", "LOCAL-CONTENT");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "input.txt") } }] }, { text: "done" }]);
  const controller = new AbortController();
  const engine = await listeningEngine(ws, provider, { identity, signal: controller.signal });
  const host = new RemoteHost(engine.url);
  try {
    await host.waitFor((frame) => frame.type === "control_init");
    host.init();
    host.send({ type: "user", content: "Read input.txt." });
    await host.waitFor((frame) => frame.type === "turn_completed");
    const history = JSON.stringify(provider.requests[1]!.history);
    expect(history).toContain("denied");
    expect(history).not.toContain("LOCAL-CONTENT");
    ws.write("managed/policy.json", "{}");
    const second = new RemoteHost(engine.url);
    expect(await second.opened).toBe(false);
    const refused = await host.request("invoke_command", { command: "/status" });
    expect(JSON.stringify(refused)).toContain("sessions distantes bloquées");
    const diagnostic = await host.request("invoke_command", { command: "/diagnose" });
    expect(JSON.stringify(diagnostic)).toContain("Périmètre : sessions distantes");
    const localProvider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "input.txt") } }] }, { text: "done" }]);
    expect((await cli(["--non-interactive", "Read input.txt."], ws, { identity, provider: localProvider })).code).toBe(0);
    expect(JSON.stringify(localProvider.requests[1]!.history)).toContain("LOCAL-CONTENT");
  } finally {
    controller.abort();
    host.close();
    await engine.run;
  }
});

test("TECH — invalid remote policy leaves the interactive and standard-input control drivers available", async () => {
  const ws = workspace();
  const identity = identityFor();
  ws.write("managed/policy.json", "{}");
  const host = new Host(ws, { identity, provider: new ScriptedProvider([{ text: "local answer" }]) });
  try {
    host.user("Read the summary.");
    const result = await host.waitFor((message) => message.type === "turn_completed");
    expect(JSON.stringify(result)).toContain("local answer");
  } finally { host.feed.end(); expect((await host.finish()).code).toBe(0); }
  const terminal = interactive([], ws, { identity, provider: new ScriptedProvider([]), env: productEnv(ws) });
  await terminal.waitFor((text) => text.includes("Votre message"));
  terminal.type("/exit\r");
  expect((await terminal.done).code).toBe(0);
});

test("TECH — an authorised but malformed remote rule is a local warning and a remote refusal; unsupported perimeters cannot narrow the guard", async () => {
  const ws = workspace();
  const policy = '{"permissions":{"denyRules":["read_file("]}}';
  const identity = identityFor(policy);
  ws.write("managed/policy.json", policy);
  const local = await cli(["--non-interactive", "Read the summary."], ws, { identity, provider: new ScriptedProvider([{ text: "done" }]) });
  expect(local.code).toBe(0);
  expect(local.stderr).toContain("fonctions locales conservées");
  expect((await cli(remoteActions[0]!, ws, { identity })).code).toBe(4);
  for (const perimeter of [null, false, "local", "all", "REMOTE"]) {
    const seed = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
    expect(resolveIdentity({ ...seed, policyAnchor: { organizationId: "remote-test", policySha256: createHash("sha256").update(POLICY).digest("hex"), perimeter } }, { version: "0.1.0" }).identity).toBeUndefined();
  }
});

test("TECH — policy corruption during an outgoing handshake blocks before provider construction or sending an agent frame", async () => {
  const ws = workspace();
  const identity = identityFor();
  ws.write("managed/policy.json", POLICY);
  let frames = 0;
  let factories = 0;
  const server = listenWebSocket({ hostname: "127.0.0.1", port: 0, maxPayloadLength: 65536,
    authorize: () => { ws.write("managed/policy.json", "{}"); return true; },
    onOpen: () => {}, onMessage: () => { frames++; }, onClose: () => {},
  });
  try {
    const result = await cli(["--non-interactive", "--control-connect", `ws://127.0.0.1:${server.port}`], ws, { identity, env: { [`${PREFIX}CONTROL_TOKEN`]: TOKEN }, extra: { providerFactory: () => { factories++; return new ScriptedProvider([]); } } });
    expect(result.code).toBe(4);
    expect(factories).toBe(0);
    expect(frames).toBe(0);
  } finally { server.stop(); }
});

test("TECH — requiredKeys makes all managed hooks remote controls; corruption during a local response does not interrupt local tools", async () => {
  const ws = workspace();
  const hook = record(ws, "required-remote-control");
  const policy = JSON.stringify({ policy: { requiredKeys: ["hooks"] }, hooks: { before_tool: [{ id: "required-control", actions: [{ type: "command", command: `${hook.command}; exit 1` }] }] } });
  ws.write("managed/policy.json", policy);
  ws.write("project/input.txt", "LOCAL-CONTENT");
  const provider = new ScriptedProvider([() => {
    ws.write("managed/policy.json", "{}");
    return { toolCalls: [{ name: "read_file", input: { path: join(ws.project, "input.txt") } }] };
  }, { text: "done" }]);
  const result = await cli(["--non-interactive", "Read input.txt."], ws, { identity: identityFor(policy), provider, env: productEnv(ws) });
  expect(result.code).toBe(0);
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("LOCAL-CONTENT");
  expect(hook.read()).toHaveLength(0);
});
