// Distribution policy anchors are independent of session settings and survive missing source files.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Identity } from "../src/identity/identity";
import { resolveIdentity } from "../src/identity/resolver";
import { cli, ROOT, trustedPolicyFile, workspace } from "./helpers/env";
import { productEnv, record, PROJECT_DIR } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { SettingsReloader } from "../src/config/reload";
import { Settings, type ScopeSource } from "../src/config/settings";

const POLICY = JSON.stringify({ permissions: { denyRules: ["read_file(/secret.txt)"] }, ui: { colorMode: "none" } });
const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const seed = () => JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8")) as Record<string, unknown>;
function anchored(text = POLICY): Identity {
  const result = resolveIdentity({ ...seed(), policyAnchor: { organizationId: "organisation-test", policySha256: sha256(text) } }, { version: "0.1.0" });
  expect(result.identity).toBeDefined();
  return new Identity(result.identity!);
}

test("SPEC-CFG-003/CA-14 — missing or replaced anchored policy blocks after every restart; only local help and diagnosis remain", async () => {
  const ws = workspace();
  const identity = anchored();
  const provider = new ScriptedProvider([]);
  const options = { identity, provider, tty: true, env: { [`${identity.get("ENV_PREFIX")}POLICY_ANCHOR`]: "" }, userConfig: { policyAnchor: {}, permissions: { denyRules: [] }, ui: { history: { maxEntries: 123 } } } };
  for (const text of [undefined, "{}", POLICY + "\n", '{"permissions":']) {
    if (text === undefined) { if (existsSync(join(ws.managed, "policy.json"))) unlinkSync(join(ws.managed, "policy.json")); }
    else ws.write("managed/policy.json", text);
    for (const argv of [["--non-interactive", "--config-scopes", "user", "--allow-rule", "read_file", "Read the summary."], ["--non-interactive", "--approval-mode", "unrestricted", "--allow-unrestricted-mode", "Read the summary."], ["--control-channel"], []]) {
      const result = await cli(argv, ws, options);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("organisation-test");
    }
    expect((await cli(["--help"], ws, options)).code).toBe(0);
    const diagnostic = await cli(["--non-interactive", "/diagnose"], ws, options);
    expect(diagnostic.code).toBe(4);
    expect(diagnostic.stdout).toContain("Diagnostic local de politique");
    expect(diagnostic.stdout).toContain("ui.history.maxEntries = 123");
    expect(diagnostic.stdout).not.toContain('ui.colorMode = "none"');
    const validation = await cli(["config", "validate", "--scope", "managed", "--json"], ws, options);
    expect(validation.code).toBe(2);
    expect(validation.stdout).toContain('"kind":"policy"');
  }
  expect(provider.requests).toHaveLength(0);
});

test("SPEC-MOD-010/CA-07 — invalid policy with unknown perimeter blocks project hooks, extension loading and provider construction", async () => {
  const ws = workspace();
  const identity = anchored();
  const hook = record(ws, "anchor-hook");
  ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ hooks: { session_opened: [{ actions: [{ type: "command", command: hook.command }] }] } }));
  ws.write("ext/check/extension.json", JSON.stringify({ name: "check", version: "1.0.0", description: "Checks the session." }));
  ws.write("ext/check/event-hooks.json", JSON.stringify({ hooks: { session_opened: [{ actions: [{ type: "command", command: hook.command }] }] } }));
  ws.write("managed/policy.json", "{}");
  const provider = new ScriptedProvider([]);
  let factories = 0;
  const options = { identity, provider, env: productEnv(ws), extra: { providerFactory: () => { factories++; return provider; } } };
  for (const argv of [["--non-interactive", "--extension-dir", join(ws.root, "ext/check"), "Read the summary."], ["extension", "validate", join(ws.root, "ext/check")], ["connector-server", "start"]]) {
    const result = await cli(argv, ws, options);
    expect(result.code).toBe(4);
    expect(result.stderr).not.toContain("Extension de développement active");
  }
  expect(factories).toBe(0);
  expect(provider.requests).toHaveLength(0);
  expect(hook.read()).toHaveLength(0);
});

test("TECH — the authorised policy remains effective and restoring the exact bytes permits a new session", async () => {
  const ws = workspace();
  const identity = anchored();
  ws.write("project/secret.txt", "PRIVATE-CONTENT");
  const denied = await cli(["--non-interactive", "Read the summary."], ws, { identity, provider: new ScriptedProvider([]) });
  expect(denied.code).toBe(4);
  ws.write("managed/policy.json", POLICY);
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "secret.txt") } }] }, { text: "done" }]);
  const result = await cli(["--non-interactive", "Read secret.txt."], ws, { identity, provider });
  expect(result.code).toBe(0);
  expect(provider.requests).toHaveLength(2);
  const history = JSON.stringify(provider.requests[1]!.history);
  expect(history).toContain("denied");
  expect(history).not.toContain("PRIVATE-CONTENT");
});

test("TECH — an anchor authorises bytes, never malformed mandatory semantics or replacement UTF-8 bytes", async () => {
  const ws = workspace();
  const invalid = '{"permissions":{"denyRules":["read_file("]}}';
  ws.write("managed/policy.json", invalid);
  expect((await cli(["--non-interactive", "Read the summary."], ws, { identity: anchored(invalid), provider: new ScriptedProvider([]) })).code).toBe(4);
  const authorised = '{"note":"\ufffd"}';
  const replacement = Buffer.concat([Buffer.from('{"note":"'), Buffer.from([0xff]), Buffer.from('"}')]);
  expect(replacement.toString("utf8")).toBe(authorised);
  writeFileSync(join(ws.managed, "policy.json"), replacement);
  expect((await cli(["--non-interactive", "Read the summary."], ws, { identity: anchored(authorised), provider: new ScriptedProvider([]) })).code).toBe(4);
});

test("TECH — invalid distribution anchors are fatal and valid anchors participate in the immutable resolved identity", () => {
  for (const policyAnchor of [null, {}, { organizationId: "", policySha256: sha256(POLICY) }, { organizationId: "test", policySha256: "bad" }, { organizationId: "test", policySha256: sha256(POLICY), remote: true }]) {
    expect(resolveIdentity({ ...seed(), policyAnchor }, { version: "0.1.0" }).identity).toBeUndefined();
  }
  const personal = resolveIdentity(seed(), { version: "0.1.0" }).identity!;
  const distribution = anchored();
  expect(distribution.hash).not.toBe(personal.hash);
  expect(JSON.stringify(distribution.resolved)).toContain(sha256(POLICY));
  distribution.applyOverrides({ POLICY_ANCHOR: "" });
  expect(distribution.hash).not.toBe(personal.hash);
  const resolved = resolveIdentity({ ...seed(), policyAnchor: { organizationId: "test", policySha256: sha256(POLICY) } }, { version: "0.1.0" }).identity!;
  const snapshot = new Identity(resolved);
  Object.assign(resolved.policyAnchor!, { policySha256: sha256("{}") });
  expect(snapshot.resolved.policyAnchor!.policySha256).toBe(sha256(POLICY));
  expect(Object.isFrozen(snapshot.resolved)).toBe(true);
  expect(Object.isFrozen(snapshot.resolved.policyAnchor)).toBe(true);
});

test("TECH — reloading rejects unauthorised managed bytes and retains approved rules when another scope changes", () => {
  const ws = workspace();
  const path = ws.write("managed/policy.json", POLICY);
  const user = ws.write("home/config/config.json", "{}");
  const files: ScopeSource[] = [{ scope: "managed", name: path, text: POLICY }, { scope: "user", name: user, text: "{}" }];
  const current = Settings.load({ sources: files, projectTrusted: false });
  const warnings: string[] = [];
  const reloader = new SettingsReloader({ files, fixed: [], base: { projectTrusted: false }, current, warn: (message) => warnings.push(message), policyAnchor: anchored().resolved.policyAnchor, policyFileProtection: trustedPolicyFile });
  ws.write("managed/policy.json", "{}");
  utimesSync(path, new Date(), new Date(Date.now() + 2000));
  expect(reloader.check()).toBeUndefined();
  expect(warnings.join("\n")).toContain("empreinte non autorisée");
  ws.write("home/config/config.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  utimesSync(user, new Date(), new Date(Date.now() + 2000));
  const next = reloader.check()!;
  expect(next.settings.get<string[]>("permissions.denyRules")).toEqual(["read_file(/secret.txt)"]);
  expect(next.settings.get<number>("ui.history.maxEntries")).toBe(123);
});

test("TECH — replacing an anchored policy during a model response blocks the tool, its hooks and further requests", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", POLICY);
  const hook = record(ws, "before-anchor-tool");
  const target = join(ws.project, "created.txt");
  const provider = new ScriptedProvider([() => {
    ws.write("managed/policy.json", "{}");
    return { toolCalls: [{ name: "write_file", input: { path: target, content: "must not be written" } }] };
  }]);
  const result = await cli(["--non-interactive", "--approval-mode", "auto_edit", "Create created.txt."], ws, { identity: anchored(), provider, env: productEnv(ws), userConfig: { hooks: { before_tool: [{ actions: [{ type: "command", command: hook.command }] }] } } });
  expect(result.code).toBe(4);
  expect(existsSync(target)).toBe(false);
  expect(hook.read()).toHaveLength(0);
  expect(provider.requests).toHaveLength(1);
});
