// Interactive mode (SPEC-MOD-001), input area (SPEC-IHM-007), queue of messages (SPEC-IHM-011), permission dialog
// (SPEC-IHM-027), on an emulated terminal with the simulated provider.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { HistoryMessage } from "../src/providers/types";
import { projectKey, type TranscriptRecord } from "../src/session/transcript";
import { InteractiveApp } from "../src/interactive/app";
import { literalTriggers } from "../src/interactive/triggers";
import { Editor } from "../src/ui/editor";
import { KeyParser } from "../src/ui/keys";
import { layoutNode, text } from "../src/ui/layout";
import { workspace, type Workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { fakeTerminal } from "./helpers/vterm";

const userTexts = (h: readonly HistoryMessage[]) => h.flatMap((m) => (m.role === "user" ? m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : []));
const lastUser = (p: ScriptedProvider, i: number) => {
  const t = userTexts(p.requests[i]!.history);
  return t[t.length - 1] ?? "";
};
const transcripts = (ws: Workspace) => {
  const dir = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => readFileSync(join(dir, f), "utf8").trim().split("\n").map((l) => JSON.parse(l) as TranscriptRecord));
};

/** Types a message and sends it. */
const send = (run: ReturnType<typeof interactive>, message: string) => {
  run.type(message);
  run.type(KEY.enter);
};
/** Quits from an idle session (with a turn in flight, the exit would ask for a confirmation, EF-05). */
const quit = async (run: ReturnType<typeof interactive>) => {
  run.type(KEY.ctrlU);
  await run.idle();
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  return run.done;
};

describe("SPEC-MOD-001 interactive mode", () => {
  test("SPEC-MOD-001/CA-01 — with a terminal and no automated option, the input area appears and the session stays open", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "Bonjour !" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    expect(run.screen().some((l) => l.startsWith("│ › Votre message"))).toBe(true);
    send(run, "salut");
    await run.waitFor((t) => t.includes("● Bonjour !"), "answer");
    await run.idle();
    expect(run.finished()).toBe(false);
    expect(lastUser(p, 0)).toBe("salut");
    const r = await quit(run);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Pour la reprendre");
  });

  test("SPEC-MOD-001/CA-02 — interrupting a turn gives the hand back within a second, with an interruption marker", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ hang: true }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "travail long");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "activity");
    const at = Date.now();
    run.type(KEY.escape);
    await run.waitFor((t) => t.includes("Interrompu par l'utilisateur."), "interruption marker");
    await run.idle();
    expect(Date.now() - at).toBeLessThan(1000);
    await quit(run);
    const records = transcripts(ws)[0]!;
    expect(records.some((r) => r.type === "system" && r.data["event"] === "turn_end" && r.data["stopCause"] === "interrupted")).toBe(true);
  });

  test("SPEC-MOD-001/CA-03 — SPEC-IHM-011/CA-01 — a message typed during a turn is queued, counted, and sent at the next turn", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "premier", delayMs: 600 }, { text: "second" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "un");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    send(run, "deux");
    await run.waitFor((t) => t.includes("1 message en attente"), "queue indicator");
    expect(p.requests.length).toBe(1);
    await run.waitFor((t) => t.includes("● second"), "second answer");
    expect(lastUser(p, 1)).toBe("deux");
    await quit(run);
  });

  test("SPEC-MOD-001/CA-04 — an initial request is processed, then the session stays interactive", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "réponse initiale" }, { text: "suite" }]);
    const run = interactive(["explique le projet"], ws, { provider: p });
    await run.waitFor((t) => t.includes("● réponse initiale"), "initial answer");
    expect(lastUser(p, 0)).toBe("explique le projet");
    await run.idle();
    expect(run.finished()).toBe(false);
    send(run, "et ensuite ?");
    await run.waitFor((t) => t.includes("● suite"), "next answer");
    await quit(run);
  });

  test("SPEC-MOD-001/CA-05 — after a brutal close, the reopened session holds every finished turn", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "réponse A" }, { text: "réponse B" }]);
    const stop = new AbortController();
    const run = interactive([], ws, { provider: p, signal: stop.signal });
    await run.idle();
    send(run, "question A");
    await run.waitFor((t) => t.includes("● réponse A"), "A");
    await run.idle();
    send(run, "question B");
    await run.waitFor((t) => t.includes("● réponse B"), "B");
    stop.abort(); // the process is killed
    expect((await run.done).code).toBe(130);
    const p2 = new ScriptedProvider([{ text: "réponse C" }]);
    const again = interactive(["--reopen-last"], ws, { provider: p2 });
    await again.waitFor((t) => t.includes("› question A") && t.includes("● réponse B") && t.includes("Session reprise"), "replay");
    await again.idle();
    send(again, "question C");
    await again.waitFor((t) => t.includes("● réponse C"), "C");
    expect(userTexts(p2.requests[0]!.history)).toEqual(["question A", "question B", "question C"]);
    await quit(again);
  });

  test("TECH — SPEC-MOD-001/FA-04, EF-05 — the exit needs two presses; Ctrl+C first clears the input", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("brouillon");
    run.type(KEY.ctrlC);
    await run.idle();
    run.type(KEY.ctrlC);
    await run.waitFor((t) => t.includes("Appuyez de nouveau sur Ctrl+C pour quitter."), "hint");
    expect(run.finished()).toBe(false);
    run.type(KEY.ctrlC);
    expect((await run.done).code).toBe(0);
  });
});

describe("SPEC-IHM-007 input area", () => {
  test("SPEC-IHM-007/CA-01 — SPEC-IHM-007/CA-06 — three lines are sent as three lines; an empty input sends nothing", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "reçu" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    run.type(KEY.enter);
    run.type("   ");
    run.type(KEY.enter);
    await sleep(100);
    expect(p.requests.length).toBe(0);
    run.type(KEY.ctrlU);
    run.type("ligne 1");
    run.type(KEY.altEnter);
    run.type("ligne 2");
    run.type(KEY.altEnter);
    run.type("ligne 3");
    await run.waitFor((t) => t.includes("│   ligne 3"), "three lines in the input");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● reçu"), "answer");
    expect(lastUser(p, 0)).toBe("   ligne 1\nligne 2\nligne 3".trimStart());
    await quit(run);
  });

  test("SPEC-IHM-007/CA-02 — moving by word with double-width characters stays on the real boundaries", () => {
    const ed = new Editor();
    ed.insert("日本語の テキスト abc");
    ed.wordLeft();
    expect(ed.text.slice(ed.caret)).toBe("abc");
    ed.wordLeft();
    expect(ed.text.slice(0, ed.caret).endsWith(" ")).toBe(true);
    ed.wordLeft();
    ed.wordLeft();
    expect(ed.caret).toBe(0);
    ed.wordRight();
    expect([..."日本語の"].length).toBeGreaterThanOrEqual(ed.caretGrapheme);
    // The caret column counts two columns per double-width grapheme.
    ed.finish();
    const laid = layoutNode(text(ed.text, { caret: ed.caretGrapheme }), 40, { unicode: "full", narrow: false });
    expect(laid.cursor).toEqual({ row: 0, col: 8 + 1 + 8 + 1 + 3 });
  });

  test("SPEC-IHM-007/CA-04 — a draft is restored when the session is reopened", async () => {
    const ws = workspace();
    const stop = new AbortController();
    const run = interactive([], ws, { provider: new ScriptedProvider([{ text: "ok" }]), signal: stop.signal });
    await run.idle();
    send(run, "premier message");
    await run.waitFor((t) => t.includes("● ok"), "answer");
    await run.idle();
    run.type("brouillon inachevé");
    await sleep(50);
    stop.abort();
    await run.done;
    const again = interactive(["--reopen-last"], ws, { provider: new ScriptedProvider([]) });
    await again.waitFor((t) => t.includes("│ › brouillon inachevé"), "restored draft");
    await quit(again);
  });

  test("SPEC-IHM-007/CA-05 — undoing the deletion of a word restores the whole word at once", async () => {
    const ed = new Editor();
    for (const c of "un deux trois") ed.insert(c);
    ed.deleteWordBack();
    expect(ed.text).toBe("un deux ");
    ed.undo();
    expect(ed.text).toBe("un deux trois");
    // The typed words form groups: one undo removes the last word typed.
    ed.undo();
    expect(ed.text).toBe("un deux ");
    ed.redo();
    expect(ed.text).toBe("un deux trois");
    // The same through the keys of the input area.
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("alpha beta");
    run.type(KEY.ctrlW);
    await run.waitFor((t) => t.includes("│ › alpha ") && !t.includes("beta"), "word deleted");
    run.type(KEY.ctrlZ);
    await run.waitFor((t) => t.includes("│ › alpha beta"), "word restored");
    run.type(KEY.ctrlU);
    await quit(run);
  });

  test("SPEC-IHM-007/CA-07 — during a turn, typed text is accepted and shown", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([{ text: "fin", delayMs: 500 }]) });
    await run.idle();
    send(run, "lance");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    run.type("pendant le tour");
    await run.waitFor((t) => t.includes("│ › pendant le tour"), "typed during the turn");
    await run.waitFor((t) => t.includes("● fin"), "end");
    run.type(KEY.ctrlU);
    await quit(run);
  });

  test("SPEC-IHM-007/CA-08 — SPEC-IHM-007/CA-11 — SPEC-IHM-007/CA-12 — doubled triggers: //revue and @@config become literal, && is left as is", async () => {
    expect(literalTriggers("voir @@config").text).toBe("voir @config");
    expect(literalTriggers("lancer npm ci && npm test")).toEqual({ text: "lancer npm ci && npm test", changed: false });
    expect(literalTriggers("`a @@b` puis @@c").text).toBe("`a @@b` puis @c");
    expect(literalTriggers("!!important").text).toBe("!important");
    expect(literalTriggers("adresse nom@@exemple.fr").changed).toBe(false);
    const ws = workspace();
    ws.write("project/config", "secret de config");
    const p = new ScriptedProvider([{ text: "a" }, { text: "b" }, { text: "c" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "//revue de code");
    await run.waitFor((t) => t.includes("● a"), "first");
    expect(lastUser(p, 0)).toBe("/revue de code");
    await run.idle();
    send(run, "lancer npm ci && npm test");
    await run.waitFor((t) => t.includes("● b"), "second");
    expect(lastUser(p, 1)).toBe("lancer npm ci && npm test");
    await run.idle();
    run.type("voir @@config");
    // The transformation is shown before sending.
    await run.waitFor((t) => t.includes("Envoyé tel quel : voir @config"), "transformation shown");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● c"), "third");
    expect(lastUser(p, 2)).toBe("voir @config");
    expect(JSON.stringify(p.requests[2]!.history)).not.toContain("secret de config");
    await quit(run);
  });
});

describe("SPEC-IHM-011 queue of messages", () => {
  test("SPEC-IHM-011/CA-02 — two queued messages are sent in order, one per turn", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "r1", delayMs: 600 }, { text: "r2" }, { text: "r3" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "m1");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    send(run, "m2");
    send(run, "m3");
    await run.waitFor((t) => t.includes("2 messages en attente"), "two queued");
    await run.waitFor((t) => t.includes("● r3"), "third answer");
    expect([lastUser(p, 0), lastUser(p, 1), lastUser(p, 2)]).toEqual(["m1", "m2", "m3"]);
    await quit(run);
  });

  test("SPEC-IHM-011/CA-03 — a queued message that is removed is never sent", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "r1", delayMs: 600 }, { text: "r2" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "m1");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    send(run, "à retirer");
    await run.waitFor((t) => t.includes("1 message en attente"), "queued");
    // ↑ from an empty input brings it back; it is then erased.
    run.type(KEY.up);
    await run.waitFor((t) => t.includes("│ › à retirer"), "back in the input");
    run.type(KEY.ctrlU);
    await run.waitFor((t) => t.includes("● r1"), "end of turn");
    await run.idle();
    await sleep(100);
    expect(p.requests.length).toBe(1);
    await quit(run);
  });

  test("SPEC-IHM-011/CA-04 — after an interruption with a queue, nothing is sent and the user is asked", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ hang: true }, { text: "envoyé" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "long");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    send(run, "en attente");
    await run.waitFor((t) => t.includes("1 message en attente"), "queued");
    run.type(KEY.escape);
    await run.waitFor((t) => t.includes("les envoyer maintenant ?"), "question");
    await sleep(350);
    expect(p.requests.length).toBe(1);
    run.type("n");
    await run.idle();
    await sleep(100);
    expect(p.requests.length).toBe(1);
    expect(run.all().join("\n")).toContain("1 message en attente");
    run.type(KEY.altX);
    await quit(run);
  });

  test("SPEC-IHM-011/CA-05 — a stashed draft comes back on request", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("idée à garder");
    run.type(KEY.ctrlS);
    await run.waitFor((t) => t.includes("1 brouillon de côté") && t.includes("│ › Votre message"), "stashed");
    run.type(KEY.altS);
    await run.waitFor((t) => t.includes("│ › idée à garder"), "restored");
    run.type(KEY.ctrlU);
    await quit(run);
  });

  test("SPEC-IHM-011/CA-06 — quitting with queued messages asks for a confirmation that names them", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ hang: true }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "long");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    send(run, "jamais envoyé");
    await run.waitFor((t) => t.includes("1 message en attente"), "queued");
    run.type(KEY.escape);
    await run.waitFor((t) => t.includes("les envoyer maintenant ?"), "question after interruption");
    await sleep(350);
    run.type("n");
    await run.idle();
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.waitFor((t) => t.includes("1 message en attente ne sera pas envoyé"), "exit confirmation");
    expect(run.finished()).toBe(false);
    await sleep(350);
    run.type("o");
    expect((await run.done).code).toBe(0);
  });

  test("SPEC-IHM-011/CA-07 — a reopened session gets its queue back, without sending it", async () => {
    const ws = workspace();
    const stop = new AbortController();
    const p = new ScriptedProvider([{ hang: true }]);
    const run = interactive([], ws, { provider: p, signal: stop.signal });
    await run.idle();
    send(run, "long");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    send(run, "gardé pour plus tard");
    await run.waitFor((t) => t.includes("1 message en attente"), "queued");
    stop.abort();
    await run.done;
    const p2 = new ScriptedProvider([]);
    const again = interactive(["--reopen-last"], ws, { provider: p2 });
    await again.waitFor((t) => t.includes("1 message en attente") && t.includes("1. gardé pour plus tard"), "queue restored");
    await sleep(150);
    expect(p2.requests.length).toBe(0);
    again.type(KEY.altX);
    await quit(again);
  });
});

describe("SPEC-IHM-027 permission dialog", () => {
  test("SPEC-IHM-027/CA-01 — a key pressed as the dialog appears never decides it", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: join(realpathSync(ws.project), "notes.txt"), content: "bonjour\n" } }] }, { text: "écrit" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "écris");
    await run.waitFor((t) => t.includes("Autorisation requise"), "dialog");
    run.type(KEY.enter);
    await sleep(100);
    expect(run.all().join("\n")).toContain("Autorisation requise");
    expect(p.requests.length).toBe(1);
    await sleep(300);
    run.type("1");
    await run.waitFor((t) => t.includes("● écrit"), "approved and written");
    expect(readFileSync(join(ws.project, "notes.txt"), "utf8")).toBe("bonjour\n");
    await quit(run);
  });

  test("SPEC-IHM-027/CA-02 — for a dangerous command, the default choice is « Non »", async () => {
    const term = fakeTerminal(100, 30);
    const app = new InteractiveApp({
      terminal: term,
      capabilities: { colors: "none", unicode: "full", synchronizedOutput: false, bracketedPaste: true, reflowOnResize: false },
      settings: { maxFramesPerSecond: 240, minColumns: 60, retainedLines: 2000, inputMinHeight: 1, inputMaxHeight: 10, inputMaxChars: 100_000, inputWarnChars: 20_000, queueMax: 10, queueAutoSend: true, draftsMax: 10, exitConfirmation: true, exitDoublePressMs: 1500, dialogGuardMs: 0 },
      status: () => ({ mode: "ask", model: "m" }),
      describeCall: () => "",
    });
    app.start();
    const ask = (danger?: string) =>
      app.approvals.request({ callId: "c", toolName: "run_powershell", summary: "Remove-Item -Recurse build", reason: "Confirmation required.", origin: "tool_check", suggestions: [], ...(danger ? { danger } : {}) }, new AbortController().signal);
    const dangerous = ask("The command uses Remove-Item, which always requires a confirmation.");
    await sleep(30);
    const screen = term.vt.screen().join("\n");
    expect(screen).toContain("❯ 2. Non");
    expect(screen).toContain("Action dangereuse");
    term.type("\r");
    expect(await dangerous).toEqual({ answer: "no" });
    const ordinary = ask();
    await sleep(30);
    expect(term.vt.screen().join("\n")).toContain("❯ 1. Oui");
    term.type("\r");
    expect(await ordinary).toEqual({ answer: "yes" });
    app.stop();
  });
});

describe("TECH — keys", () => {
  test("TECH — SPEC-IHM-014/EF-07, SPEC-IHM-010 § 5.1 — sequences, modifiers and a paste split across chunks", () => {
    const k = new KeyParser();
    const names = (data: string) => k.feed(data).map((e) => (e.kind === "paste" ? `paste:${e.text}` : `${e.ctrl ? "C-" : ""}${e.alt ? "M-" : ""}${e.shift && !e.text ? "S-" : ""}${e.name}`));
    expect(names("a\r\u0003\u001b[A\u001b[1;5D\u001b\r\u001b[Z\u007f\u001b[3~")).toEqual(["a", "enter", "C-c", "up", "C-left", "M-enter", "S-tab", "backspace", "delete"]);
    expect(names("\u001b[200~ligne 1\r\nli")).toEqual([]);
    expect(names("gne 2\u001b[20")).toEqual([]);
    expect(names("1~x")).toEqual(["paste:ligne 1\r\nligne 2", "x"]);
    expect(names("\u001b[13;2u")).toEqual(["S-enter"]);
  });
});
