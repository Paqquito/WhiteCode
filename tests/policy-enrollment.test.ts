// Supports: SPEC-CFG-003 (CA-05, CA-06, protected independent enrolment), gap E-126.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, statSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, ROOT, trustedPolicyFile, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { productEnv, record } from "./helpers/hooks";
import { ManagedPolicyGuard } from "../src/config/managed-policy";
import { readPolicyEnrollment } from "../src/config/policy-enrollment";
import { loadConfiguration } from "../src/config/load";
import { SettingsReloader } from "../src/config/reload";
import { EnvironmentView } from "../src/config/environment";
import { Identity } from "../src/identity/identity";
import { resolveIdentity } from "../src/identity/resolver";
import { currentPlatform, systemInfo } from "../src/platform/system";
import { inspectPolicyFileProtection } from "../src/platform/policy-file";
import { spawnSync } from "node:child_process";
import { Host } from "./helpers/control";
import { interactive, KEY } from "./helpers/interactive";

const POLICY = JSON.stringify({ permissions: { denyRules: ["read_file(/private.txt)"] }, ui: { history: { maxEntries: 456 } } });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const enrollment = (text = POLICY) => JSON.stringify({ schemaVersion: 1, organizationId: "enrolment-test", policySha256: hash(text) });

test("SPEC-CFG-003/CA-05 — policy deletion after protected organisation enrolment blocks every restart before agent effects", async () => {
  const ws = workspace();
  ws.write("managed/enrollment.json", enrollment());
  ws.write("managed/policy.json", POLICY);
  expect((await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws)).stdout).toContain("456");
  unlinkSync(join(ws.managed, "policy.json"));
  const hook = record(ws, "enrolment");
  const provider = new ScriptedProvider([]);
  let factories = 0;
  const options = { provider, env: productEnv(ws), extra: { providerFactory: () => { factories++; return provider; } }, userConfig: { permissions: { denyRules: [] }, enrollment: {}, hooks: { prompt_submitted: [{ actions: [{ type: "command", command: hook.command }] }] } } };
  for (const argv of [["--non-interactive", "Read the summary."], [], ["--control-channel"], ["connector-server", "start"], ["extension", "list"]]) {
    const result = await cli(argv, ws, { ...options, tty: argv.length === 0 });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("enrolment-test");
  }
  expect(factories).toBe(0);
  expect(provider.requests).toHaveLength(0);
  expect(hook.read()).toHaveLength(0);
});

test("SPEC-CFG-003/CA-06 — first offline startup without received policy keeps only help, local diagnosis and authorised recovery", async () => {
  const ws = workspace();
  ws.write("managed/enrollment.json", enrollment());
  const provider = new ScriptedProvider([]);
  const options = { provider };
  expect((await cli(["--non-interactive", "Read the summary."], ws, options)).code).toBe(4);
  expect((await cli(["--help"], ws, options)).code).toBe(0);
  const diagnosis = await cli(["--non-interactive", "/diagnose"], ws, options);
  expect(diagnosis.code).toBe(4);
  expect(diagnosis.stdout).toContain("enrollment.json");
  expect((await cli(["config", "validate", "--json"], ws, options)).code).toBe(2);
  ws.write("project/recovery.json", POLICY);
  const recovered = await cli(["config", "recover-policy", "recovery.json", "--json"], ws, options);
  expect(recovered.code).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({ organizationId: "enrolment-test", verified: true, requiresAdministrativeInstall: true });
  expect(existsSync(join(ws.managed, "policy.json"))).toBe(false);
  expect(provider.requests).toHaveLength(0);
  ws.write("managed/policy.json", POLICY); // Installation by the administrator, outside the recovery verifier.
  expect((await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, options)).stdout).toContain("456");
});

test("TECH — a writable, malformed, duplicate, missing-hash or unreadable enrolment cannot become personal mode", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 456 } } }));
  const provider = new ScriptedProvider([]);
  const variants = ["{", "null", "[]", JSON.stringify({ schemaVersion: 1, organizationId: "pending" }), enrollment().replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'), JSON.stringify({ schemaVersion: 1, organizationId: "pending", policySha256: hash(POLICY), bypass: true })];
  for (const text of variants) {
    ws.write("managed/enrollment.json", text);
    expect((await cli(["--non-interactive", "Read the summary."], ws, { provider })).code).toBe(4);
    expect((await cli(["config", "validate", "--json"], ws, { provider })).code).toBe(2);
  }
  ws.write("managed/enrollment.json", enrollment());
  for (const proof of [{ writable: true }, { error: "unavailable" }, {}]) {
    const policyFileProtection = (path: string) => path.endsWith("enrollment.json") ? proof : { writable: false };
    const result = await cli(["--non-interactive", "Read the summary."], ws, { provider, extra: { policyFileProtection } });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("Inscription d'organisation invalide");
  }
  expect(provider.requests).toHaveLength(0);
});

test("TECH — enrolment changes and deletion suspend even a preference-only policy without timestamp changes", () => {
  const ws = workspace();
  const text = JSON.stringify({ ui: { history: { maxEntries: 456 } } });
  ws.write("managed/policy.json", text);
  const manifest = ws.write("managed/enrollment.json", enrollment(text));
  const file = join(ws.managed, "policy.json");
  const guard = new ManagedPolicyGuard(file, undefined, undefined, trustedPolicyFile);
  expect(guard.check()).toHaveLength(0);
  ws.write("managed/enrollment.json", JSON.stringify(JSON.parse(enrollment(text)), null, 2));
  expect(guard.check()).toHaveLength(0); // Formatting does not change the administrative authority.
  const before = statSync(manifest);
  ws.write("managed/enrollment.json", enrollment(text).replace("enrolment-test", "another-teamx"));
  utimesSync(manifest, before.atime, before.mtime);
  expect(guard.check()).toHaveLength(1);
  ws.write("managed/enrollment.json", enrollment(text));
  expect(guard.check()).toHaveLength(1);
  const restarted = new ManagedPolicyGuard(file, undefined, undefined, trustedPolicyFile);
  unlinkSync(manifest);
  expect(restarted.check()).toHaveLength(1);
});

test("TECH — recovered bytes require independent authority, exact integrity and mandatory semantic validity", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([]);
  ws.write("project/recovery.json", POLICY);
  expect((await cli(["config", "recover-policy", "recovery.json"], ws, { provider })).code).toBe(4);
  ws.write("managed/enrollment.json", enrollment());
  ws.write("project/recovery.json", POLICY + " ");
  expect((await cli(["config", "recover-policy", "recovery.json"], ws, { provider })).code).toBe(4);
  const malformed = JSON.stringify({ permissions: { denyRules: ["unknown_tool"] } });
  ws.write("managed/enrollment.json", enrollment(malformed));
  ws.write("project/recovery.json", malformed);
  expect((await cli(["config", "recover-policy", "recovery.json"], ws, { provider })).code).toBe(4);
  expect((await cli(["config", "recover-policy"], ws, { provider })).code).toBe(2);
  expect((await cli(["config", "recover-policy", "--help"], ws, { provider })).code).toBe(0);
  expect(existsSync(join(ws.managed, "policy.json"))).toBe(false);
  expect(provider.requests).toHaveLength(0);
});

test("TECH — a protected enrolment cannot replace a distribution organisation, fingerprint or remote perimeter", async () => {
  const ws = workspace();
  ws.write("managed/enrollment.json", enrollment());
  ws.write("managed/policy.json", POLICY);
  const seed = JSON.parse(readFileSync(join(ROOT, "identity/dev.identity.json"), "utf8"));
  const provider = new ScriptedProvider([]);
  const matching = new Identity(resolveIdentity({ ...seed, policyAnchor: { organizationId: "enrolment-test", policySha256: hash(POLICY) } }, { version: "0.1.0" }).identity!);
  expect((await cli(["--non-interactive", "/preferences ui.history.maxEntries"], ws, { identity: matching, provider })).stdout).toContain("456");
  for (const policyAnchor of [{ organizationId: "different", policySha256: hash(POLICY) }, { organizationId: "enrolment-test", policySha256: hash("{}") }, { organizationId: "enrolment-test", policySha256: hash(POLICY), perimeter: "remote" }]) {
    const identity = new Identity(resolveIdentity({ ...seed, policyAnchor }, { version: "0.1.0" }).identity!);
    const result = await cli(["--non-interactive", "Read the summary."], ws, { identity, provider });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("conflit avec l'ancrage");
    expect((await cli(["config", "recover-policy", "policy.json"], ws, { identity, provider })).code).toBe(4);
  }
  expect(provider.requests).toHaveLength(0);
});

test("TECH — corrupt enrolled bytes are never adopted by reload or exposed to the model", async () => {
  const ws = workspace();
  ws.write("managed/enrollment.json", enrollment());
  ws.write("managed/policy.json", POLICY);
  const identity = loadIdentity();
  const loaded = loadConfiguration({ identity, env: new EnvironmentView(identity.get("ENV_PREFIX"), {}), cwd: ws.project, system: { ...systemInfo(), home: ws.home }, managedDir: ws.managed, policyFileProtection: trustedPolicyFile });
  const warnings: string[] = [];
  const reloader = new SettingsReloader({ files: loaded.sources.filter((source) => source.name !== loaded.systemPolicy?.name), fixed: [], base: { projectTrusted: false }, current: loaded.settings, warn: (message) => warnings.push(message), policyFileProtection: trustedPolicyFile, systemPolicy: loaded.systemPolicy });
  const provider = new ScriptedProvider([() => { ws.write("managed/policy.json", JSON.stringify({ ui: { history: { maxEntries: 999 } } })); return { toolCalls: [{ name: "read_file", input: { path: join(ws.project, "public.txt") } }] }; }]);
  ws.write("project/public.txt", "ENROLMENT-READ-SENTINEL");
  const result = await cli(["--non-interactive", "Read public.txt."], ws, { provider });
  expect(result.code).toBe(4);
  expect(reloader.check()).toBeUndefined();
  expect(reloader.current.get<number>("ui.history.maxEntries")).toBe(456);
  expect(warnings.join("\n")).toContain("empreinte");
  expect(JSON.stringify(provider.requests)).not.toContain("ENROLMENT-READ-SENTINEL");
});

test("TECH — enrolment loss during a host approval refuses its effect and an interactive request stays suspended", async () => {
  const ws = workspace();
  const text = JSON.stringify({ permissions: { askRules: ["write_file"] } });
  ws.write("managed/enrollment.json", enrollment(text));
  ws.write("managed/policy.json", text);
  const target = join(ws.project, "pending.txt");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "ENROLMENT-APPROVAL-SENTINEL" } }] }]);
  const host = new Host(ws, { provider, init: { decisionAuthority: true }, answers: { approval_request: () => { unlinkSync(join(ws.managed, "enrollment.json")); return { decision: "allow" }; } } });
  host.user("Write pending.txt.");
  try {
    expect(JSON.stringify(await host.waitFor((message) => message.type === "error"))).toContain("inscription");
    expect(host.demands("approval_request")).toHaveLength(1);
    expect(existsSync(target)).toBe(false);
  } finally { host.feed.end(); }
  expect((await host.finish()).code).toBe(0);
  ws.write("managed/enrollment.json", enrollment(text));
  const terminal = interactive([], ws, { provider: new ScriptedProvider([]) });
  try {
    await terminal.idle();
    unlinkSync(join(ws.managed, "policy.json"));
    terminal.type("Read the summary." + KEY.enter);
    await terminal.waitFor((screen) => screen.includes("enrolment-test"), "enrolled policy refusal");
  } finally { terminal.type("/quit" + KEY.enter); }
  expect((await terminal.done).code).toBe(0);
});

test("TECH — native enrolment protection and bounded source rules cannot be replaced by readonly flags or links", async () => {
  if (currentPlatform() === "windows") {
    const child = spawnSync(process.execPath, [join(import.meta.dir, "fixtures/policy-file-windows.ts")], { encoding: "utf8", timeout: 15_000, windowsHide: true });
    expect(child.status).toBe(0);
    expect(child.stderr).toBe("");
    const report = JSON.parse(child.stdout);
    expect(report.enrolled.code).toBe(4);
    expect(report.enrolled.stderr).toContain("Inscription d'organisation invalide");
    expect(report.enrolled.stderr).toContain("modifiable");
    expect(report.recovery.code).toBe(4);
    return;
  }
  const ws = workspace();
  const manifest = ws.write("managed/enrollment.json", enrollment());
  chmodSync(manifest, 0o444);
  try {
    const registered = readPolicyEnrollment(join(ws.managed, "policy.json"), undefined, inspectPolicyFileProtection);
    expect(registered.issues.length === 0).toBe(process.geteuid?.() === 0);
    chmodSync(ws.managed, 0o777);
    expect(readPolicyEnrollment(join(ws.managed, "policy.json")).issues).toHaveLength(1);
  } finally { chmodSync(manifest, 0o644); chmodSync(ws.managed, 0o755); }
  unlinkSync(manifest);
  const source = ws.write("project/ordinary.json", enrollment());
  symlinkSync(source, manifest);
  expect(readPolicyEnrollment(join(ws.managed, "policy.json"), undefined, trustedPolicyFile).issues).toHaveLength(1);
});
