// Extensions within the session (lot 8, increment 4): /extensions (SPEC-CMD-049) and /reload-extensions (SPEC-CMD-054).
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, TEST_USER_CONFIG, workspace as bareWorkspace, type Workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

/** A Git catalogue `team` holding the extension `revue`: a command `verifier` and a hook on `turn_completed`. */
function gitCatalog(ws: Workspace): string {
  const dir = join(ws.root, "catalogue");
  const files: Record<string, string> = {
    "catalog.json": JSON.stringify({ name: "team", extensions: [{ name: "revue", source: "./revue", version: "1.0.0" }] }),
    "revue/extension.json": JSON.stringify({ name: "revue", version: "1.0.0", description: "Relecture d'équipe." }),
    "revue/commands/verifier.md": '---\ndescription: "Vérifie le changement courant."\n---\nVérifie le changement selon les règles de l\'équipe.\n',
    "revue/event-hooks.json": JSON.stringify({ hooks: { turn_completed: [{ id: "journal", actions: [{ type: "command", command: "echo fin-de-tour" }] }] } }),
  };
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), content);
  }
  for (const args of [["init", "-q"], ["add", "-A"], ["commit", "-q", "-m", "catalogue"]]) {
    const r = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "init.defaultBranch=main", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  }
  return dir;
}

/** A workspace whose user settings hold the catalogue `team`, added by the administration command. */
async function workspace(): Promise<Workspace> {
  const ws = bareWorkspace();
  writeFileSync(join(ws.configHome, "config.json"), JSON.stringify(TEST_USER_CONFIG));
  const r = await cli(["catalog", "add", gitCatalog(ws)], ws, { env: productEnv(ws), userConfig: null });
  if (r.code !== 0) throw new Error(r.stderr);
  return ws;
}
/** The user settings as written by the administration commands, kept by the interactive runs. */
const saved = (ws: Workspace) => JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")) as Record<string, unknown>;
type Run = ReturnType<typeof interactive>;
const command = (run: Run, line: string) => {
  run.type(line);
  run.type(KEY.enter);
};
const quit = async (run: Run) => {
  await run.idle();
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  await run.done;
};

describe("SPEC-CMD-049 /extensions", () => {
  test("SPEC-CMD-049/CA-01 — an extension contributing a hook: the hook is listed on the confirmation screen before the installation", async () => {
    const ws = await workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: saved(ws), env: productEnv(ws) });
    await run.idle();
    command(run, "/extensions install revue@team");
    await run.waitFor((t) => t.includes("Installer revue@team"), "confirmation");
    const screen = run.all().join("\n");
    expect(screen).toContain("crochets : 1");
    expect(screen).toContain("revue@team : commande du crochet extension/turn_completed/journal : echo fin-de-tour");
    await sleep(350);
    run.type("o");
    await run.waitFor((t) => t.includes("Elle sera chargée après /reload-extensions."), "installed");
    expect(run.all().join("\n")).toContain("installée et activée en portée user");
    await quit(run);
  }, 60_000);
});

describe("SPEC-CMD-054 /reload-extensions", () => {
  test("SPEC-CMD-054/CA-01 — an extension installed during the session: once reloaded, its commands are available", async () => {
    const ws = await workspace();
    const p = new ScriptedProvider([{ text: "vérification faite" }]);
    const run = interactive([], ws, { provider: p, userConfig: saved(ws), env: productEnv(ws) });
    await run.idle();
    // Installed from another terminal while the session runs.
    const added = await cli(["extension", "add", "revue@team", "--force"], ws, { env: productEnv(ws), userConfig: null });
    expect(added.code).toBe(0);
    command(run, "/revue:verifier");
    await run.waitFor((t) => t.includes("revue:verifier"), "unknown before the reload");
    expect(p.requests).toHaveLength(0);
    await run.idle();
    command(run, "/reload-extensions");
    await run.waitFor((t) => t.includes("Ajoutées : revue@team"), "report");
    await run.idle();
    command(run, "/revue:verifier");
    await run.waitFor((t) => t.includes("vérification faite"), "command run");
    expect(JSON.stringify(p.requests[0]!.history)).toContain("Vérifie le changement selon les règles de l'équipe.");
    await quit(run);
  }, 60_000);
});
