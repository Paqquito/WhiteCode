// Managed file authority is checked independently of its JSON and of the distribution digest.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, ROOT, trustedPolicyFile, workspace } from "./helpers/env";
import { productEnv, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { ManagedPolicyGuard, readManagedPolicy } from "../src/config/managed-policy";
import { inspectPolicyFileProtection } from "../src/platform/policy-file";
import { currentPlatform, systemInfo } from "../src/platform/system";
import { Identity } from "../src/identity/identity";
import { resolveIdentity } from "../src/identity/resolver";
import { loadConfiguration } from "../src/config/load";
import { EnvironmentView } from "../src/config/environment";
import { SettingsReloader } from "../src/config/reload";

const POLICY = JSON.stringify({ permissions: { denyRules: ["run_shell"] } });

test("TECH — a writable mandatory file blocks every entry before provider, hooks or extensions", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", POLICY);
  const hook = record(ws, "protection");
  const provider = new ScriptedProvider([]);
  let factories = 0;
  const options = { provider, env: productEnv(ws), userConfig: { hooks: { session_opened: [{ actions: [{ type: "command", command: hook.command }] }] } }, extra: {
    policyFileProtection: () => ({ writable: true }), providerFactory: () => { factories++; return provider; },
  } };
  for (const argv of [["--non-interactive", "Read the summary."], ["--control-channel"], ["--control-listen", "127.0.0.1:0"], ["connector-server", "start"], ["extension", "list"], []]) {
    const result = await cli(argv, ws, { ...options, tty: true });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("modifiable");
  }
  expect((await cli(["--help"], ws, options)).code).toBe(0);
  const diagnostic = await cli(["--non-interactive", "/diagnose"], ws, options);
  expect(diagnostic.code).toBe(4);
  expect(diagnostic.stdout).toContain("Diagnostic local de politique");
  expect(diagnostic.stdout).toContain("modifiable");
  expect((await cli(["config", "validate", "--scope", "managed"], ws, options)).code).toBe(2);
  expect(factories).toBe(0);
  expect(provider.requests).toHaveLength(0);
  expect(hook.read()).toHaveLength(0);
});

test("TECH — writable optional file preferences remain effective with visible warnings on every diagnostic", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 456 } } }));
  const options = { extra: { policyFileProtection: () => ({ writable: true }) } };
  const preferences = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, options);
  expect(preferences.code).toBe(0);
  expect(preferences.stdout).toContain("456");
  expect(preferences.stderr).toContain("modifiable");
  for (const argv of [["--non-interactive", "/diagnose"], ["diagnostic", "validate"], ["config", "validate", "--scope", "managed"]]) {
    const result = await cli(argv, ws, options);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("modifiable");
    expect(result.stdout).toContain("avertissement");
  }
});

test("TECH — protection is rechecked even when policy bytes and timestamps do not change", () => {
  const ws = workspace();
  const file = ws.write("managed/policy.json", POLICY);
  let writable = false;
  const guard = new ManagedPolicyGuard(file, undefined, undefined, () => ({ writable }));
  expect(guard.check()).toHaveLength(0);
  writable = true;
  expect(guard.check().some((issue) => issue.message.includes("modifiable"))).toBe(true);
  writable = false;
  expect(guard.check()).toHaveLength(0);
  expect(file).toBe(join(ws.managed, "policy.json"));
});

test("TECH — unverifiable authority never becomes an absent or optional source", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", "{}");
  const provider = new ScriptedProvider([]);
  for (const policyFileProtection of [() => ({}), () => ({ error: "unavailable" }), () => { throw new Error("inspection failed"); }]) {
    const result = await cli(["--non-interactive", "Read the summary."], ws, { provider, extra: { policyFileProtection } });
    expect(result.code).toBe(4);
    expect((await cli(["config", "validate", "--scope", "managed"], ws, { extra: { policyFileProtection } })).code).toBe(2);
  }
  expect(provider.requests).toHaveLength(0);
});

test("TECH — a writable anchored remote source cannot inject preferences into the preserved local session", async () => {
  const ws = workspace();
  const text = JSON.stringify({ permissions: { denyRules: ["run_shell"] }, ui: { history: { maxEntries: 456 } } });
  ws.write("managed/policy.json", text);
  const seed = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
  const resolved = resolveIdentity({ ...seed, policyAnchor: { organizationId: "protected-test", perimeter: "remote", policySha256: createHash("sha256").update(text).digest("hex") } }, { version: "0.1.0" });
  expect(resolved.identity).toBeDefined();
  const identity = new Identity(resolved.identity!);
  const options = { identity, userConfig: { ui: { history: { maxEntries: 123 } } }, extra: { policyFileProtection: () => ({ writable: true }) } };
  const local = await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, options);
  expect(local.code).toBe(0);
  expect(local.stdout).toContain("123");
  expect(local.stderr).toContain("modifiable");
  expect((await cli(["--control-listen", "127.0.0.1:0"], ws, options)).code).toBe(4);
});

test("TECH — loss of file protection during a response refuses the tool before reading content", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", POLICY);
  ws.write("project/public.txt", "PROTECTED-FILE-SENTINEL");
  let writable = false;
  const provider = new ScriptedProvider([() => { writable = true; return { toolCalls: [{ name: "read_file", input: { path: join(ws.project, "public.txt") } }] }; }]);
  const result = await cli(["--non-interactive", "Read public.txt."], ws, { provider, extra: { policyFileProtection: () => ({ writable }) } });
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("modifiable");
  expect(provider.requests).toHaveLength(1);
  expect(JSON.stringify(provider.requests)).not.toContain("PROTECTED-FILE-SENTINEL");
});

test("TECH — reload checks protection without a timestamp change and keeps the authorised configuration", () => {
  const ws = workspace();
  ws.write("managed/policy.json", POLICY);
  let writable = false;
  const policyFileProtection = () => ({ writable });
  const identity = loadIdentity();
  const loaded = loadConfiguration({ identity, cwd: ws.project, system: systemInfo(), managedDir: ws.managed, policyFileProtection, env: new EnvironmentView(identity.get("ENV_PREFIX"), {}) });
  const warnings: string[] = [];
  const reloader = new SettingsReloader({ files: loaded.sources.filter((s) => s.name !== loaded.registry?.name), fixed: [], base: { projectTrusted: false }, current: loaded.settings, warn: (message) => warnings.push(message), policyFileProtection });
  writable = true;
  expect(reloader.check()).toBeUndefined();
  expect(warnings.join("\n")).toContain("modifiable");
  expect(reloader.current.get<string[]>("permissions.denyRules")).toEqual(["run_shell"]);
});

test("TECH — native protection recognises a protected system file and user-controlled readonly sources", () => {
  if (currentPlatform() === "windows") {
    const child = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/policy-file-windows.ts")], { encoding: "utf8", timeout: 10_000, windowsHide: true });
    expect(child.stderr).toBe("");
    expect(child.status).toBe(0);
    const report = JSON.parse(child.stdout);
    expect(report.ordinary).toEqual({ writable: true });
    expect(report.readonly).toEqual({ writable: true });
    expect(report.protectedFile).toEqual({ writable: false });
    expect(report.mandatory.code).toBe(4);
    expect(report.mandatory.stderr).toContain("modifiable");
    expect(report.validation.code).toBe(2);
    return;
  }
  const ws = workspace();
  const file = ws.write("managed/policy.json", POLICY);
  const systemFile = realpathSync.native("/etc/hosts");
  expect(inspectPolicyFileProtection(systemFile)).toEqual({ writable: false });
  chmodSync(file, 0o444);
  try {
    const protection = inspectPolicyFileProtection(file);
    expect(protection.error).toBeUndefined();
    expect(protection.writable).toBe(process.geteuid?.() !== 0);
  } finally { chmodSync(file, 0o644); }
  chmodSync(file, 0o444);
  chmodSync(ws.managed, 0o777);
  try {
    expect(inspectPolicyFileProtection(file)).toEqual({ writable: true });
    expect(readManagedPolicy(file).issues.some((issue) => issue.severity === "error")).toBe(true);
    chmodSync(file, 0o666);
    ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 456 } } }));
    const preferences = readManagedPolicy(file);
    expect(preferences.required).toBe(false);
    expect(preferences.settingsText).toContain("456");
    expect(preferences.issues.some((issue) => issue.severity === "warning")).toBe(true);
  } finally { chmodSync(file, 0o644); chmodSync(ws.managed, 0o755); }
});

test("TECH — native protection refuses linked ancestors while the bounded reader refuses linked files", () => {
  const ws = workspace();
  const file = ws.write("managed/policy.json", POLICY);
  const link = join(ws.root, "linked-managed");
  symlinkSync(ws.managed, link, "junction");
  expect(inspectPolicyFileProtection(join(link, "policy.json")).error).toBe("unsafe-path");
  const directory = readManagedPolicy(ws.managed, undefined, undefined, trustedPolicyFile);
  expect(directory.required).toBe(true);
  expect(directory.issues[0]!.message).toContain("fichier ordinaire");
  if (currentPlatform() !== "windows") {
    const linkedFile = join(ws.root, "linked-policy.json");
    symlinkSync(file, linkedFile);
    expect(readManagedPolicy(linkedFile, undefined, undefined, trustedPolicyFile).issues[0]!.message).toContain("sans lien symbolique");
  }
});

test("TECH — oversized policy bytes and replacement during inspection are rejected before parsing", () => {
  const ws = workspace();
  const file = ws.write("managed/policy.json", " ".repeat(1024 * 1024 + 1));
  expect(readManagedPolicy(file, undefined, undefined, trustedPolicyFile).issues[0]!.message).toContain("trop volumineuse");
  ws.write("managed/policy.json", POLICY);
  let reads = 0;
  const replacement = () => { if (++reads === 2) ws.write("managed/policy.json", "{}"); return { writable: false }; };
  const result = readManagedPolicy(file, undefined, undefined, replacement);
  expect(reads).toBe(2);
  expect(result.required).toBe(true);
  expect(result.settingsText).toBeUndefined();
  expect(result.issues[0]!.message).toContain("modifiée pendant la lecture");
});

test("TECH — a detected file disappearing during inspection is never a benign absence", () => {
  const ws = workspace();
  const file = ws.write("managed/policy.json", POLICY);
  const result = readManagedPolicy(file, undefined, undefined, () => { unlinkSync(file); return { writable: false }; });
  expect(result.required).toBe(true);
  expect(result.issues.some((issue) => issue.severity === "error")).toBe(true);
});
