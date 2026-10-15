// Catalogues (SPEC-EXT-004), installation and life cycle (SPEC-EXT-002), activation scopes (SPEC-EXT-003),
// compatibility with the product (SPEC-EXT-008) and catalogues allowed by the policy (SPEC-EXT-009).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, TEST_USER_CONFIG, workspace as bareWorkspace, type Workspace } from "./helpers/env";
import { productEnv, PROJECT_DIR } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const manifest = (name: string, extra: Record<string, unknown> = {}) => JSON.stringify({ name, version: "1.0.0", description: `The ${name} extension.`, ...extra });
const skill = (description: string) => `---\ndescription: ${JSON.stringify(description)}\n---\nbody\n`;

/** A catalogue folder `<dir>` named `name` holding the extension `revue` (one skill). */
function catalogFiles(dir: string, name: string, extra: Record<string, string> = {}, entries?: unknown[]): void {
  const files: Record<string, string> = {
    "catalog.json": JSON.stringify({ name, extensions: entries ?? [{ name: "revue", source: "./revue", version: "1.0.0" }] }),
    "revue/extension.json": manifest("revue"),
    "revue/skills/check/definition.md": skill("Checks a change against the team rules."),
    ...extra,
  };
  for (const [p, content] of Object.entries(files)) {
    const full = join(dir, p);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, content);
  }
}

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function gitCatalog(dir: string, name: string, extra: Record<string, string> = {}, entries?: unknown[]): string {
  mkdirSync(dir, { recursive: true });
  catalogFiles(dir, name, extra, entries);
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "catalogue");
  return dir;
}

/** A workspace whose user settings are written once: the commands under test write into them. */
function workspace(): Workspace {
  const ws = bareWorkspace();
  // These lifecycle tests inspect the static catalogue; discovery has separate runtime tests.
  writeFileSync(join(ws.configHome, "config.json"), JSON.stringify({ ...TEST_USER_CONFIG, skills: { discovery: { enabled: false } } }));
  return ws;
}
const admin = (ws: Workspace, args: string[], cwd?: string) => cli(args, ws, { env: productEnv(ws), userConfig: null, extra: cwd ? { cwd } : {} });
const session = (ws: Workspace, args: string[] = [], cwd?: string) => {
  const p = new ScriptedProvider([{ text: "done" }]);
  return cli(["--non-interactive", ...args, "x"], ws, { provider: p, userConfig: null, env: productEnv(ws), extra: cwd ? { cwd } : {} }).then((r) => ({ ...r, system: JSON.stringify(p.requests[0]?.system ?? []) }));
};
const userSettings = (ws: Workspace) => JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8"));

describe("SPEC-EXT-004 catalogues", () => {
  test("SPEC-EXT-004/CA-01 — a Git repository holding catalog.json: once added, its extensions are listed", async () => {
    const ws = workspace();
    const repo = gitCatalog(join(ws.root, "repo"), "team");
    const r = await admin(ws, ["catalog", "add", repo]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Catalogue team ajouté en portée user : 1 extension(s) (revue).");
    const list = await admin(ws, ["catalog", "list", "--json"]);
    expect(JSON.parse(list.stdout)).toEqual([{ name: "team", source: repo, cached: true, extensions: ["revue"] }]);
    expect((await admin(ws, ["catalog", "add", repo])).stderr).toContain("Un catalogue porte déjà ce nom : team"); // ERR-02
  });

  test("SPEC-EXT-004/CA-02 — a large repository with --lean-context catalog/: only the folder named is fetched", async () => {
    const ws = workspace();
    const repo = gitCatalog(join(ws.root, "big"), "lean", { "catalog/notes.md": "kept", "other/huge.bin": "x".repeat(10_000) }, [{ name: "revue", source: "./catalog/revue" }]);
    catalogFiles(join(repo, "catalog"), "unused");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "more");
    // A `file://` address: a shallow clone, as for a remote repository.
    const url = `file://${repo.startsWith("/") ? "" : "/"}${repo.replace(/\\/g, "/")}`;
    const r = await admin(ws, ["catalog", "add", url, "--lean-context", "catalog/"]);
    expect(r.stderr).toBe("");
    const cache = join(ws.configHome, "catalogs", "lean");
    expect(existsSync(join(cache, "catalog", "notes.md"))).toBe(true);
    expect(existsSync(join(cache, "other"))).toBe(false);
  });

  test("SPEC-EXT-004/CA-03 — the source unreachable when refreshing: the cache is kept", async () => {
    const ws = workspace();
    const repo = gitCatalog(join(ws.root, "repo"), "team");
    await admin(ws, ["catalog", "add", repo]);
    renameSync(repo, join(ws.root, "gone"));
    const r = await admin(ws, ["catalog", "update"]);
    expect(r.stderr).toContain("rafraîchissement impossible du catalogue team");
    expect(r.stderr).toContain("le cache est conservé");
    expect(JSON.parse((await admin(ws, ["catalog", "list", "--json"])).stdout)[0].extensions).toEqual(["revue"]);
  });

  test("SPEC-EXT-009/CA-02 — strictCatalogs = [catalogue A]: adding catalogue B is refused", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ extensions: { strictCatalogs: ["approved"] } }));
    catalogFiles(join(ws.root, "b"), "other");
    const r = await admin(ws, ["catalog", "add", join(ws.root, "b")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Catalogue non autorisé par votre organisation.");
    expect(existsSync(join(ws.configHome, "catalogs", "other"))).toBe(false);
  });
});

describe("SPEC-EXT-002 and SPEC-EXT-003 installation and activation", () => {
  const ready = async (ws: Workspace) => {
    catalogFiles(join(ws.root, "cat"), "team");
    expect((await admin(ws, ["catalog", "add", join(ws.root, "cat")])).code).toBe(0);
  };

  test("SPEC-EXT-002/CA-01 — an extension of a catalogue installed in the user scope: active in every project of the user", async () => {
    const ws = workspace();
    await ready(ws);
    const r = await admin(ws, ["extension", "add", "revue@team", "--force"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Extension revue@team 1.0.0 — The revue extension.");
    expect(r.stdout).toContain("Extension revue@team 1.0.0 installée et activée en portée user");
    expect(existsSync(join(ws.configHome, "extensions", "team", "revue", "1.0.0", "extension.json"))).toBe(true);
    const other = join(ws.root, "other-project");
    mkdirSync(other, { recursive: true });
    for (const cwd of [undefined, other]) expect((await session(ws, [], cwd)).system).toContain("- revue:check: Checks a change against the team rules.");
    const list = JSON.parse((await admin(ws, ["extension", "list", "--json"])).stdout);
    expect(list).toEqual([{ name: "review-kit", catalog: "bundled", versions: ["1.0.0"], active: false, bundled:true },{ name: "revue", catalog: "team", versions: ["1.0.0"], active: true }]);
  });

  test("SPEC-EXT-002/CA-02 — a network failure during the installation: no trace is left", async () => {
    const ws = workspace();
    catalogFiles(join(ws.root, "cat"), "team", {}, [{ name: "remote", source: { git: `file:///${join(ws.root, "missing-repo").replace(/\\/g, "/").replace(/^\//, "")}` } }]);
    await admin(ws, ["catalog", "add", join(ws.root, "cat")]);
    const r = await admin(ws, ["extension", "add", "remote@team", "--force"]);
    expect(r.code).toBe(1);
    expect(readdirSync(join(ws.configHome, "extensions"))).toEqual([]);
    expect(userSettings(ws).extensions.enabled).toBeUndefined();
  });

  test("SPEC-EXT-002/CA-03 — extension disable x --scope project: disabled for this project only", async () => {
    const ws = workspace();
    await ready(ws);
    await admin(ws, ["extension", "add", "revue@team", "--force"]);
    const r = await admin(ws, ["extension", "disable", "revue", "--scope", "project"]);
    expect(r.stdout).toContain("Extension revue@team désactivée en portée project (ce projet seulement).");
    expect((await session(ws, ["--allow-project-trust"])).system).not.toContain("revue:check");
    const other = join(ws.root, "other-project");
    mkdirSync(other, { recursive: true });
    expect((await session(ws, [], other)).system).toContain("revue:check");
  });

  test("SPEC-EXT-003/CA-01 — enabled by the project and disabled locally: inactive", async () => {
    const ws = workspace();
    await ready(ws);
    await admin(ws, ["extension", "add", "revue@team", "--force", "--scope", "project"]);
    expect((await session(ws, ["--allow-project-trust"])).system).toContain("revue:check");
    ws.write(`project/${PROJECT_DIR}/config.local.json`, JSON.stringify({ extensions: { enabled: { "revue@team": false } } }));
    expect((await session(ws, ["--allow-project-trust"])).system).not.toContain("revue:check");
  });

  test("SPEC-EXT-008/CA-01 — engine >=999.0 and the product older: installed but not activated, with the message", async () => {
    const ws = workspace();
    catalogFiles(join(ws.root, "cat"), "team", { "revue/extension.json": manifest("revue", { engine: ">=999.0" }) });
    await admin(ws, ["catalog", "add", join(ws.root, "cat")]);
    const r = await admin(ws, ["extension", "add", "revue@team", "--force"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("mais non activée : Cette extension nécessite une autre version de");
    expect(userSettings(ws).extensions.enabled).toBeUndefined();
  });

  test("TECH — SPEC-EXT-002 EF-01, FA-03, § 5.1 — without terminal nor --force the installation is not confirmed and leaves nothing; remove takes the copy away; catalog remove lists what came from it", async () => {
    const ws = workspace();
    await ready(ws);
    const unconfirmed = await admin(ws, ["extension", "add", "revue@team"]);
    expect(unconfirmed.code).toBe(5);
    expect(unconfirmed.stdout).toContain("Aucun code exécutable.");
    expect(readdirSync(join(ws.configHome, "extensions"))).toEqual([]);
    await admin(ws, ["extension", "add", "revue@team", "--force"]);
    const removed = await admin(ws, ["catalog", "remove", "team", "--force"]);
    expect(removed.stdout).toContain("Extensions installées depuis ce catalogue : revue");
    const r = await admin(ws, ["extension", "remove", "revue@team", "--force"]);
    expect(r.stdout).toContain("Extension revue@team désinstallée.");
    expect(existsSync(join(ws.configHome, "extensions", "team", "revue"))).toBe(false);
  });
});
