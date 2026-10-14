import { expect, test } from "bun:test";
import { TurnAssistance, validSuggestion } from "../src/engine/turn-assistance";

function fixture(replies: string[] = []) {
  let now = 0; const calls: string[] = [], hints: string[] = [], recaps: string[] = [], states: unknown[] = [], summaries: string[] = [], progress: string[] = [];
  const assistance = new TurnAssistance({ now: () => now, sample: async (purpose, _input, signal) => { calls.push(purpose); signal.throwIfAborted(); return replies.shift(); }, redact: text => text.replaceAll("PRIVATE", "[redacted]"), suggestion: value => hints.push(value), recap: value => recaps.push(value), state: value => states.push(value), taskSummary: value => summaries.push(value), progress: value => progress.push(value), recent: () => "Recent exchanges", settings: () => ({ suggestions: true, recap: true, afterMs: 1800000, taskSummary: true, summaryEvery: 2, classify: true, jobWorkspace: true, progress: true, suppressed: false }) });
  return { assistance, calls, hints, recaps, states, summaries, progress, advance: (ms: number) => now += ms };
}
test("SPEC-MOT-028/CA-03 — praise, markup, multiple sentences and destructive requests are rejected", () => {
  for (const value of ["Merci, parfait !", "Thanks!", "**Run tests**", "Run tests. Then commit.", "Delete all files", "rm -rf .", "Je vais le faire."]) expect(validSuggestion(value)).toBeUndefined();
  expect(validSuggestion("Run the relevant tests")).toBe("Run the relevant tests");
});
test("SPEC-MOT-028/CA-02 — planning suppresses generation before the provider is called", async () => {
  const f = fixture(["Run tests"]); await f.assistance.suggest(true); expect(f.calls).toEqual([]);
});
test("TECH — a suggestion completing after a switch to planning is discarded", async () => {
  const f = fixture(); let finish!: (value: string) => void; const settings = f.assistance.options.settings(); let planning = false;
  f.assistance.options.settings = () => ({ ...settings, planning }); f.assistance.options.sample = async () => new Promise<string>(resolve => finish = resolve);
  const pending = f.assistance.suggest(); await Promise.resolve(); planning = true; finish("Run the relevant tests"); await pending; expect(f.hints).toEqual([]);
});
test("SPEC-MOT-030/CA-01 — a thirty-minute absence produces one recap without adding it to history", async () => {
  const f = fixture(["Recent work\nChecks passed\nNext step"]); f.assistance.activity(); f.advance(1800000); await f.assistance.activity(); await f.assistance.activity();
  expect(f.recaps).toEqual(["Recent work\nChecks passed\nNext step"]); expect(f.calls).toEqual(["return_recap"]);
});
test("SPEC-MOT-030/CA-02 — sending a message cancels and discards a late return recap", async () => {
  let resolve!: (value: string) => void; const shown: string[] = [];
  const f = fixture(); f.assistance.options.sample = async () => new Promise<string>(r => resolve = r); f.assistance.options.recap = value => shown.push(value);
  f.advance(1800000); const recap = f.assistance.activity(); await Promise.resolve(); f.assistance.sent(); resolve("Stale recap"); await recap;
  expect(shown).toEqual([]);
});
test("SPEC-MOT-031/CA-01 — three reads produce one masked progress sentence outside the main context", async () => {
  const f = fixture(["Examiner les fichiers PRIVATE."]); await f.assistance.tools(["read_file", "read_file", "read_file"]);
  expect(f.progress).toEqual(["Examiner les fichiers [redacted]."]); expect(f.calls).toEqual(["tool_progress"]);
});
test("SPEC-MOT-043/CA-01 — a classified question writes needs_input and rejects unknown states", async () => {
  const f = fixture([JSON.stringify({ state: "needs_input", summary: "Choisir une option." }), "{\"state\":\"execute\",\"summary\":\"bad\"}"]);
  await f.assistance.classify("Which option?"); await f.assistance.classify("Ignored invalid state"); expect(f.states).toEqual([{ state: "needs_input", summary: "Choisir une option." }]);
});
test("SPEC-MOT-043/CA-02 — no job workspace means no classification call or file", async () => {
  const f = fixture(); const settings = f.assistance.options.settings(); f.assistance.options.settings = () => ({ ...settings, jobWorkspace: false }); await f.assistance.classify("Which option?"); expect(f.calls).toEqual([]); expect(f.states).toEqual([]);
});
test("SPEC-MOT-044/CA-01 — eligible top-level turns refresh the task summary at the configured cadence", async () => {
  const f = fixture(["Current task progress"]); await f.assistance.summarizeTask(); expect(f.summaries).toEqual([]); await f.assistance.summarizeTask(); expect(f.summaries).toEqual(["Current task progress"]);
});
test("SPEC-MOT-044/CA-02 — subagent turns cannot generate a task summary", async () => {
  const f = fixture(); await f.assistance.summarizeTask(true); await f.assistance.summarizeTask(true); expect(f.calls).toEqual([]);
});
test("SPEC-AGT-025/CA-01 — an active background agent gets a recent summary after two minutes", async () => {
  const f = fixture(["Inspecting parser tests"]); let live = true; const shown: string[] = [];
  const tick = f.assistance.agentProgress(() => live, () => "Agent context", value => shown.push(value));
  f.advance(120000); await tick(); expect(shown).toEqual(["Inspecting parser tests"]); live = false; f.advance(120000); await tick(); expect(f.calls).toEqual(["agent_progress"]);
});
test("TECH — ending an agent aborts its outstanding progress request and discards the result", async () => {
  const f = fixture(), owner = new AbortController(); let observed: AbortSignal | undefined;
  f.assistance.options.sample = async (_purpose, _input, signal) => { observed = signal; return new Promise(resolve => signal.addEventListener("abort", () => resolve("Late progress"), { once: true })); };
  const shown: string[] = [], tick = f.assistance.agentProgress(() => !owner.signal.aborted, () => "Agent context", value => shown.push(value), undefined, owner.signal);
  f.advance(120000); const pending = tick(); await Promise.resolve(); owner.abort(); await pending; expect(observed?.aborted).toBe(true); expect(shown).toEqual([]);
});
