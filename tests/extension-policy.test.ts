// Dependencies (SPEC-EXT-007), versions and updates (SPEC-EXT-008), managed extensions and policy (SPEC-EXT-009),
// flagged extensions (SPEC-EXT-010).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, TEST_USER_CONFIG, workspace as bareWorkspace, type Workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

interface ExtSpec {
  readonly version?: string;
  readonly dependencies?: Record<string, string>;
}

/** The catalogue `team` in `<root>/cat`: one folder per extension, each with one skill `check`. */
function writeCatalog(ws: Workspace, extensions: Record<string, ExtSpec>, flagged?: unknown[]): string {
  const dir = join(ws.root, "cat");
  rmSync(dir, { recursive: true, force: true });
  const put = (p: string, content: string) => {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
  };
  put("catalog.json", JSON.stringify({ name: "team", extensions: Object.entries(extensions).map(([name, e]) => ({ name, source: `./${name}`, version: e.version ?? "1.0.0" })), ...(flagged ? { flagged } : {}) }));
  for (const [name, e] of Object.entries(extensions)) {
    put(`${name}/extension.json`, JSON.stringify({ name, version: e.version ?? "1.0.0", description: `The ${name} extension.`, ...(e.dependencies ? { dependencies: e.dependencies } : {}) }));
    put(`${name}/skills/check/definition.md`, `---\ndescription: "Check of ${name}."\n---\nbody\n`);
  }
  return dir;
}

function workspace(): Workspace {
  const ws = bareWorkspace();
  writeFileSync(join(ws.configHome, "config.json"), JSON.stringify(TEST_USER_CONFIG));
  return ws;
}
const admin = (ws: Workspace, ...args: string[]) => cli(args, ws, { env: productEnv(ws), userConfig: null });
const session = async (ws: Workspace) => {
  const p = new ScriptedProvider([{ text: "done" }]);
  const r = await cli(["--non-interactive", "x"], ws, { provider: p, userConfig: null, env: productEnv(ws) });
  return { ...r, system: JSON.stringify(p.requests[0]?.system ?? []) };
};
const withCatalog = async (ws: Workspace, extensions: Record<string, ExtSpec>, flagged?: unknown[]) => {
  const dir = writeCatalog(ws, extensions, flagged);
  expect((await admin(ws, "catalog", "add", dir)).code).toBe(0);
  return dir;
};

describe("SPEC-EXT-007 dependencies", () => {
  test("SPEC-EXT-007/CA-01 — A depends on B ^1.0: installing A proposes B and installs it with A", async () => {
    const ws = workspace();
    await withCatalog(ws, { a: { dependencies: { b: "^1.0" } }, b: { version: "1.2.0" } });
    const r = await admin(ws, "extension", "add", "a@team", "--force");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Plan :\n  b@team 1.2.0 (à installer)\n  a@team 1.0.0 (à installer)");
    expect(r.stdout).toContain("Extension a@team 1.0.0 installée et activée en portée user, avec b@team 1.2.0");
    const s = await session(ws);
    expect(s.system).toContain("- a:check: Check of a.");
    expect(s.system).toContain("- b:check: Check of b.");
  });

  test("SPEC-EXT-007/CA-02 — A requires B ^1, C requires B ^2: installing A then C explains the conflict", async () => {
    const ws = workspace();
    await withCatalog(ws, { a: { dependencies: { b: "^1" } }, b: {}, c: { dependencies: { b: "^2" } } });
    expect((await admin(ws, "extension", "add", "a@team", "--force")).code).toBe(0);
    const r = await admin(ws, "extension", "add", "c@team", "--force");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Conflit de dépendances sur b@team : a@team exige ^1, c@team exige ^2 ; versions disponibles : 1.0.0 (installée), 1.0.0 (catalogue team).");
    expect(existsSync(join(ws.configHome, "extensions", "team", "c"))).toBe(false);
  });

  test("TECH — SPEC-EXT-007/ERR-01, ERR-02, FA-02 — a missing dependency and a cycle are refused; a dependency disabled disables its dependents", async () => {
    const ws = workspace();
    await withCatalog(ws, { x: { dependencies: { y: "^1" } }, y: { dependencies: { x: "^1" } }, lone: { dependencies: { ghost: "^1" } }, a: { dependencies: { b: "^1" } }, b: {} });
    expect((await admin(ws, "extension", "add", "x@team", "--force")).stderr).toContain("Dépendances circulaires : x → y → x.");
    expect((await admin(ws, "extension", "add", "lone@team", "--force")).stderr).toContain("Dépendance introuvable : ghost@team (exigée par lone@team).");
    await admin(ws, "extension", "add", "a@team", "--force");
    await admin(ws, "extension", "disable", "b@team");
    const s = await session(ws);
    expect(s.stderr).toContain("Extension a@team désactivée : sa dépendance b@team ^1 n'est pas active.");
    expect(s.system).not.toContain("a:check");
  });
});

describe("SPEC-EXT-008 versions", () => {
  test("SPEC-EXT-008/CA-02 — 2.0.0-beta.1 available, update without allowPrerelease: ignored; a final version is installed beside the previous one", async () => {
    const ws = workspace();
    await withCatalog(ws, { revue: {} });
    await admin(ws, "extension", "add", "revue@team", "--force");
    writeCatalog(ws, { revue: { version: "2.0.0-beta.1" } });
    const beta = await admin(ws, "extension", "update", "--force");
    expect(beta.stdout).toContain("revue@team : la version 2.0.0-beta.1 est une préversion ; ignorée (extensions.allowPrerelease).");
    expect(existsSync(join(ws.configHome, "extensions", "team", "revue", "2.0.0-beta.1"))).toBe(false);
    writeCatalog(ws, { revue: { version: "1.1.0" } });
    const final = await admin(ws, "extension", "update", "revue", "--force");
    expect(final.stdout).toContain("revue@team mise à jour : 1.0.0 → 1.1.0.");
    expect(existsSync(join(ws.configHome, "extensions", "team", "revue", "1.0.0"))).toBe(true);
  });
});

describe("SPEC-EXT-009 managed extensions and policy", () => {
  test("SPEC-EXT-009/CA-01 — an imposed extension: at start it is installed and active", async () => {
    const ws = workspace();
    const dir = writeCatalog(ws, { revue: {} });
    ws.write("managed/policy.json", JSON.stringify({ extensions: { catalogs: { team: { source: dir } }, enabled: { "revue@team": true } } }));
    const s = await session(ws);
    expect(s.system).toContain("- revue:check: Check of revue.");
    expect(existsSync(join(ws.configHome, "extensions", "team", "revue", "1.0.0"))).toBe(true);
    expect((await admin(ws, "extension", "disable", "revue@team")).stderr).toContain("imposée par votre organisation");
  });

  test("SPEC-EXT-009/CA-03 — managedOnly and a user skill: the skill is ignored and reported", async () => {
    const ws = workspace();
    ws.write("home/config/skills/mine/definition.md", `---\ndescription: "My own skill."\n---\nbody\n`);
    ws.write("managed/policy.json", JSON.stringify({ extensions: { managedOnly: true } }));
    const s = await session(ws);
    expect(s.system).not.toContain("My own skill.");
    expect(s.stderr).toContain("compétences ignorées : mine : seules les personnalisations gérées sont admises (extensions.managedOnly).");
  });

  test("TECH — SPEC-EXT-009/EF-02 — a blocked extension already installed is not loaded", async () => {
    const ws = workspace();
    await withCatalog(ws, { revue: {} });
    await admin(ws, "extension", "add", "revue@team", "--force");
    ws.write("managed/policy.json", JSON.stringify({ extensions: { blocked: ["revue"] } }));
    const s = await session(ws);
    expect(s.stderr).toContain("Extension revue@team non chargée : Extension bloquée par votre organisation.");
    expect(s.system).not.toContain("revue:check");
  });
});

describe("SPEC-EXT-010 flagged extensions", () => {
  test("SPEC-EXT-010/CA-01 — SPEC-EXT-010/CA-02 — an installed extension flagged critical: disabled with the reason when the catalogue is refreshed; reactivation refused", async () => {
    const ws = workspace();
    await withCatalog(ws, { revue: {} });
    await admin(ws, "extension", "add", "revue@team", "--force");
    writeCatalog(ws, { revue: {} }, [{ name: "revue", severity: "critical", reason: "it sends the source code to a third party" }]);
    const update = await admin(ws, "catalog", "update");
    expect(update.stderr).toContain("Extension revue@team désactivée : signalée critique par son catalogue : it sends the source code to a third party");
    const s = await session(ws);
    expect(s.stderr).toContain("Extension revue@team désactivée : signalée critique par son catalogue");
    expect(s.system).not.toContain("revue:check");
    const enable = await admin(ws, "extension", "enable", "revue@team");
    expect(enable.code).toBe(1);
    expect(enable.stderr).toContain("signalée critique par son catalogue : it sends the source code to a third party. Activation refusée.");
  });
});
