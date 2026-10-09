// Windows managed channel precedence through the ordinary session and administration paths.
import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { currentPlatform, systemInfo } from "../src/platform/system";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ManagedPolicyGuard } from "../src/config/managed-policy";
import { loadConfiguration } from "../src/config/load";
import { SettingsReloader } from "../src/config/reload";
import { managedRegistry } from "../src/config/managed-registry";
import { loadIdentity } from "./helpers/env";
import { EnvironmentView } from "../src/config/environment";
import type { RegistryPolicy } from "../src/platform/registry";
import { POSIX, record, productEnv } from "./helpers/hooks";
import { resolveIdentity } from "../src/identity/resolver";
import { Identity } from "../src/identity/identity";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { ROOT } from "./helpers/env";

const windows = { ...systemInfo(), platform: "windows" as const };

test("SPEC-CFG-003/CA-02 — Windows registry preferences override the managed file and remain locked", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  const extra = { system: { ...systemInfo(), platform: "windows" as const }, registryPolicyReader: () => ({ text: JSON.stringify({ ui: { history: { maxEntries: 456 } } }) }) };
  const result = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("456");
  expect(result.stdout).toContain("lecture seule");
  const refused = await cli(["--non-interactive", "/preferences ui.history.maxEntries 789"], ws, { extra });
  expect(refused.stdout + refused.stderr).toContain("lecture seule");
  expect((await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra })).stdout).toContain("456");
});

test("TECH — mandatory registry rules survive CLI overrides and optional invalid preferences are reported", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ permissions: { allowRules: ["run_shell"] } }));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: "echo private > marker.txt" } }] }, { text: "done" }]);
  const extra = { system: windows, registryPolicyReader: () => ({ text: JSON.stringify({ permissions: { denyRules: ["run_shell(echo *)"], detachedWaitTimeout: "invalid" }, ui: { history: { maxEntries: 456 } } }) }) };
  const result = await cli(["--non-interactive", "--allow-rule", "run_shell", "Print the private marker."], ws, { extra, provider, env: productEnv(ws), userConfig: { tools: { shell: { default: POSIX?.path } } } });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("permissions.detachedWaitTimeout");
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("denied");
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("run_shell(echo *)");
  expect(existsSync(join(ws.project, "marker.txt"))).toBe(false);
  const diagnostic = await cli(["--non-interactive", "/diagnose"], ws, { extra });
  expect(diagnostic.stdout).toContain("HKLM");
  const validation = await cli(["config", "validate", "--json"], ws, { extra });
  expect(validation.code).toBe(2);
  expect(validation.stdout).toContain("HKLM");
  expect(validation.stdout).toContain("permissions.detachedWaitTimeout");
});

test("TECH — unreadable, malformed and writable mandatory registry policies block every driver before model or hooks", async () => {
  const ws = workspace();
  const hook = record(ws, "registry");
  const provider = new ScriptedProvider([]);
  let factories = 0;
  for (const source of [{ error: "registry-5" }, { text: "{" }, { text: JSON.stringify({ permissions: { denyRules: ["unknown_tool"] } }) }, { text: JSON.stringify({ permissions: { denyRules: ["read_file"] } }), writable: true }]) {
    const extra = { system: windows, registryPolicyReader: () => source, providerFactory: () => { factories++; return provider; } };
    const options = { extra, provider, env: productEnv(ws), userConfig: { hooks: { prompt_submitted: [{ actions: [{ type: "command", command: hook.command }] }] } } };
    for (const argv of [["--non-interactive", "Read the summary."], ["--control-channel"], ["connector-server", "start"], ["extension", "list"]]) {
      const result = await cli(argv, ws, options);
      expect(result.code).toBe(4);
      expect(result.stderr).toContain("HKLM");
    }
    expect((await cli(["--help"], ws, options)).code).toBe(0);
    expect((await cli(["--non-interactive", "/diagnose"], ws, options)).stdout).toContain("HKLM");
    expect((await cli(["config", "validate", "--json"], ws, options)).code).toBe(2);
  }
  expect(factories).toBe(0);
  expect(provider.requests).toHaveLength(0);
  expect(hook.read()).toHaveLength(0);
});

test("TECH — registry preferences reload before use and deletion restores the lower file value", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  const identity = loadIdentity();
  let source: RegistryPolicy = { text: JSON.stringify({ ui: { history: { maxEntries: 456 } } }) };
  const loaded = loadConfiguration({ identity, cwd: ws.project, system: windows, managedDir: ws.managed, registryPolicyReader: () => source, env: new EnvironmentView(identity.get("ENV_PREFIX"), {}) });
  const reloader = new SettingsReloader({ files: loaded.sources.filter((s) => s.name !== loaded.registry?.name), fixed: [], base: { projectTrusted: false }, current: loaded.settings, warn: () => {}, registry: loaded.registry, registryText: source.text });
  expect(reloader.current.get<number>("ui.history.maxEntries")).toBe(456);
  source = { text: JSON.stringify({ ui: { history: { maxEntries: 654 } } }) };
  expect(reloader.check()!.settings.get<number>("ui.history.maxEntries")).toBe(654);
  source = {};
  expect(reloader.check()!.settings.get<number>("ui.history.maxEntries")).toBe(123);
});

test("TECH — writable registry preferences remain usable and every diagnostic exposes the protection warning", async () => {
  const ws = workspace();
  const extra = { system: windows, registryPolicyReader: () => ({ text: JSON.stringify({ ui: { history: { maxEntries: 456 } } }), writable: true }) };
  const provider = new ScriptedProvider([{ text: "done" }]);
  const run = await cli(["--non-interactive", "Read the summary."], ws, { extra, provider });
  expect(run.code).toBe(0);
  expect(run.stderr).toContain("modifiable sans autorité administrateur");
  const admin = await cli(["diagnostic", "validate", "--json"], ws, { extra });
  expect(admin.code).toBe(0);
  expect(admin.stdout).toContain("modifiable sans autorité administrateur");
  const internal = await cli(["--non-interactive", "/diagnose"], ws, { extra });
  expect(internal.code).toBe(0);
  expect(internal.stdout).toContain("modifiable sans autorité administrateur");
  const validation = await cli(["config", "validate", "--json"], ws, { extra });
  expect(validation.code).toBe(0);
  const report = JSON.parse(validation.stdout).files.find((file: { path: string }) => file.path.startsWith("HKLM"));
  expect(report.issues).toContainEqual(expect.objectContaining({ severity: "warning", kind: "policy" }));
});

test("TECH — deleting or changing mandatory registry controls suspends the session while preference changes do not", () => {
  const ws = workspace();
  let source: RegistryPolicy = { text: JSON.stringify({ permissions: { denyRules: ["read_file"] }, ui: { history: { maxEntries: 123 } } }) };
  const registry = managedRegistry(loadIdentity(), windows, () => source)!;
  const guard = new ManagedPolicyGuard(join(ws.managed, "policy.json"), undefined, registry);
  expect(guard.check()).toHaveLength(0);
  source = { text: JSON.stringify({ permissions: { denyRules: ["read_file"] }, ui: { history: { maxEntries: 456 } } }) };
  expect(guard.check()).toHaveLength(0);
  source = {};
  expect(guard.check()).toHaveLength(1);
  source = { text: JSON.stringify({ permissions: { denyRules: ["read_file"] } }) };
  expect(guard.check()).toHaveLength(1);
});

test("TECH — an absent registry leaves file preferences effective and POSIX never invokes the Windows reader", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 123 } } }));
  expect((await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra: { system: windows, registryPolicyReader: () => ({}) } })).stdout).toContain("123");
  for (const platform of ["linux", "macos"] as const) {
    let reads = 0;
    const extra = { system: { ...systemInfo(), platform }, registryPolicyReader: () => { reads++; throw new Error("unexpected registry read"); } };
    expect((await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { extra })).code).toBe(0);
    expect(reads).toBe(0);
  }
});

test("TECH — removing mandatory registry controls during a model response blocks the next tool", async () => {
  const ws = workspace();
  ws.write("project/public.txt", "REGISTRY-READ-SENTINEL");
  let source: RegistryPolicy = { text: JSON.stringify({ permissions: { denyRules: ["read_file(/private.txt)"] } }) };
  const provider = new ScriptedProvider([() => { source = {}; return { toolCalls: [{ name: "read_file", input: { path: join(ws.project, "public.txt") } }] }; }]);
  const result = await cli(["--non-interactive", "Read public.txt."], ws, { provider, extra: { system: windows, registryPolicyReader: () => source } });
  expect(result.code).toBe(4);
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(provider.requests)).not.toContain("REGISTRY-READ-SENTINEL");
  expect(result.stderr).toContain("registre");
});

test("TECH — a remote-only file anchor never exempts an invalid independent Windows registry policy", async () => {
  const ws = workspace();
  const text = "{}";
  ws.write("managed/policy.json", text);
  const seed = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
  const identity = new Identity(resolveIdentity({ ...seed, policyAnchor: { organizationId: "registry-test", policySha256: createHash("sha256").update(text).digest("hex"), perimeter: "remote" } }, { version: "0.1.0" }).identity!);
  const provider = new ScriptedProvider([]);
  const extra = { system: windows, registryPolicyReader: () => ({ text: "{" }) };
  const result = await cli(["--non-interactive", "Read the summary."], ws, { identity, provider, extra });
  expect(result.code).toBe(4);
  expect(provider.requests).toHaveLength(0);
  const diagnosis = await cli(["--non-interactive", "/diagnose"], ws, { identity, provider, extra });
  expect(diagnosis.code).toBe(4);
  expect(diagnosis.stdout).toContain("Périmètre du registre");
});

test.skipIf(currentPlatform() !== "windows")("SPEC-CFG-003/CA-02 — native Windows registry reaches administration, control and terminal using an isolated hive", () => {
  const child = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/registry-session.ts")], { encoding: "utf8", timeout: 30_000, windowsHide: true });
  expect(child.stderr).toBe("");
  expect(child.status).toBe(0);
  const report = JSON.parse(child.stdout);
  expect(report.source.error).toBeUndefined();
  expect(report.source.text).toContain("Résumé — 日本語");
  expect(report.preferences.code).toBe(0);
  expect(report.preferences.stdout).toContain("456");
  expect(report.preferences.stdout).toContain("lecture seule");
  expect(report.validation.code).toBe(0);
  expect(report.validation.stdout).toContain("HKLM");
  expect(JSON.stringify(report.before)).toContain("456");
  expect(JSON.stringify(report.after)).toContain("654");
  expect(report.control.code).toBe(0);
  expect(report.terminalResult.code).toBe(0);
  expect(report.embeddedNull.error).toBe("invalid-value");
  expect(report.tooLarge.error).toBe("invalid-size");
  expect(report.wrongType.code).toBe(4);
  expect(report.requests).toBe(0);
}, 35_000);
