// Supports: SPEC-CFG-003 (CA-03, CA-08, CA-09, authorised offline cache), gaps E-127, E-128.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cli, workspace, loadIdentity, trustedPolicyFile, type Workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { policyCacheSource } from "../src/config/policy-cache";
import { ManagedPolicyGuard } from "../src/config/managed-policy";
import { loadConfiguration } from "../src/config/load";
import { SettingsReloader } from "../src/config/reload";
import { EnvironmentView } from "../src/config/environment";
import { inspectPolicyFileProtection } from "../src/platform/policy-file";
import { currentPlatform, systemInfo } from "../src/platform/system";
import { Host } from "./helpers/control";
import { interactive, KEY } from "./helpers/interactive";
import { productEnv, record } from "./helpers/hooks";

const TIME = Date.parse("2026-10-09T12:00:00.000Z");
const now = () => new Date(TIME);
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const SETTINGS = JSON.stringify({ permissions: { denyRules: ["write_file(/private.txt)"] }, ui: { history: { maxEntries: 777 } } });
function provision(ws: Workspace, options: { settings?: string; cache?: Record<string, unknown>; authorization?: Record<string, unknown> } = {}) {
  const envelope = JSON.stringify({ schemaVersion: 1, organizationId: "offline-test", perimeter: "all", settings: options.settings ?? SETTINGS, ...options.cache });
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  ws.write("home/config/remote-policy-cache.json", envelope);
  const authorization = { schemaVersion: 1, organizationId: "offline-test", perimeter: "all", cacheSha256: digest(envelope), offlineAllowed: true,
    validFrom: "2026-10-09T11:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z", revoked: false, ...options.authorization };
  ws.write("managed/cache-authorization.json", JSON.stringify(authorization));
  return { envelope, authorization, path: join(ws.configHome, "remote-policy-cache.json") };
}

test("TECH — an explicitly authorised offline cache of interface preferences and permission controls takes precedence at startup", async () => {
  const ws = workspace();
  provision(ws);
  const provider = new ScriptedProvider([]);
  const result = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { provider, extra: { now } });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("777");
  expect(result.stdout).toContain("lecture seule");
  expect(result.stderr).toContain("révocation inconnue");
  expect(provider.requests).toHaveLength(0);
});

test("SPEC-CFG-003/CA-09 — an older cache cannot replace the currently authorised version at startup or after a model response", async () => {
  const ws = workspace();
  const older = provision(ws, { settings: JSON.stringify({ ui: { history: { maxEntries: 222 } } }) });
  provision(ws);
  const authorised = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra: { now } });
  expect(authorised.code).toBe(0);
  expect(authorised.stdout).toContain("777");
  ws.write("home/config/remote-policy-cache.json", older.envelope);
  const provider = new ScriptedProvider([]);
  const effects = record(ws, "rollback-effect");
  let factories = 0;
  const options = { provider, env: productEnv(ws), userConfig: { hooks: { session_opened: [{ actions: [{ type: "command", command: effects.command }] }] } },
    extra: { now, providerFactory: () => { factories++; return provider; } } };
  for (const argv of [["--non-interactive", "Read the summary."], ["--control-channel"], ["connector-server", "start"]]) {
    const refused = await cli(argv, ws, options);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain("empreinte non autorisée");
  }
  expect((await interactive([], ws, options).done).code).toBe(4);
  expect(factories).toBe(0);
  expect(effects.read()).toHaveLength(0);
  provision(ws);
  const target = join(ws.project, "created.txt");
  const changing = new ScriptedProvider([() => {
    ws.write("home/config/remote-policy-cache.json", older.envelope);
    return { toolCalls: [{ name: "write_file", input: { path: target, content: "UNAUTHORISED-ROLLBACK" } }] };
  }]);
  const refused = await cli(["--non-interactive", "--approval-mode", "auto_edit", "Create created.txt."], ws, { provider: changing, extra: { now } });
  expect(refused.code).toBe(4);
  expect(changing.requests).toHaveLength(1);
  expect(existsSync(target)).toBe(false);
  // Only a new protected administrative authorisation can permit these exact older bytes.
  ws.write("managed/cache-authorization.json", JSON.stringify(older.authorization));
  const permitted = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra: { now } });
  expect(permitted.code).toBe(0);
  expect(permitted.stdout).toContain("222");
});

test("SPEC-CFG-003/CA-08 — another organisation, expiration or known revocation rejects the cache before agent effects", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([]);
  const hook = record(ws, "rejected-cache");
  let factories = 0;
  for (const options of [{ cache: { organizationId: "other-team" } }, { authorization: { validUntil: "2026-10-09T12:00:00.000Z" } }, { authorization: { revoked: true } }]) {
    provision(ws, options);
    for (const argv of [["--non-interactive", "Read the summary."], [], ["--control-channel"], ["connector-server", "start"], ["extension", "list"]]) {
      const result = await cli(argv, ws, { provider, tty: argv.length === 0, env: productEnv(ws), userConfig: { hooks: { session_opened: [{ actions: [{ type: "command", command: hook.command }] }] } },
        extra: { now, providerFactory: () => { factories++; return provider; } } });
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("cache");
    }
    expect((await cli(["--help"], ws, { provider, extra: { now } })).code).toBe(0);
    expect((await cli(["config", "validate", "--scope", "managed", "--json"], ws, { provider, extra: { now } })).code).toBe(2);
  }
  expect(factories).toBe(0);
  expect(provider.requests).toHaveLength(0);
  expect(hook.read()).toHaveLength(0);
});

test("TECH — offline cached restrictions reach automated, control and interactive drivers without a user override", async () => {
  const ws = workspace();
  provision(ws, { settings: JSON.stringify({ permissions: { denyRules: ["read_file(/private.txt)"] }, ui: { history: { maxEntries: 777 } } }) });
  const target = ws.write("project/private.txt", "CACHED-DENIAL-SENTINEL");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: target } }] }, { text: "done" }]);
  const automated = await cli(["--non-interactive", "--allow-rule", "read_file", "Read private.txt."], ws, { provider, extra: { now } });
  expect(automated.code).toBe(0);
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("denied");
  expect(JSON.stringify(provider.requests)).not.toContain("CACHED-DENIAL-SENTINEL");
  const host = new Host(ws, { provider: new ScriptedProvider([]), extra: { now }, init: { decisionAuthority: true }, userConfig: { engine: { control: { allowEscalation: true } } },
    answers: { confirm_escalation: (params) => ({ decision: "confirm", escalationId: params["escalationId"] }) } });
  try { expect(JSON.stringify(await host.request("invoke_command", { command: "/preferences ui.history.maxEntries" }))).toContain("777"); }
  finally { host.feed.end(); }
  expect((await host.finish()).code).toBe(0);
  const terminal = interactive([], ws, { provider: new ScriptedProvider([]), extra: { now } });
  try { await terminal.idle(); terminal.type("/preferences ui.history.maxEntries" + KEY.enter); await terminal.waitFor((text) => text.includes("777"), "cached managed preference"); }
  finally { terminal.type("/quit" + KEY.enter); }
  expect((await terminal.done).code).toBe(0);
});

test("TECH — offline permission must be explicit; future, invalid or unverifiable validity never enables a cache", async () => {
  const ws = workspace();
  for (const authorization of [{ offlineAllowed: false }, { offlineAllowed: undefined }, { validFrom: "2026-10-09T12:00:00.001Z" },
    { validUntil: "2026-02-30T13:00:00.000Z" }, { validUntil: "2026-10-09T13:00:00+00:00" }, { validUntil: "2026-10-09T11:00:00.000Z" }]) {
    provision(ws, { authorization });
    expect((await cli(["--non-interactive", "Read the summary."], ws, { extra: { now } })).code).toBe(4);
  }
  provision(ws);
  const source = policyCacheSource(join(ws.managed, "policy.json"), ws.configHome, undefined, trustedPolicyFile, () => NaN);
  expect(source.read().issues[0]!.severity).toBe("error");
});

test("TECH — cache integrity, perimeter and ordinary bounded transport are checked independently of user ownership", async () => {
  const ws = workspace();
  const seeded = provision(ws);
  ws.write("home/config/remote-policy-cache.json", seeded.envelope + " ");
  expect((await cli(["--non-interactive", "Read the summary."], ws, { extra: { now } })).code).toBe(4);
  provision(ws, { cache: { perimeter: "remote" } });
  expect((await cli(["--non-interactive", "Read the summary."], ws, { extra: { now } })).code).toBe(4);
  provision(ws, { settings: JSON.stringify({ permissions: { denyRules: ["unknown_tool"] } }) });
  expect((await cli(["--non-interactive", "Read the summary."], ws, { extra: { now } })).code).toBe(4);
  provision(ws);
  unlinkSync(seeded.path);
  expect((await cli(["--non-interactive", "Read the summary."], ws, { extra: { now } })).code).toBe(4);
  const oversized = " ".repeat(1024 * 1024 + 1);
  ws.write("home/config/remote-policy-cache.json", oversized);
  const seededAuthorization = { ...seeded.authorization, cacheSha256: digest(oversized) };
  ws.write("managed/cache-authorization.json", JSON.stringify(seededAuthorization));
  const result = await cli(["--non-interactive", "Read the summary."], ws, { extra: { now } });
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("volumineuse");
});

test("TECH — an orphan cache grants no authority and cannot manufacture an organisation requirement", async () => {
  const ws = workspace();
  provision(ws);
  unlinkSync(join(ws.managed, "cache-authorization.json"));
  const result = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra: { now } });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("123");
  expect(result.stdout).not.toContain("777");
});

test("TECH — malformed, ambiguous or modifiable offline authority blocks without being replaced by project or CLI settings", async () => {
  const ws = workspace();
  const seeded = provision(ws);
  const texts = ["{", "null", JSON.stringify({ ...seeded.authorization, schemaVersion: 2 }), JSON.stringify({ ...seeded.authorization, perimeter: "none" }),
    JSON.stringify(seeded.authorization).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), JSON.stringify({ ...seeded.authorization, extra: true })];
  for (const text of texts) {
    ws.write("managed/cache-authorization.json", text);
    expect((await cli(["--non-interactive", "Read the summary."], ws, { extra: { now } })).code).toBe(4);
  }
  provision(ws);
  for (const proof of [{ writable: true }, { error: "unavailable" }, {}]) {
    const result = await cli(["--non-interactive", "--config-scopes", "user", "Read the summary."], ws, { extra: { now, policyFileProtection: (file) => file.endsWith("cache-authorization.json") ? proof : { writable: false } } });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("cache");
  }
});

test("TECH — cache authority cannot conflict with protected organisation enrolment", async () => {
  const ws = workspace();
  provision(ws);
  const local = JSON.stringify({ ui: { history: { maxEntries: 123 } } });
  ws.write("managed/enrollment.json", JSON.stringify({ schemaVersion: 1, organizationId: "different-organisation", policySha256: digest(local) }));
  const result = await cli(["--non-interactive", "Read the summary."], ws, { extra: { now } });
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("organisation différente");
});

test("TECH — rejected remote-only cache preserves local drivers and refuses remote entries before provider or network", async () => {
  const ws = workspace();
  const seeded = provision(ws, { cache: { perimeter: "remote" }, authorization: { perimeter: "remote" } });
  ws.write("home/config/remote-policy-cache.json", seeded.envelope + " ");
  const local = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra: { now } });
  expect(local.code).toBe(0);
  expect(local.stdout).toContain("123");
  let factories = 0;
  const provider = new ScriptedProvider([]);
  for (const argv of [["--control-listen", "127.0.0.1:0"], ["--control-connect", "http://127.0.0.1:9"], ["connector-server", "start", "--transport", "network"], ["remote-access", "start"]]) {
    expect((await cli(argv, ws, { provider, extra: { now, providerFactory: () => { factories++; return provider; } } })).code).toBe(4);
  }
  expect(factories).toBe(0);
  expect(provider.requests).toHaveLength(0);
  const host = new Host(ws, { provider: new ScriptedProvider([]), extra: { now }, init: { decisionAuthority: true }, userConfig: { engine: { control: { allowEscalation: true } } },
    answers: { confirm_escalation: (params) => ({ decision: "confirm", escalationId: params["escalationId"] }) } });
  try { expect(JSON.stringify(await host.request("invoke_command", { command: "/preferences ui.history.maxEntries" }))).toContain("123"); }
  finally { host.feed.end(); }
  expect((await host.finish()).code).toBe(0);
  expect((await cli(["--non-interactive", "/diagnose"], ws, { extra: { now } })).stdout).toContain("Périmètre du cache : sessions distantes");
});

test("TECH — expiry during a model response blocks its next tool without a file change or stale-cache fallback", async () => {
  const ws = workspace();
  provision(ws);
  const target = ws.write("project/public.txt", "EXPIRED-CACHE-READ-SENTINEL");
  let time = TIME;
  const provider = new ScriptedProvider([() => { time += 3600_000; return { toolCalls: [{ name: "read_file", input: { path: target } }] }; }]);
  const result = await cli(["--non-interactive", "Read public.txt."], ws, { provider, extra: { now: () => new Date(time) } });
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("expirée");
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(provider.requests)).not.toContain("EXPIRED-CACHE-READ-SENTINEL");
});

test("TECH — expiry during approval refuses the pending write and expiry suspends an interactive request", async () => {
  const ws = workspace();
  provision(ws, { settings: JSON.stringify({ permissions: { askRules: ["write_file"] } }) });
  let time = TIME;
  const target = join(ws.project, "pending.txt");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "CACHE-APPROVAL-SENTINEL" } }] }]);
  const host = new Host(ws, { provider, extra: { now: () => new Date(time) }, init: { decisionAuthority: true }, answers: { approval_request: () => { time += 3600_000; return { decision: "allow" }; } } });
  host.user("Write pending.txt.");
  try { expect(JSON.stringify(await host.waitFor((message) => message.type === "error"))).toContain("cache"); expect(existsSync(target)).toBe(false); }
  finally { host.feed.end(); }
  expect((await host.finish()).code).toBe(0);
  time = TIME;
  const terminal = interactive([], ws, { provider: new ScriptedProvider([]), extra: { now: () => new Date(time) } });
  try { await terminal.idle(); time += 3600_000; terminal.type("Read the summary." + KEY.enter); await terminal.waitFor((text) => text.includes("expirée"), "expired offline cache refusal"); }
  finally { terminal.type("/quit" + KEY.enter); }
  expect((await terminal.done).code).toBe(0);
});

test("TECH — cache errors keep prior settings only for diagnosis; recovery cannot resume a suspended session", () => {
  const ws = workspace();
  const seeded = provision(ws);
  const cachePolicy = policyCacheSource(join(ws.managed, "policy.json"), ws.configHome, undefined, trustedPolicyFile, () => TIME);
  const loaded = loadConfiguration({ identity: loadIdentity(), env: new EnvironmentView("PILOTE_DEV", {}), system: { ...systemInfo(), home: ws.home }, cwd: ws.project, managedDir: ws.managed, policyFileProtection: trustedPolicyFile, cachePolicy });
  const warnings: string[] = [];
  const reloader = new SettingsReloader({ files: loaded.sources.filter((source) => source.name !== loaded.systemPolicy?.name && source.name !== cachePolicy.name), fixed: [], base: { projectTrusted: false },
    current: loaded.settings, warn: (text) => warnings.push(text), policyFileProtection: trustedPolicyFile, systemPolicy: loaded.systemPolicy, cachePolicy, cachePolicyText: SETTINGS });
  const guard = new ManagedPolicyGuard(join(ws.managed, "policy.json"), undefined, loaded.systemPolicy, trustedPolicyFile, cachePolicy);
  expect(guard.check()).toHaveLength(0);
  ws.write("home/config/remote-policy-cache.json", seeded.envelope + " ");
  expect(reloader.check()).toBeUndefined();
  expect(reloader.current.get<number>("ui.history.maxEntries")).toBe(777);
  expect(warnings.join("\n")).toContain("empreinte");
  expect(guard.check()).toHaveLength(1);
  ws.write("home/config/remote-policy-cache.json", seeded.envelope);
  expect(guard.check()).toHaveLength(1);
  const restarted = new ManagedPolicyGuard(join(ws.managed, "policy.json"), undefined, loaded.systemPolicy, trustedPolicyFile, cachePolicy);
  expect(restarted.check()).toHaveLength(0);
  unlinkSync(join(ws.managed, "cache-authorization.json"));
  expect(restarted.check()).toHaveLength(1);
});

test("TECH — authority revocation or expiration during a cache read rejects all its settings", () => {
  const ws = workspace();
  const seeded = provision(ws);
  let probes = 0;
  const source = policyCacheSource(join(ws.managed, "policy.json"), ws.configHome, undefined, (file) => {
    if (file.endsWith("cache-authorization.json") && ++probes === 3) ws.write("managed/cache-authorization.json", JSON.stringify({ ...seeded.authorization, revoked: true }));
    return { writable: false };
  }, () => TIME);
  expect(source.read().settingsText).toBeUndefined();
  provision(ws);
  let checks = 0;
  const expiresDuringRead = policyCacheSource(join(ws.managed, "policy.json"), ws.configHome, undefined, trustedPolicyFile, () => ++checks === 1 ? TIME : TIME + 3600_000);
  expect(expiresDuringRead.read().issues[0]!.message).toContain("validité hors ligne perdue");
});

test("TECH — sensitive or unsupported cache contents never execute project, connector or hook code", async () => {
  const ws = workspace();
  const hook = record(ws, "cache");
  const provider = new ScriptedProvider([]);
  const payloads = [{ hooks: { session_opened: [{ actions: [{ type: "command", command: hook.command }] }] } }, { environment: { variables: { CACHE_SENTINEL: "yes" } } },
    { "mcp.allowList": [] }, { "api.baseUrl": "http://127.0.0.1:9" }, { "tools.powershell.path": "untrusted-shell" }];
  for (const payload of payloads) {
    provision(ws, { settings: JSON.stringify(payload) });
    const result = await cli(["--non-interactive", "Read the summary."], ws, { provider, env: productEnv(ws), extra: { now } });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("adoption supplémentaire");
  }
  expect(provider.requests).toHaveLength(0);
  expect(hook.read()).toHaveLength(0);
});

test("TECH — cache diagnostics expose validity and remote precedence over a native profile without revealing policy values", async () => {
  const ws = workspace();
  provision(ws);
  const extra = { now, system: { ...systemInfo(), platform: "macos" as const, home: ws.home }, profilePolicyReader: () => ({ text: JSON.stringify({ ui: { history: { maxEntries: 456 } } }) }) };
  expect((await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra })).stdout).toContain("777");
  const diagnosis = await cli(["--non-interactive", "/diagnose"], ws, { extra });
  expect(diagnosis.code).toBe(0);
  expect(diagnosis.stdout).toContain("Cache de politique");
  expect(diagnosis.stdout).toContain("révocation inconnue");
  const validation = await cli(["config", "validate", "--json"], ws, { extra });
  expect(validation.code).toBe(0);
  expect(validation.stdout).toContain("remote-policy-cache.json");
});

test("TECH — native offline authority rejects a user-owned readonly file before cached policy adoption", async () => {
  if (currentPlatform() === "windows") {
    const child = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/policy-file-windows.ts")], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(child.status).toBe(0);
    const report = JSON.parse(child.stdout);
    expect(report.cache.code).toBe(4);
    expect(report.cache.stderr).toContain("autorisation hors ligne modifiable");
    expect(report.cacheValidation.code).toBe(2);
    return;
  }
  const ws = workspace();
  provision(ws);
  const authorization = join(ws.managed, "cache-authorization.json");
  chmodSync(authorization, 0o444);
  try {
    const source = policyCacheSource(join(ws.managed, "policy.json"), ws.configHome, undefined, inspectPolicyFileProtection, () => TIME);
    expect(source.read().issues.some((issue) => issue.severity === "error")).toBe(process.geteuid?.() !== 0);
    chmodSync(ws.managed, 0o777);
    expect(source.read().issues.some((issue) => issue.severity === "error")).toBe(true);
  } finally { chmodSync(authorization, 0o644); chmodSync(ws.managed, 0o755); }
});
