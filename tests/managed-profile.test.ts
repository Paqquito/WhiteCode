// Supports: SPEC-CFG-003 (§ 5.1 macOS profile, § 5.3 priority, § 5.7), gap E-125.
import { expect, test } from "bun:test";
import { cli, loadIdentity, trustedPolicyFile, workspace, ROOT } from "./helpers/env";
import { currentPlatform, systemInfo } from "../src/platform/system";
import { ScriptedProvider } from "./helpers/scripted-provider";
import type { ProfilePolicy } from "../src/platform/managed-profile";
import { managedSystemPolicy } from "../src/config/managed-system-policy";
import { ManagedPolicyGuard } from "../src/config/managed-policy";
import { loadConfiguration } from "../src/config/load";
import { SettingsReloader } from "../src/config/reload";
import { EnvironmentView } from "../src/config/environment";
import { Host } from "./helpers/control";
import { interactive, KEY } from "./helpers/interactive";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { POSIX, productEnv, record } from "./helpers/hooks";
import { Identity } from "../src/identity/identity";
import { resolveIdentity } from "../src/identity/resolver";

const macos = { ...systemInfo(), platform: "macos" as const };

test("TECH — forced macOS profile preferences override the managed file and stay locked", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  const extra = { system: macos, profilePolicyReader: () => ({ text: JSON.stringify({ ui: { history: { maxEntries: 456 } } }) }) };
  const result = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("456");
  expect(result.stdout).toContain("lecture seule");
  const refused = await cli(["--non-interactive", "/preferences ui.history.maxEntries 789"], ws, { extra });
  expect(refused.stdout + refused.stderr).toContain("lecture seule");
});

test("TECH — an unreadable or malformed forced macOS profile blocks composition before the model", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([]);
  const hook = record(ws, "profile");
  let factories = 0;
  for (const source of [{ error: "unavailable" }, { text: "{" }, { text: JSON.stringify({ permissions: { denyRules: ["unknown_tool"] } }) }]) {
    const options = { provider, extra: { system: macos, profilePolicyReader: () => source, providerFactory: () => { factories++; return provider; } }, env: productEnv(ws), userConfig: { hooks: { prompt_submitted: [{ actions: [{ type: "command", command: hook.command }] }] } } };
    for (const argv of [["--non-interactive", "Read the summary."], ["--control-channel"], [], ["connector-server", "start"], ["extension", "list"]]) {
      const result = await cli(argv, ws, { ...options, tty: argv.length === 0 });
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("Policy");
    }
    expect((await cli(["--help"], ws, options)).code).toBe(0);
    const diagnostic = await cli(["--non-interactive", "/diagnose"], ws, options);
    expect(diagnostic.stdout).toContain("Périmètre du profil macOS");
    expect((await cli(["diagnostic", "validate", "--json"], ws, options)).code).toBe(4);
    const validation = await cli(["config", "validate", "--json"], ws, options);
    expect(validation.code).toBe(2);
    expect(validation.stdout).toContain(loadIdentity().get("MANAGED_POLICY_DOMAIN"));
  }
  expect(provider.requests).toHaveLength(0);
  expect(factories).toBe(0);
  expect(hook.read()).toHaveLength(0);
});

test("TECH — macOS mandatory denial survives CLI overrides and invalid optional preferences stay visible", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ permissions: { allowRules: ["run_shell"] } }));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: "echo private > marker.txt" } }] }, { text: "done" }]);
  const extra = { system: macos, profilePolicyReader: () => ({ text: JSON.stringify({ permissions: { denyRules: ["run_shell(echo *)"], detachedWaitTimeout: "invalid" } }) }) };
  const result = await cli(["--non-interactive", "--allow-rule", "run_shell", "Print the private marker."], ws, { extra, provider, env: productEnv(ws), userConfig: { tools: { shell: { default: POSIX?.path } } } });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("permissions.detachedWaitTimeout");
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("run_shell(echo *)");
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("denied");
  expect(existsSync(join(ws.project, "marker.txt"))).toBe(false);
  expect((await cli(["--non-interactive", "/diagnose"], ws, { extra })).stdout).toContain(`${loadIdentity().get("MANAGED_POLICY_DOMAIN")}/Policy`);
  const validation = await cli(["config", "validate", "--json"], ws, { extra });
  expect(validation.code).toBe(2);
  expect(validation.stdout).toContain("permissions.detachedWaitTimeout");
});

test("TECH — macOS preferences reload in control and terminal before use and removal restores the file", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  let source: ProfilePolicy = { text: JSON.stringify({ ui: { history: { maxEntries: 456 } } }) };
  const extra = { system: macos, profilePolicyReader: () => source };
  const provider = new ScriptedProvider([]);
  const host = new Host(ws, { provider, extra, init: { decisionAuthority: true }, userConfig: { engine: { control: { allowEscalation: true } } }, answers: { confirm_escalation: (params) => ({ decision: "confirm", escalationId: params["escalationId"] }) } });
  try {
    expect(JSON.stringify(await host.request("invoke_command", { command: "/preferences ui.history.maxEntries" }))).toContain("456");
    source = { text: JSON.stringify({ ui: { history: { maxEntries: 654 } } }) };
    expect(JSON.stringify(await host.request("invoke_command", { command: "/preferences ui.history.maxEntries" }))).toContain("654");
    source = {};
    expect(JSON.stringify(await host.request("invoke_command", { command: "/preferences ui.history.maxEntries" }))).toContain("123");
  } finally { host.feed.end(); }
  expect((await host.finish()).code).toBe(0);
  source = { text: JSON.stringify({ ui: { history: { maxEntries: 321 } } }) };
  const terminal = interactive([], ws, { provider, extra });
  try {
    await terminal.idle();
    terminal.type("/preferences ui.history.maxEntries" + KEY.enter);
    await terminal.waitFor((text) => text.includes("321"), "profile value");
    source = { text: JSON.stringify({ ui: { history: { maxEntries: 765 } } }) };
    terminal.type("/preferences ui.history.maxEntries" + KEY.enter);
    await terminal.waitFor((text) => text.includes("765"), "reloaded profile value");
  } finally { terminal.type("/quit" + KEY.enter); }
  expect((await terminal.done).code).toBe(0);
  expect(provider.requests).toHaveLength(0);
});

test("TECH — malformed macOS updates preserve preferences but never permit mandatory actions", () => {
  const ws = workspace();
  const identity = loadIdentity();
  let source: ProfilePolicy = { text: JSON.stringify({ permissions: { denyRules: ["read_file"] }, ui: { history: { maxEntries: 456 } } }) };
  const loaded = loadConfiguration({ identity, cwd: ws.project, system: macos, managedDir: ws.managed, profilePolicyReader: () => source, policyFileProtection: trustedPolicyFile, env: new EnvironmentView(identity.get("ENV_PREFIX"), {}) });
  const warnings: string[] = [];
  const reloader = new SettingsReloader({ files: loaded.sources.filter((s) => s.name !== loaded.systemPolicy?.name), fixed: [], base: { projectTrusted: false }, current: loaded.settings, warn: (message) => warnings.push(message), systemPolicy: loaded.systemPolicy, systemPolicyText: source.text, policyFileProtection: trustedPolicyFile });
  const guard = new ManagedPolicyGuard(join(ws.managed, "policy.json"), undefined, loaded.systemPolicy, trustedPolicyFile);
  source = { text: "{" };
  expect(reloader.check()).toBeUndefined();
  expect(reloader.current.get<number>("ui.history.maxEntries")).toBe(456);
  expect(warnings.join("\n")).toContain("Policy");
  expect(guard.check()).toHaveLength(1);
  source = { text: JSON.stringify({ permissions: { denyRules: ["read_file"] }, ui: { history: { maxEntries: 654 } } }) };
  expect(guard.check()).toHaveLength(1); // A mandatory disappearance/corruption requires a new session.
  expect(new ManagedPolicyGuard(join(ws.managed, "policy.json"), undefined, loaded.systemPolicy, trustedPolicyFile).check()).toHaveLength(0);
  expect(reloader.check()!.settings.get<number>("ui.history.maxEntries")).toBe(654);
  source = {};
  expect(guard.check()).toHaveLength(1);
  source = { text: JSON.stringify({ permissions: { denyRules: ["read_file"] } }) };
  expect(guard.check()).toHaveLength(1);
});

test("TECH — removing forced macOS controls during a model response blocks the next tool", async () => {
  const ws = workspace();
  ws.write("project/public.txt", "PROFILE-READ-SENTINEL");
  let source: ProfilePolicy = { text: JSON.stringify({ permissions: { denyRules: ["read_file(/private.txt)"] } }) };
  const provider = new ScriptedProvider([() => { source = {}; return { toolCalls: [{ name: "read_file", input: { path: join(ws.project, "public.txt") } }] }; }]);
  const result = await cli(["--non-interactive", "Read public.txt."], ws, { provider, extra: { system: macos, profilePolicyReader: () => source } });
  expect(result.code).toBe(4);
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(provider.requests)).not.toContain("PROFILE-READ-SENTINEL");
  expect(result.stderr).toContain("profil macOS");
});

test("TECH — profile removal during host approval refuses the approved write before its effect", async () => {
  const ws = workspace();
  const target = join(ws.project, "pending.txt");
  let source: ProfilePolicy = { text: JSON.stringify({ permissions: { askRules: ["write_file"] } }) };
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "PROFILE-APPROVAL-SENTINEL" } }] }]);
  const host = new Host(ws, { provider, extra: { system: macos, profilePolicyReader: () => source }, init: { decisionAuthority: true }, answers: { approval_request: () => { source = {}; return { decision: "allow" }; } } });
  host.user("Write pending.txt.");
  try {
    const refusal = await host.waitFor((message) => message.type === "error");
    expect(JSON.stringify(refusal)).toContain("profil macOS");
    expect(host.demands("approval_request")).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  } finally { host.feed.end(); }
  expect((await host.finish()).code).toBe(0);
});

test("TECH — profile errors ignore a remote-only file exemption and reader failures cannot become absence", async () => {
  const ws = workspace();
  const text = "{}";
  ws.write("managed/policy.json", text);
  const seed = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
  const identity = new Identity(resolveIdentity({ ...seed, policyAnchor: { organizationId: "profile-test", policySha256: createHash("sha256").update(text).digest("hex"), perimeter: "remote" } }, { version: "0.1.0" }).identity!);
  const provider = new ScriptedProvider([]);
  const result = await cli(["--non-interactive", "Read the summary."], ws, { identity, provider, extra: { system: macos, profilePolicyReader: () => { throw new Error("unavailable"); } } });
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("Périmètre inconnu");
  expect(provider.requests).toHaveLength(0);
  let reads = 0;
  for (const platform of ["windows", "linux", "other"] as const) {
    managedSystemPolicy(identity, { ...systemInfo(), platform }, () => ({}), () => { reads++; return {}; })?.read();
  }
  expect(reads).toBe(0);
});

test.skipIf(currentPlatform() !== "macos")("TECH — native macOS profile reader ignores absent and ordinary user preferences in an isolated domain", () => {
  const child = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/profile-preferences.ts")], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  const report = JSON.parse(child.stdout);
  expect(report.absent).toEqual({});
  expect(report.ordinary).toEqual({});
  expect(report.ordinaryForced).toBe(false);
  expect(report.validation.code).toBe(0);
  expect(report.preferences.code).toBe(0);
  expect(report.preferences.stdout).toContain("123");
  expect(report.invalidDomain.error).toBe("invalid-domain");
  expect(report.requests).toBe(0);
}, 35_000);
