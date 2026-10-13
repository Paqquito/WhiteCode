import { expect, test } from "bun:test";
import { InteractiveApp, type AppOptions } from "../src/interactive/app";
import { fakeTerminal } from "./helpers/vterm";
import { sleep } from "./helpers/interactive";
import { interactive, KEY } from "./helpers/interactive";
import { workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readTranscript, projectKey } from "../src/session/transcript";
import { activeChain } from "../src/session/sessions";

function appForActions(copy: (text: string) => Promise<boolean>, edit = async () => {}, extra: Partial<AppOptions> = {}) {
  const term = fakeTerminal(100, 30);
  const app = new InteractiveApp({ terminal: term, capabilities: { colors: "truecolor", unicode: "full", synchronizedOutput: false, bracketedPaste: true, reflowOnResize: false },
    settings: { maxFramesPerSecond: 1000, minColumns: 40, retainedLines: 2000, inputMinHeight: 1, inputMaxHeight: 10, inputMaxChars: 100_000, inputWarnChars: 20_000, queueMax: 10, queueAutoSend: true, draftsMax: 10, exitConfirmation: true, exitDoublePressMs: 1500, dialogGuardMs: 0 },
    status: () => ({ mode: "ask", model: "fixture" }), describeCall: () => "", messageActions: { enabled: true, copy, edit }, ...extra });
  app.start(); return { term, app, screen: () => term.vt.screen().join("\n") };
}

test("SPEC-IHM-017/CA-01 — the selected shell call copies its exact principal element", async () => {
  const copied: string[] = [], { term, app } = appForActions(async text => { copied.push(text); return true; });
  const command = 'printf "%s\\n" "exact command"';
  try { app.record("tool", "run_shell", JSON.stringify({ command }), { primary: command }); app.openTranscript(); term.type("s"); term.type("y"); await sleep(25); expect(copied).toEqual([command]); }
  finally { app.stop(); }
});

test("SPEC-IHM-017/CA-02 — editing an earlier user message waits for confirmation before restoration", async () => {
  let restored = 0; const { term, app, screen } = appForActions(async () => true, async () => { restored++; });
  try {
    app.record("user", "", "Earlier request"); app.record("model", "", "Later reply"); app.openTranscript(); term.type("s"); term.type("\u001b[A"); term.type("m");
    await sleep(25); expect(screen()).toContain("Reprendre"); expect(restored).toBe(0); term.type("n"); await sleep(25); expect(restored).toBe(0);
    app.openTranscript(); term.type("s"); term.type("\u001b[A"); term.type("m"); await sleep(25); term.type("o"); await sleep(25); expect(restored).toBe(1);
  } finally { app.stop(); }
});

test("SPEC-IHM-034/CA-01 — copying a fenced code block in full-screen view returns only its original code", async () => {
  const copied: string[] = [], { term, app } = appForActions(async text => { copied.push(text); return true; });
  try {
    app.record("model", "", "Explanation\n```ts\nconst value = 1;\n  keepIndent();\n```\nAfter"); app.openTranscript(); term.type("s"); term.type("a"); term.type("2"); await sleep(25);
    expect(copied).toEqual(["const value = 1;\n  keepIndent();\n"]); expect(copied[0]).not.toMatch(/[│┌┐└┘]/);
  } finally { app.stop(); }
});

test("SPEC-IHM-005/CA-05 — a file deletion is explicit and requires a second affirmative decision", async () => {
  const { term, app, screen } = appForActions(async () => true); let answer: unknown;
  try {
    const decision = app.approvals.request({ callId: "deletion", toolName: "fixture_delete", summary: "Delete fixture.txt", reason: "Deletion requires confirmation.", origin: "tool_check", suggestions: [], change: { path: "fixture.txt", before: "original\n" } }, new AbortController().signal).then(value => { answer = value; return value; });
    expect(screen()).toContain("Suppression"); term.type("1"); await sleep(25); expect(answer).toBeUndefined(); expect(screen()).toContain("Confirmer la suppression"); term.type("2"); expect(await decision).toMatchObject({ answer: "no" });
  } finally { app.stop(); }
});

test("TECH — confirmed message editing branches the real conversation while keeping later archive records", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ text: "First response." }, { text: "Second response." }, { text: "Edited response." }]);
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("First request."); run.type(KEY.enter); await run.waitFor(text => text.includes("First response.")); await sleep(60);
    run.type("Second request."); run.type(KEY.enter); await run.waitFor(text => text.includes("Second response.")); await sleep(60);
    run.type("\u001bt"); run.type("s"); run.type(KEY.up); run.type("m"); await run.waitFor(text => text.includes("Reprendre la conversation"));
    await sleep(380); run.type("o"); await run.waitFor(() => run.screen().join("\n").includes("Second request."));
    expect(provider.requests).toHaveLength(2); run.type(KEY.ctrlU); run.type("Edited request."); run.type(KEY.enter); await run.waitFor(text => text.includes("Edited response."));
    const history = JSON.stringify(provider.requests[2]!.history); expect(history).toContain("First response."); expect(history).toContain("Edited request."); expect(history).not.toContain("Second response."); expect(history).not.toContain("Second request.");
    const dir = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project))), path = join(dir, readdirSync(dir).find(name => name.endsWith(".jsonl"))!);
    const records = readTranscript(path).records; expect(records.some(record => record.data["text"] === "Second response.")).toBe(true);
    expect(activeChain(records).chain.some(record => record.data["text"] === "Second response.")).toBe(false); expect(activeChain(records).broken).toBe(false);
  } finally { controller.abort(); await run.done; }
});

test("TECH — unavailable clipboard displays the entire selected text for manual copying", async () => {
  const { term, app } = appForActions(async () => false);
  try { app.record("model", "", "First manual copy line.\n".repeat(40) + "Last manual copy line."); app.openTranscript(); term.type("s"); term.type("y"); await sleep(30); expect(app.transcriptOpen).toBe(false); expect(term.vt.all().join("\n")).toContain("Last manual copy line."); }
  finally { app.stop(); }
});

test("TECH — a new permission preempts a file selector without replacing the draft", async () => {
  const { term, app, screen } = appForActions(async () => true, undefined, { fileBrowser: { debounceMs: 0, matches: () => [{ path: "fixture.ts", preview: "code", language: "ts" }] } });
  try {
    term.type("Existing draft."); const opening = app.openFiles(); await sleep(30); expect(screen()).toContain("Ouverture rapide");
    const decision = app.approvals.request({ callId: "preempt", toolName: "fixture", summary: "Pending", reason: "Approval required.", origin: "tool_check", suggestions: [] }, new AbortController().signal);
    await opening; expect(screen()).not.toContain("Ouverture rapide"); expect(screen()).toContain("Existing draft."); term.type("2"); expect(await decision).toMatchObject({ answer: "no" });
  } finally { app.stop(); }
});

test("TECH — an editor finishing after application shutdown cannot restore raw mode or persist a late draft", async () => {
  let release!: (value: string) => void, writes = 0;
  const completion = new Promise<string>(resolve => { release = resolve; });
  const { term, app } = appForActions(async () => true, undefined, { externalEditor: () => completion, onInputState: () => { writes++; } });
  const raw: boolean[] = [], original = term.setRawMode; term.setRawMode = on => { raw.push(on); original(on); };
  const work = app.editDraft(); expect(raw.at(-1)).toBe(false); app.stop(); release("Late draft"); await work;
  expect(raw.at(-1)).toBe(false); expect(writes).toBe(0);
});
