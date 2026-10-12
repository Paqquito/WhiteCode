// Diagnosis and setting up (lot 8, increment 5): /diagnose and `diagnostic validate|repair` (SPEC-CMD-020),
// /create-instructions (SPEC-CMD-033), /shortcuts edit (SPEC-CMD-039).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readKeybindingsFile } from "../src/interactive/keybindings-file";
import { cli, loadIdentity, workspace, type Workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { BUN, productEnv } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const INSTRUCTIONS_FILE = loadIdentity().get("INSTRUCTIONS_FILE");
const BROKEN = { ui: { colorMode: 42 } };
const userConfig = (ws: Workspace) => JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8"));
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

describe("SPEC-CMD-020 /diagnose", () => {
  test("SPEC-MOD-012/CA-10 — SPEC-OBS-015/CA-04 — diagnostic repair applies its proposal only after explicit agreement", async () => {
    for (const accepted of [false, true]) {
      const ws = workspace();
      const p = new ScriptedProvider([]);
      const r = await cli(["diagnostic", "repair"], ws, { provider: p, env: productEnv(ws), userConfig: BROKEN, tty: true, stdin: accepted ? "o\n" : "n\n" });
      expect(r.code).toBe(0);
      expect(r.stderr).toContain("Appliquer : retirer `ui.colorMode`");
      expect(userConfig(ws).ui?.colorMode).toBe(accepted ? undefined : 42);
      expect(p.requests).toHaveLength(0);
    }
  });
  test("SPEC-CMD-020/CA-01 — an invalid settings file: the error is reported with its place and the correction proposed", async () => {
    const ws = workspace();
    const r = await cli(["--non-interactive", "/diagnose"], ws, { provider: new ScriptedProvider([]), userConfig: BROKEN });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✗ Configuration : .*ui\.colorMode.* — .*config\.json, clé ui\.colorMode/);
    expect(r.stdout).toContain("correction proposée : retirer `ui.colorMode` (la valeur par défaut s'appliquera)");
    expect(r.stdout).toMatch(/Résumé : \d+ corrects?, \d+ avertissements?, 1 erreur\./);
    // Outside a session, the same report; the exit code tells the error.
    const outside = await cli(["diagnostic", "validate"], ws, { env: productEnv(ws), userConfig: BROKEN });
    expect(outside.code).toBe(1);
    expect(outside.stdout).toContain("correction proposée : retirer `ui.colorMode`");
    expect(userConfig(ws).ui.colorMode).toBe(42); // EF-01: nothing changed without agreement
  });

  test("SPEC-CMD-020/CA-02 — `diagnostic valide` (typo): not run; `diagnostic validate` is suggested", async () => {
    const r = await cli(["diagnostic", "valide"], workspace(), { env: productEnv(workspace()) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Commande inconnue : diagnostic valide. Vouliez-vous dire diagnostic validate");
    expect(r.stdout).toBe("");
  });

  test("TECH — SPEC-CMD-020/EF-01 — /diagnose repair: the correction is applied once accepted", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: BROKEN });
    await run.idle();
    command(run, "/diagnose repair");
    await run.waitFor((t) => t.includes("Appliquer : retirer `ui.colorMode`"), "agreement asked");
    expect(userConfig(ws).ui.colorMode).toBe(42);
    await sleep(350);
    run.type("o");
    await run.waitFor((t) => t.includes("1 correction appliquée."), "applied");
    expect(userConfig(ws).ui?.colorMode).toBeUndefined();
    await quit(run);
  }, 30_000);
});

describe("SPEC-CMD-033 /create-instructions", () => {
  test("SPEC-CMD-033/CA-01 — a repository without instructions: a concise file is proposed, then written", async () => {
    const ws = workspace();
    ws.write("project/package.json", JSON.stringify({ scripts: { test: "bun test" } }));
    const target = join(ws.project, INSTRUCTIONS_FILE);
    const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "# Projet\n\n- Tests : `bun test`.\n" } }] }, { text: "Instructions écrites." }]);
    // The agreement of the user: the host approves the write of the file it was shown.
    const approvals: string[] = [];
    const h = new Host(ws, { provider: p, init: { decisionAuthority: true }, answers: { approval_request: (params) => (approvals.push(JSON.stringify(params)), { decision: "allow" }) } });
    h.user("/create-instructions");
    await h.waitFor((m) => m.type === "turn_completed");
    h.feed.end();
    await h.finish();
    const sent = JSON.stringify(p.requests[0]!.history);
    expect(sent).toContain(`set up the project instructions file \`${INSTRUCTIONS_FILE}\``);
    expect(sent).toContain("Draft concise instructions");
    expect(sent).toContain("ask for their agreement before writing anything");
    expect(approvals).toHaveLength(1);
    expect(readFileSync(target, "utf8")).toContain("bun test");
  }, 30_000);

  test("SPEC-CMD-033/CA-02 — the guided version and the choice « skills only »: no hook is proposed", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "Compétences proposées." }]);
    const h = new Host(ws, { provider: p, init: {}, userConfig: { commands: { createInstructions: { guided: true } } } });
    h.user("/create-instructions compétences");
    await h.waitFor((m) => m.type === "turn_completed");
    h.feed.end();
    await h.finish();
    const sent = JSON.stringify(p.requests[0]!.history);
    expect(sent).toContain("They chose to set up: skills.");
    expect(sent).toContain("Create skills for the workflows");
    expect(sent).not.toMatch(/hook/i);
    expect(sent).not.toContain(INSTRUCTIONS_FILE);
  }, 30_000);
});

describe("SPEC-CMD-039 /shortcuts edit", () => {
  test("SPEC-CMD-039/CA-01 — no file of shortcuts: a commented model is created and opened", async () => {
    const ws = workspace();
    const marker = join(ws.root, "opened.txt").replace(/\\/g, "/");
    const editor = ws.write("editor.ts", `await Bun.write(${JSON.stringify(marker)}, process.argv[2] ?? "");`).replace(/\\/g, "/");
    const run = interactive([], ws, { provider: new ScriptedProvider([]), env: productEnv(ws, { EDITOR: `"${BUN}" "${editor}"` }) });
    await run.idle();
    const file = join(ws.configHome, "keybindings.json");
    expect(existsSync(file)).toBe(false);
    command(run, "/shortcuts edit");
    await run.waitFor((t) => t.includes("Fichier des raccourcis créé"), "created");
    const text = readFileSync(file, "utf8");
    expect(text).toContain("// Raccourcis clavier de");
    expect(text).toMatch(/\/\/ {3}app\.interrupt/);
    expect(readKeybindingsFile(file).error).toBeUndefined(); // EF-01
    for (let i = 0; i < 50; i++) {
      if (existsSync(marker) && readFileSync(marker, "utf8").replace(/\\/g, "/") === file.replace(/\\/g, "/")) break;
      await sleep(100);
    }
    expect(readFileSync(marker, "utf8").replace(/\\/g, "/")).toBe(file.replace(/\\/g, "/"));
    // Step 3: saved, it is read again and its errors are reported.
    await sleep(400);
    writeFileSync(file, '{ "bindings": { "action.inconnue": "f2" } }\n');
    await run.waitFor((t) => t.includes("Raccourcis : Action inconnue : action.inconnue."), "reloaded");
    await quit(run);
  }, 30_000);
});
