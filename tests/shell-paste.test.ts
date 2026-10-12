// Shell mode (SPEC-IHM-012), pastes and attachments (SPEC-IHM-010), in the interactive session.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shellCommand } from "../src/interactive/shell-mode";
import { currentPlatform } from "../src/platform/system";
import { cli, workspace, type Workspace } from "./helpers/env";
import { hostEnv, productEnv } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const BUN = process.execPath.replace(/\\/g, "/");
const WINDOWS = currentPlatform() === "windows";
/** A command of the shell mode running a script with Bun, in the syntax of the interpreter of the platform. */
const bunLine = (ws: Workspace, name: string, body: string) => {
  const file = ws.write(`scripts/${name}.ts`, body).replace(/\\/g, "/");
  return WINDOWS ? `& "${BUN}" "${file}"` : `"${BUN}" "${file}"`;
};
const ALLOW_SHELL = { permissions: { allowRules: ["run_shell", "run_powershell"] } };
type Run = ReturnType<typeof interactive>;
const quit = async (run: Run) => {
  run.type(KEY.ctrlU);
  await run.idle();
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  return run.done;
};
const history = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history ?? []);
const lastUser = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history.filter((m) => m.role === "user").pop() ?? null);

test("TECH — virtual terminal ignores the host TERM and permits an explicit dumb terminal", async () => {
  const previous = hostEnv["TERM"];
  hostEnv["TERM"] = "dumb";
  try {
    const ws = workspace();
    expect(productEnv(ws, { TERM: "dumb" })["TERM"]).toBe("dumb");
    const p = new ScriptedProvider([{ text: "reçu" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p });
    await run.idle();
    run.paste("!literal pasted text");
    await run.waitFor((t) => t.includes("Texte collé : il sera envoyé comme texte"), "bracketed paste");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● reçu"), "unicode answer");
    expect(lastUser(p, 0)).toContain("!literal pasted text");
    await quit(run);
  } finally {
    if (previous === undefined) delete hostEnv["TERM"];
    else hostEnv["TERM"] = previous;
  }
}, 30_000);

describe("SPEC-IHM-012 shell mode", () => {
  test("SPEC-IHM-012/CA-01 — the mark at the start of the line: the indicator of the shell mode shows before any validation", async () => {
    const ws = workspace();
    const run = interactive([], ws, { env: productEnv(ws), provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("!");
    await run.waitFor((t) => t.includes("│ ! ") && t.includes("Mode shell : la ligne est exécutée par"), "indicator");
    run.type(KEY.ctrlU);
    await run.waitFor((t) => !t.includes("Mode shell"), "indicator gone");
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-012/CA-02 — SPEC-IHM-012/CA-08 — an allowed command runs and its output shows as it comes; the line goes to the interpreter as it is", async () => {
    const ws = workspace();
    const line = bunLine(ws, "lent", "console.log('début'); await Bun.sleep(1500); console.log('fin');");
    expect(shellCommand(`! ${line}`)).toBe(line);
    const p = new ScriptedProvider([]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p, userConfig: ALLOW_SHELL });
    await run.idle();
    run.type(`!${line}`);
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("début"), "first line");
    expect(run.all().join("\n")).not.toContain("fin\n");
    await run.waitFor((t) => t.includes("code de retour 0"), "exit code");
    expect(run.all().join("\n")).toContain("fin");
    expect(p.requests.length).toBe(0); // EF-01: never sent as a message
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-012/CA-03 — a command refused by a rule: nothing runs and the reason is shown", async () => {
    const ws = workspace();
    const marker = join(ws.root, "ran.txt").replace(/\\/g, "/");
    const line = bunLine(ws, "marque", `await Bun.write(${JSON.stringify(marker)}, "x");`);
    const run = interactive([], ws, { env: productEnv(ws), provider: new ScriptedProvider([]), userConfig: { permissions: { denyRules: ["run_shell", "run_powershell"] } } });
    await run.idle();
    run.type(`!${line}`);
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Commande refusée :"), "refusal");
    await sleep(300);
    expect(existsSync(marker)).toBe(false);
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-012/CA-04 — with ui.shellMode.addToContext never, the model does not know of the command at the next turn", async () => {
    const ws = workspace();
    const line = bunLine(ws, "secret", "console.log('VALEUR-OBSERVEE-42');");
    const p = new ScriptedProvider([{ text: "ok" }, { text: "ok" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p, userConfig: { ...ALLOW_SHELL, ui: { shellMode: { addToContext: "never" } } } });
    await run.idle();
    run.type(`!${line}`);
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("code de retour 0"), "ran");
    await run.idle();
    run.type("et maintenant ?");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● ok"), "turn");
    expect(history(p, 0)).not.toContain("VALEUR-OBSERVEE-42");
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-012/CA-05 — interrupting a long command stops it and its child processes", async () => {
    const ws = workspace();
    const marker = join(ws.root, "late.txt").replace(/\\/g, "/");
    const ready = join(ws.root, "child-pid.txt").replace(/\\/g, "/"), release = join(ws.root, "release.txt").replace(/\\/g, "/");
    const child = ws.write("scripts/child.ts", `await Bun.write(${JSON.stringify(ready)}, String(process.pid)); while (!await Bun.file(${JSON.stringify(release)}).exists()) await Bun.sleep(20); await Bun.write(${JSON.stringify(marker)}, "x");`).replace(/\\/g, "/");
    const line = bunLine(ws, "parent", `const c = Bun.spawn([${JSON.stringify(BUN)}, ${JSON.stringify(child)}]); while (!await Bun.file(${JSON.stringify(ready)}).exists()) await Bun.sleep(20); console.log("lancé"); await c.exited;`);
    const run = interactive([], ws, { env: productEnv(ws), provider: new ScriptedProvider([]), userConfig: ALLOW_SHELL });
    await run.idle();
    run.type(`!${line}`);
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("lancé"), "started");
    run.type(KEY.escape);
    await run.waitFor((t) => t.includes("commande interrompue"), "interrupted");
    const pid = Number(readFileSync(ready, "utf8"));
    let alive = true; try { process.kill(pid, 0); } catch { alive = false; }
    expect(alive).toBe(false);
    writeFileSync(release, "released after interruption");
    await sleep(3500);
    expect(existsSync(marker)).toBe(false);
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-012/CA-06 — an output holding a sensitive value is masked when added to the context", async () => {
    const ws = workspace();
    const line = bunLine(ws, "fuite", "console.log('cle=sk-abcdefghijklmnopqrstuvwxyz0123456789');");
    const p = new ScriptedProvider([{ text: "ok" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p, userConfig: ALLOW_SHELL });
    await run.idle();
    run.type(`!${line}`);
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("ajoutée au contexte"), "added");
    await run.idle();
    run.type("regarde");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● ok"), "turn");
    const sent = history(p, 0);
    expect(sent).toContain("user-shell-command");
    expect(sent).toContain("[masqué]");
    expect(sent).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-012/CA-07 — in an automated run, the mark is refused with an explanation", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([]);
    const r = await cli(["--non-interactive", "!ls"], ws, { provider: p, env: productEnv(ws) });
    expect(r.stderr).toContain("Le mode shell n'est pas disponible dans ce mode.");
    expect(p.requests.length).toBe(0);
  }, 30_000);

  test("SPEC-IHM-012/CA-09 — !!important at the start is sent as the text !important", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "reçu" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p });
    await run.idle();
    run.type("!!important : relis ce point");
    await sleep(50);
    expect(run.screen().join("\n")).not.toContain("Mode shell");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● reçu"), "sent");
    expect(lastUser(p, 0)).toContain("!important : relis ce point");
    await quit(run);
  }, 30_000);
});

describe("SPEC-IHM-010 pastes and attachments", () => {
  test("SPEC-IHM-010/CA-01 — SPEC-IHM-010/CA-08 — a pasted text of 50 lines is inserted without sending; a pasted !rm -rf build goes as text", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "lu" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p, rows: 80 });
    await run.idle();
    const fifty = ["!rm -rf build", ...Array.from({ length: 49 }, (_, i) => `ligne ${i + 2}`)].join("\n");
    run.paste(fifty);
    await run.waitFor((t) => t.includes("ligne 50") && t.includes("Texte collé : il sera envoyé comme texte"), "pasted");
    expect(run.screen().join("\n")).not.toContain("Mode shell");
    await sleep(100);
    expect(p.requests.length).toBe(0);
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● lu"), "sent as text");
    expect(lastUser(p, 0)).toContain("!rm -rf build");
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-010/CA-02 — SPEC-IHM-010/CA-03 — a paste beyond the threshold shows a compact reference, can be checked, and goes whole", async () => {
    const ws = workspace();
    const big = Array.from({ length: 300 }, (_, i) => `donnée ${i}`).join("\n");
    const p = new ScriptedProvider([{ text: "ok" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p, rows: 30 });
    await run.idle();
    run.type("analyse ");
    run.paste(big);
    await run.waitFor((t) => /\[Texte collé n°1 : 300 lignes, \d+ caractères\]/.test(t), "compact reference");
    run.type("\u001bp"); // Alt+P: unfold to check
    await run.waitFor((t) => t.includes("donnée 299"), "unfolded");
    run.type(KEY.ctrlC); // clears the whole input
    await run.idle();
    run.type("analyse ");
    run.paste(big);
    await run.waitFor((t) => t.includes("[Texte collé n°"), "folded again");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● ok"), "sent");
    const sent = lastUser(p, 0);
    expect(sent).toContain("donnée 0");
    expect(sent).toContain("donnée 299");
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-010/CA-05 — a file changed after its reference: its current state goes", async () => {
    const ws = workspace();
    ws.write("project/notes.md", "version 1\n");
    const p = new ScriptedProvider([{ text: "ok" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p });
    await run.idle();
    run.type("résume @notes.md");
    await run.waitFor((t) => t.includes("Pièces jointes à l'envoi : notes.md"), "attachment shown before sending");
    writeFileSync(join(ws.project, "notes.md"), "version 2\n");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Pièce jointe : notes.md"), "attached");
    const sent = history(p, 0);
    expect(sent).toContain("version 2");
    expect(sent).not.toContain("version 1");
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-010/CA-06 — a paste holding control sequences: escaped, without effect on the terminal", async () => {
    const ws = workspace();
    const run = interactive([], ws, { env: productEnv(ws), provider: new ScriptedProvider([]) });
    await run.idle();
    run.paste("avant\u001b[2Japrès\u0007");
    await run.waitFor((t) => t.includes("avant^[[2Japrès^G"), "escaped");
    expect(run.all().join("\n")).toContain("mode : ask");
    await quit(run);
  }, 30_000);

  test("SPEC-IHM-010/CA-07 — the twenty-first attachment is refused with an explicit message", async () => {
    const ws = workspace();
    const refs: string[] = [];
    for (let i = 1; i <= 21; i++) {
      ws.write(`project/f${i}.txt`, `contenu ${i}\n`);
      refs.push(`@f${i}.txt`);
    }
    const p = new ScriptedProvider([{ text: "ok" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p });
    await run.idle();
    run.paste(`compare ${refs.slice(0, 20).join(" ")}`);
    // The references of a paste never attach (EF-10): the last one is typed.
    run.type(" @f21.txt");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● ok"), "sent");
    const sent = history(p, 0);
    expect(sent).toContain("contenu 21");
    expect(sent).not.toContain("contenu 1\\n");
    // Twenty-one typed references: the last is refused.
    const p2 = new ScriptedProvider([{ text: "ok" }]);
    const run2 = interactive([], ws, { env: productEnv(ws), provider: p2, columns: 300 });
    await run2.idle();
    run2.type(`compare ${refs.join(" ")}`);
    run2.type(KEY.enter);
    await run2.waitFor((t) => t.includes("Nombre maximal de pièces jointes atteint (20) : @f21.txt".replace("@", "")), "refused");
    expect(history(p2, 0)).toContain("contenu 20");
    expect(history(p2, 0)).not.toContain("contenu 21");
    await quit(run);
    await quit(run2);
  }, 30_000);

  test("SPEC-IHM-010/CA-09 — without a reliable detection, a text starting with / arriving at once needs a confirmation to run as a command", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "texte reçu" }]);
    const run = interactive([], ws, { env: productEnv(ws), provider: p });
    await run.idle();
    run.raw("/help");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("L'exécuter comme commande ?"), "confirmation");
    await sleep(350);
    run.type("n");
    await run.waitFor((t) => t.includes("● texte reçu"), "sent as text");
    expect(lastUser(p, 0)).toContain("/help");
    await quit(run);
  }, 30_000);
});
