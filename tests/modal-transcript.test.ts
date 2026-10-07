// Modal editing (SPEC-IHM-013) and full-screen view of the transcript (SPEC-IHM-006, SPEC-IHM-002 CA-05).
import { describe, expect, test } from "bun:test";
import { InteractiveApp } from "../src/interactive/app";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { fakeTerminal } from "./helpers/vterm";
import { DEFAULT_CODE_THEME } from "../src/ui/highlight";

const HL = { enabled: true, maxBytes: 262_144, timeoutMs: 50, theme: DEFAULT_CODE_THEME };
const RENDER = {
  markdown: { enabled: true, maxRenderedChars: 200_000, maxNestingLevel: 6, wrapTables: false, highlight: HL },
  diff: { contextLines: 3, layout: "auto", maxDisplayedLines: 500, intraline: true, showInvisible: true, highlight: HL },
};

type Run = ReturnType<typeof interactive>;
const MODAL = { ui: { input: { editMode: "modal" } } };
const inputLine = (run: Run) => run.screen().find((l) => l.startsWith("│ › ")) ?? "";
const quit = async (run: Run) => {
  run.type(KEY.ctrlC);
  await run.waitFor((t) => t.includes("Votre message") || t.includes("Appuyez de nouveau"), "idle");
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  return run.done;
};

/** An application on an emulated terminal, outside a session, for the view. */
function standalone(columns = 80, rows = 24) {
  const term = fakeTerminal(columns, rows);
  const app = new InteractiveApp({
    terminal: term,
    capabilities: { colors: "truecolor", unicode: "full", synchronizedOutput: false, bracketedPaste: true, reflowOnResize: false },
    settings: { maxFramesPerSecond: 1000, minColumns: 40, retainedLines: 2000, inputMinHeight: 1, inputMaxHeight: 10, inputMaxChars: 100_000, inputWarnChars: 20_000, queueMax: 10, queueAutoSend: true, draftsMax: 10, exitConfirmation: true, exitDoublePressMs: 1500, dialogGuardMs: 0 },
    status: () => ({ mode: "ask", model: "m" }),
    describeCall: () => "",
    transcript: { defaultDetail: "normal", collapseThreshold: 20, showThinking: true, title: "Transcription" },
    render: RENDER,
  });
  app.start();
  return { term, app, screen: () => term.vt.screen().join("\n") };
}

describe("SPEC-IHM-013 modal editing", () => {
  test("SPEC-IHM-013/CA-01 — passing to the command mode changes the indicator and the shape of the cursor", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: MODAL });
    await run.waitFor((t) => t.includes("-- INSERTION --"), "insertion mode shown");
    expect(run.term.vt.cursorShape).toBe(6);
    run.type("bonjour");
    run.type(KEY.escape);
    await run.waitFor((t) => t.includes("-- COMMANDE --"), "command mode shown");
    expect(run.term.vt.cursorShape).toBe(2);
    run.type("i");
    await run.waitFor((t) => t.includes("-- INSERTION --"), "back to insertion");
    expect(run.term.vt.cursorShape).toBe(6);
    await quit(run);
    expect(run.term.vt.cursorShape).toBe(0);
  });

  test("SPEC-IHM-013/CA-02 — SPEC-IHM-013/CA-04 — an operator on a word object deletes only the word; a count repeats a move", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "ok" }]);
    const run = interactive([], ws, { provider: p, userConfig: MODAL });
    await run.waitFor((t) => t.includes("-- INSERTION --"), "modal");
    run.type("un deux trois quatre cinq");
    run.type(KEY.escape);
    run.type("0");
    run.type("w");
    run.type("daw");
    await run.waitFor(() => inputLine(run).startsWith("│ › un trois quatre cinq"), "word deleted");
    run.type("0");
    run.type("3w");
    run.type("x");
    await run.waitFor(() => inputLine(run).startsWith("│ › un trois quatre inq"), "three words further");
    // FA-01: the validation in command mode sends the message; RG-03: the insertion comes back.
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● ok"), "sent");
    expect(JSON.stringify(p.requests[0]!.history)).toContain("un trois quatre inq");
    await run.waitFor((t) => t.includes("-- INSERTION --"), "insertion after sending");
    await quit(run);
  });

  test("SPEC-IHM-013/CA-03 — the global interruption works in command mode, without being an editing command", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([{ hang: true }]), userConfig: MODAL });
    await run.waitFor((t) => t.includes("-- INSERTION --"), "modal");
    run.type("travail long");
    run.type(KEY.escape);
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    run.type(KEY.ctrlC);
    await run.waitFor((t) => t.includes("Interrompu par l'utilisateur."), "interrupted");
    await quit(run);
  });

  test("SPEC-IHM-013/CA-05 — an unknown command leaves the content unchanged", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: MODAL });
    await run.waitFor((t) => t.includes("-- INSERTION --"), "modal");
    run.type("texte intact");
    run.type(KEY.escape);
    run.type("zq");
    run.type("Q");
    await sleep(80);
    expect(inputLine(run)).toStartWith("│ › texte intact ");
    await quit(run);
  });

  test("SPEC-IHM-013/CA-06 — the modal editing switched off during the input keeps the content; the standard editing applies", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: MODAL });
    await run.waitFor((t) => t.includes("-- INSERTION --"), "modal");
    run.type("gardé");
    run.type(KEY.escape);
    run.type("\u001bm"); // Alt+M
    await run.waitFor((t) => !t.includes("-- COMMANDE --") && !t.includes("-- INSERTION --"), "modal off");
    run.type("x");
    await run.waitFor(() => inputLine(run).startsWith("│ › gardx") || inputLine(run).startsWith("│ › gardéx"), "standard typing");
    expect(inputLine(run)).toContain("gard");
    await quit(run);
  });
});

describe("SPEC-IHM-006 full-screen view of the transcript", () => {
  test("SPEC-IHM-006/CA-01 — a session of 500 exchanges can be walked through with the keyboard", () => {
    const { term, app, screen } = standalone();
    for (let i = 1; i <= 500; i++) {
      app.record("user", "", `question ${i}`);
      app.record("model", "", `réponse ${i}`);
    }
    const at = Date.now();
    app.openTranscript();
    expect(screen()).toContain("élément 1000/1000");
    expect(screen()).toContain("réponse 500");
    term.type("\u001b[H"); // Home
    expect(screen()).toContain("élément 1/1000");
    expect(screen()).toContain("question 1");
    term.type("\u001b[6~"); // Page down
    expect(screen()).not.toContain("élément 1/1000");
    term.type(":");
    term.type("2");
    term.type("5");
    term.type("0");
    term.type("\r");
    expect(screen()).toContain("question 250");
    expect(Date.now() - at).toBeLessThan(3000);
    app.stop();
  });

  test("SPEC-IHM-006/CA-02 — searching a term held by a folded result unfolds it and highlights the occurrence", () => {
    const { term, app, screen } = standalone(80, 40);
    app.record("user", "", "lis le journal");
    app.record("result", "read_file", Array.from({ length: 40 }, (_, i) => (i === 30 ? "ligne avec l'aiguille cachée" : `ligne ${i}`)).join("\n"));
    app.openTranscript();
    expect(screen()).toContain("40 lignes repliées");
    expect(screen()).not.toContain("aiguille");
    term.type("/");
    for (const ch of "aiguille") term.type(ch);
    term.type("\r");
    expect(screen()).toContain("ligne avec l'aiguille cachée");
    const row = term.vt.screen().findIndex((l) => l.includes("aiguille"));
    const col = term.vt.screen()[row]!.indexOf("aiguille");
    expect(term.vt.styleAt(row, col)).toContain("7");
    expect(screen()).toContain("1/1 élément");
    app.stop();
  });

  test("SPEC-IHM-006/CA-03 — closing the view gives the previous screen back exactly", () => {
    const { term, app } = standalone();
    app.notice("info", "un avis déjà affiché");
    const before = term.vt.screen();
    app.openTranscript();
    expect(term.vt.screen()).not.toEqual(before);
    term.type("\u001b");
    expect(app.transcriptOpen).toBe(false);
    expect(term.vt.screen()).toEqual(before);
    app.stop();
  });

  test("SPEC-IHM-006/CA-04 — a production in progress goes on while the view is open", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "réponse produite pendant la vue", delayMs: 700 }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    run.type("lance");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    run.type("\u001bt"); // Alt+T
    await run.waitFor(() => run.screen().some((l) => l.includes("Transcription")), "view open");
    await run.waitFor(() => run.screen().join("\n").includes("réponse produite pendant la vue"), "the answer reaches the view");
    run.type("\u001b");
    await run.waitFor((t) => t.includes("● réponse produite pendant la vue"), "flow after closing");
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });

  test("SPEC-IHM-006/CA-05 — a value masked in the flow stays masked in the view", async () => {
    const ws = workspace();
    ws.write("project/env.txt", "API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789\n");
    const path = `${ws.project}/env.txt`.replace(/\\/g, "/");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { text: "lu" }]);
    const run = interactive([], ws, { provider: p, userConfig: { permissions: { allowRules: ["read_file"] } } });
    await run.idle();
    run.type("lis");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● lu"), "done");
    expect(run.all().join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    run.type("\u001bt");
    await run.waitFor(() => run.screen().some((l) => l.includes("Résultat")), "view");
    run.type("e"); // unfold everything
    await run.waitFor(() => run.screen().join("\n").includes("[masqué]"), "masked in the view");
    expect(run.screen().join("\n")).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
    run.type("\u001b");
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });

  test("SPEC-IHM-006/CA-06 — after a resize, the current item stays in view", () => {
    const { term, app, screen } = standalone(80, 12);
    for (let i = 1; i <= 30; i++) app.record("user", "", `élément numéro ${i}`);
    app.openTranscript();
    term.type("\u001b[H");
    for (let i = 0; i < 9; i++) term.type("\t");
    expect(screen()).toContain("élément 10/30");
    term.resize(50, 12);
    expect(screen()).toContain("élément 10/30");
    expect(screen()).toContain("élément numéro 10");
    app.stop();
  });

  test("SPEC-IHM-002/CA-05 — a table wider than the screen scrolls horizontally instead of being deformed", () => {
    const { term, app, screen } = standalone(40, 20);
    app.record("model", "", "| Colonne | Valeur | Commentaire très long pour déborder | FIN-DU-TABLEAU |\n|---|---|---|---|\n| a | 1 | x | y |");
    app.openTranscript();
    expect(screen()).not.toContain("FIN-DU-TABLEAU");
    let presses = 0;
    while (!screen().includes("FIN-DU-TABLEAU") && presses < 10) {
      term.type("[C"); // right
      presses++;
    }
    expect(screen()).toContain("FIN-DU-TABLEAU");
    expect(presses).toBeGreaterThan(0);
    // The table is not deformed: its rows stay on one line each.
    expect(term.vt.screen().filter((l) => l.includes("│")).length).toBe(2);
    app.stop();
  });
});
