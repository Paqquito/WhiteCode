import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { EnvironmentView } from "../src/config/environment";
import { Settings, type ScopeSource } from "../src/config/settings";
import { decideTrust } from "../src/config/trust";
import { currentPlatform } from "../src/platform/system";
import { cli, loadIdentity, workspace } from "./helpers/env";

const ID = loadIdentity();
const PREFIX = ID.get("ENV_PREFIX");
const PROJECT_DIR = ID.get("PROJECT_DIR");
import { ScriptedProvider } from "./helpers/scripted-provider";

const src = (scope: ScopeSource["scope"], value: unknown): ScopeSource => ({ scope, name: `${scope}.json`, text: typeof value === "string" ? value : JSON.stringify(value) });
const load = (sources: ScopeSource[], extra: Partial<Parameters<typeof Settings.load>[0]> = {}) => Settings.load({ sources, projectTrusted: true, ...extra });

describe("SPEC-CFG-001 scopes and priority", () => {
  test("SPEC-CFG-001/CA-01 — a project value wins over a user value and its origin is project", () => {
    const s = load([src("user", { models: { selected: "small" } }), src("project", { models: { selected: "large" } })]);
    expect(s.get<unknown>("models.selected")).toBe("large");
    expect(s.origin("models.selected")).toBe("project");
  });

  test("SPEC-CFG-001/CA-02 — allow rules of the user and project scopes are both active", () => {
    const s = load([src("user", { permissions: { allowRules: ["read_file(a/**)"] } }), src("project", { permissions: { allowRules: ["read_file(b/**)"] } })]);
    expect(s.get<string[]>("permissions.allowRules").sort()).toEqual(["read_file(a/**)", "read_file(b/**)"]);
  });

  test("SPEC-CFG-001/CA-04 — invalid project JSON: other scopes load, a warning is raised", () => {
    const s = load([src("user", { models: { selected: "small" } }), src("project", "{ not json")]);
    expect(s.get<unknown>("models.selected")).toBe("small");
    expect(s.issues.some((i) => i.code === "ERR-01" && i.message.includes("JSON invalide"))).toBe(true);
  });

  test("SPEC-CFG-001/CA-05 — --config-scopes user ignores project and local, never managed", () => {
    const s = load(
      [src("managed", { permissions: { denyRules: ["read_file(secret/**)"] } }), src("user", { models: { selected: "small" } }), src("project", { models: { selected: "large" } }), src("local", { models: { selected: "medium" } })],
      { allowedScopes: ["user"] },
    );
    expect(s.get<unknown>("models.selected")).toBe("small");
    expect(s.get<string[]>("permissions.denyRules")).toEqual(["read_file(secret/**)"]);
  });

  test("SPEC-CFG-001/CA-07 — a key never read from the project is ignored in the local file, with a warning", () => {
    const s = load([src("local", { storage: { encryption: { enabled: true } } })]);
    expect(s.get<unknown>("storage.encryption.enabled")).toBe(false);
    expect(s.issues.some((i) => i.key === "storage.encryption.enabled")).toBe(true);
  });

  test("SPEC-CFG-001/CA-08 — sandbox exclusions from the project are ignored", () => {
    const s = load([src("project", { sandbox: { excludedCommands: ["curl"] } })]);
    expect(s.get<string[]>("sandbox.excludedCommands")).toEqual([]);
    expect(s.issues.some((i) => i.key === "sandbox.excludedCommands")).toBe(true);
  });

  test("SPEC-CFG-001/CA-09 — the project cannot disable a sandbox enabled by the user", () => {
    const s = load([src("user", { sandbox: { enabled: true } }), src("project", { sandbox: { enabled: false } })]);
    expect(s.get<unknown>("sandbox.enabled")).toBe(true);
  });

  test("SPEC-CFG-001/CA-10 — environment.variables from the project is ignored", () => {
    const s = load([src("project", { environment: { variables: { X_SHELL_INIT_FILE: "evil.sh" } } })]);
    expect(s.get<unknown>("environment.variables")).toEqual({});
    expect(s.issues.some((i) => i.key === "environment.variables")).toBe(true);
  });

  test("SPEC-CFG-001/CA-11 — SPEC-PER-003/CA-05 — permissions.initialMode auto_edit in the project is ignored, mode ask", () => {
    for (const scope of ["project", "local"] as const) {
      const s = load([src(scope, { permissions: { initialMode: "auto_edit" } })]);
      expect(s.get<unknown>("permissions.initialMode")).toBe("ask");
      expect(s.issues.some((i) => i.key === "permissions.initialMode")).toBe(true);
    }
    for (const bad of ["unrestricted", "auto_approve"]) expect(load([src("project", { permissions: { initialMode: bad } })]).get<unknown>("permissions.initialMode")).toBe("ask");
    expect(load([src("project", { permissions: { initialMode: "planning" } })]).get<unknown>("permissions.initialMode")).toBe("planning");
  });

  test("SPEC-CFG-001/CA-12 — SPEC-MOD-002/CA-08 — the non-interactive mode of the project is limited, run is no_prompt with a warning", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ engine: { nonInteractive: { defaultPermissionMode: "auto_edit" } } }));
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const events: string[] = [];
    const r = await cli(["--non-interactive", "--allow-project-trust", "--result-format", "json", "hello"], ws, {
      provider,
      extra: { onEvent: (e) => void (e.type === "permission" && events.push(e.decision)) },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("engine.nonInteractive.defaultPermissionMode");
    const meta = JSON.parse(r.stdout);
    expect(meta.haltReason).toBe("completed");
  });
});

describe("SPEC-CFG-002 schema and validation", () => {
  test("SPEC-CFG-002/CA-01 — a valid key applies, a mistyped key is reported with its path", () => {
    const s = load([src("user", { engine: { toolConcurrency: 4, maxOutputContinuations: "three" } })]);
    expect(s.get<unknown>("engine.toolConcurrency")).toBe(4);
    expect(s.get<unknown>("engine.maxOutputContinuations")).toBe(3);
    expect(s.issues.some((i) => i.key === "engine.maxOutputContinuations" && i.code === "ERR-03")).toBe(true);
  });

  test("SPEC-CFG-002/CA-02 — auth.loginMethod in the project settings is ignored (ERR-01)", () => {
    const s = load([src("project", { auth: { loginMethod: "key" } })]);
    expect(s.get<unknown>("auth.loginMethod")).toBeUndefined();
    expect(s.issues.some((i) => i.key === "auth.loginMethod" && i.code === "ERR-01")).toBe(true);
  });

  test("SPEC-CFG-002/CA-05 — a duration with unit becomes milliseconds", () => {
    const s = load([src("user", { engine: { toolTimeout: "5m" } })]);
    expect(s.get<unknown>("engine.toolTimeout")).toBe(300_000);
  });

  test("TECH — unknown keys are reported with a suggestion", () => {
    const s = load([src("user", { engine: { toolConcurency: 4 } })]);
    expect(s.issues.some((i) => i.message.includes("engine.toolConcurrency"))).toBe(true);
  });
});

describe("SPEC-CFG-007 environment variables", () => {
  test("SPEC-CFG-007/CA-01 — PREFIX_DEBUG=yes activates the debug journal", async () => {
    const ws = workspace();
    const r = await cli(["--non-interactive", "--debug-output", "stderr", "hi"], ws, { provider: new ScriptedProvider([{ text: "ok" }]), env: { [`${PREFIX}DEBUG`]: "yes" } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("[config] settings loaded");
    expect(new EnvironmentView(PREFIX, { [`${PREFIX}DEBUG`]: "YES" }).ownBoolean("DEBUG")).toBe(true);
  });

  test("TECH — unknown own variables are reported with a suggestion", () => {
    const env = new EnvironmentView(PREFIX, { [`${PREFIX}DEBUGG`]: "1" });
    expect(env.issues[0]?.message).toContain(`${PREFIX}DEBUG`);
  });
});

describe("D-05 --allow-project-trust", () => {
  test("D-05 — without trust the project settings are ignored; --allow-project-trust reads them for this run only", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ permissions: { denyRules: ["read_file"] } }));
    const untrusted = await cli(["--non-interactive", "--toolset", "read_file", "hi"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(untrusted.stderr).toContain("projet non approuvé");
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const trusted = await cli(["--non-interactive", "--allow-project-trust", "hi"], ws, { provider });
    expect(trusted.code).toBe(0);
    expect(trusted.stderr).toContain("Options levant une protection actives : --allow-project-trust");
    // The project denies the whole tool: it is no longer presented to the model.
    expect(provider.requests[0]!.tools.map((t) => t.name)).not.toContain("read_file");
    // Never persisted: a new run without the option is untrusted again.
    const again = await cli(["--non-interactive", "hi"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(again.stderr).toContain("projet non approuvé");
  });

  test("D-05 — the managed policy can forbid --allow-project-trust", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ policy: { forbiddenOptions: ["--allow-project-trust"] } }));
    const r = await cli(["--non-interactive", "--allow-project-trust", "hi"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("désactivée par la politique");
  });

  test("D-05 — trust never lifts widening keys", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ environment: { variables: { A: "1" } }, permissions: { extraDirectories: ["/"] } }));
    const r = await cli(["--non-interactive", "--allow-project-trust", "hi"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(r.stderr).toContain("environment.variables");
    expect(r.stderr).toContain("permissions.extraDirectories");
  });

  test("TECH — a trusted parent folder covers its sub-folders", () => {
    const d = decideTrust({ projectRoot: join("/tmp", "a", "b"), userState: { trustedProjects: [join("/tmp", "a")] }, managedTrustedDirectories: [], trustOption: false, platform: currentPlatform() });
    expect(d).toEqual({ trusted: true, source: "user-state" });
  });
});
