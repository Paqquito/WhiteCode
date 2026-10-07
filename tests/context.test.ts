// Context: occupation, full and automatic compaction, local micro-compaction, service-side clearing (SPEC-MOT-010 to 014).
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetLedger } from "../src/engine/budget";
import { compactConversation } from "../src/engine/compaction";
import { ContextManager, type ContextSettings } from "../src/engine/context-manager";
import { ContextMeter } from "../src/engine/context-meter";
import { RunLimits } from "../src/engine/limits";
import { runTurn } from "../src/engine/loop";
import { CLEARED_MARKER } from "../src/engine/micro-compaction";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";
import { isResolveFailure, type ResolvedModel } from "../src/providers/catalog";
import { TranscriptWriter } from "../src/session/transcript";
import { cli, loadCatalog, loadIdentity, testModel, workspace } from "./helpers/env";
import { bench } from "./helpers/engine";
import { startFakeAnthropic, type FakeServer } from "./helpers/fake-anthropic-server";
import type { ScriptedResponse } from "./helpers/scripted-provider";

const signal = () => new AbortController().signal;
const SETTINGS: ContextSettings = {
  autoCompact: { enabled: true, warnRatio: 0.8, urgentRatio: 0.88, triggerRatio: 0.9, maxFailures: 3 },
  microCompact: { enabled: true, triggerRatio: 0.6, keepRecent: 8, idleMinutes: 60 },
  providerContextManagement: { enabled: true, targetTokens: 50_000 },
};
const SUMMARY = "1. Requests and intent: build the report.\n6. User messages: \"go\"\n9. Next step: continue.";

/** Bench with a context manager on a model whose window is `window` tokens. */
function contextBench(script: ScriptedResponse[], options: { window?: number; settings?: Partial<ContextSettings>; model?: ResolvedModel; ledger?: BudgetLedger; clock?: () => number; transcript?: TranscriptWriter } = {}) {
  const model = { ...(options.model ?? testModel("default")), contextWindow: options.window ?? 100_000 };
  const b = bench(script, { deps: { model, ...(options.transcript ? { transcript: options.transcript } : {}) } });
  const meter = new ContextMeter({ model, outputReserveTokens: 1000 });
  const context = new ContextManager(
    meter,
    { ...SETTINGS, ...options.settings },
    {
      provider: b.provider,
      model,
      conversation: b.conversation,
      hooks: NEUTRAL_HOOKS,
      emit: b.deps.emit,
      transcript: options.transcript,
      thinking: b.deps.thinking,
      summaryMaxTokens: 2000,
      ledger: options.ledger,
      pricing: model.pricing,
      rebuildSystem: () => [{ text: "system, new segment", cacheBoundary: true }],
      restoredElements: () => ["Restored: current content of notes.txt"],
    },
    options.clock,
  );
  const deps = { ...b.deps, context, ...(options.ledger ? { limits: new RunLimits({ ledger: options.ledger }) } : {}) };
  return { ...b, deps, meter, context, model };
}

describe("SPEC-MOT-010 occupation", () => {
  test("SPEC-MOT-010/CA-01 — a response with counts: the occupation relies on these counts", async () => {
    const c = contextBench([{ text: "ok", usage: { input: 5000, output: 100 } }]);
    await runTurn(c.deps, "x", signal());
    const o = c.meter.occupation(c.conversation.system, c.conversation.tools, c.conversation.messages, c.conversation.segment);
    expect(o.fromProvider).toBe(true);
    expect(o.tokens).toBe(5100);
    expect(o.effectiveWindow).toBe(99_000);
  });

  test("SPEC-MOT-010/CA-02 — a 40,000-character file added after the last response: about 10,000 more tokens", async () => {
    const c = contextBench([{ text: "ok", usage: { input: 5000, output: 100 } }]);
    await runTurn(c.deps, "x", signal());
    c.conversation.appendToolResults([{ type: "tool_result", callId: "c1", isError: false, content: [{ type: "text", text: "The quick brown fox jumps over the lazy dog. ".repeat(900).slice(0, 40_000) }] }]);
    const o = c.meter.occupation(c.conversation.system, c.conversation.tools, c.conversation.messages, c.conversation.segment);
    expect(o.tokens - 5100).toBeGreaterThanOrEqual(10_000);
    expect(o.tokens - 5100).toBeLessThan(11_000);
  });

  test("SPEC-MOT-010/CA-04 — a model absent from the catalogue: the prudent default window, with a warning in the journal", () => {
    const r = loadCatalog().resolve("never-listed-model", "openai_compatible", loadIdentity(), { unknownContextWindow: 128_000 });
    if (isResolveFailure(r)) throw new Error("unexpected");
    const warnings: string[] = [];
    const meter = new ContextMeter({ model: r, outputReserveTokens: 16_000, warn: (m) => warnings.push(m) });
    expect(meter.effectiveWindow).toBe(112_000);
    expect(warnings[0]).toContain("Taille de contexte du modèle never-listed-model inconnue");
  });
});

describe("SPEC-MOT-011 compaction", () => {
  test("SPEC-MOT-011/CA-01 — a conversation of 100 exchanges compacted: a structured summary in context, everything in the transcript", async () => {
    const ws = workspace();
    const transcript = new TranscriptWriter({ sessionsDir: join(ws.root, "sessions"), projectRealPath: ws.project });
    const script: ScriptedResponse[] = Array.from({ length: 100 }, (_, i) => ({ text: `answer ${i}` }));
    script.push({ text: SUMMARY });
    const c = contextBench(script, { transcript });
    for (let i = 0; i < 100; i++) await runTurn(c.deps, `question ${i}`, signal());
    const outcome = await c.context.compactNow("focus on the report", signal());
    expect(outcome.kind).toBe("compacted");
    // The summary request asked for the structure and the user's focus, and extended the segment (prefix kept).
    const summaryRequest = c.provider.requests[100]!;
    const instruction = summaryRequest.history[summaryRequest.history.length - 1]!;
    expect(JSON.stringify(instruction)).toContain("User messages: every message the user wrote");
    expect(JSON.stringify(instruction)).toContain("focus on the report");
    // New segment: one opening message with the summary and the restored elements, new system instructions.
    expect(c.conversation.segment).toBe(1);
    expect(c.conversation.messages).toHaveLength(1);
    expect(JSON.stringify(c.conversation.messages[0])).toContain("1. Requests and intent");
    expect(JSON.stringify(c.conversation.messages[0])).toContain("Restored: current content of notes.txt");
    expect(c.conversation.system[0]!.text).toBe("system, new segment");
    transcript.close();
    const records = readFileSync(transcript.path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(records.filter((r) => r.type === "user")).toHaveLength(100);
    expect(records.filter((r) => r.type === "compaction")).toHaveLength(1);
    expect(records.find((r) => r.type === "compaction").data.summary).toBe(SUMMARY);
    expect(c.events.some((e) => e.type === "compacted")).toBe(true);
  });

  test("SPEC-MOT-011/CA-03 — an error of the service: the compaction fails and the history is unchanged", async () => {
    const c = contextBench([{ text: "a" }, { error: { kind: "server", status: 500 } }]);
    await runTurn(c.deps, "x", signal());
    const before = JSON.stringify(c.conversation.messages);
    const outcome = await c.context.compactNow(undefined, signal());
    expect(outcome).toMatchObject({ kind: "failed" });
    expect(JSON.stringify(c.conversation.messages)).toBe(before);
    expect(c.conversation.segment).toBe(0);
    // ERR-01: nothing to compact.
    const empty = contextBench([]);
    expect((await empty.context.compactNow(undefined, signal())).kind).toBe("empty");
  });
});

describe("SPEC-MOT-012 automatic compaction", () => {
  const full = (text: string): ScriptedResponse => ({ text, usage: { input: 9_500, output: 100 } });

  test("SPEC-MOT-012/CA-01 — an occupation above the trigger: a compaction takes place before the request is sent", async () => {
    const c = contextBench([full("first"), { text: SUMMARY }, { text: "second" }], { window: 11_000 });
    await runTurn(c.deps, "one", signal());
    const r = await runTurn(c.deps, "two", signal());
    expect(r.finalText).toBe("second");
    expect(c.provider.requests).toHaveLength(3);
    expect(JSON.stringify(c.provider.requests[1]!.history.at(-1))).toContain("the conversation is about to be compacted");
    expect(c.provider.requests[2]!.segment).toBe(1);
    expect(c.events.some((e) => e.type === "warning" && e.message.includes("compaction automatique"))).toBe(true);
  });

  test("SPEC-MOT-012/CA-02 — three consecutive failures: a fourth trigger does not happen and the user is told", async () => {
    const fail: ScriptedResponse = { error: { kind: "invalid_request", status: 400 } };
    const c = contextBench([full("t1"), fail, full("t2"), fail, full("t3"), fail, full("t4"), full("t5")], { window: 11_000 });
    for (const t of ["a", "b", "c", "d", "e"]) await runTurn(c.deps, t, signal());
    expect(c.provider.requests).toHaveLength(8); // 5 answers + 3 failed summaries, none on the 4th and 5th turns
    expect(c.context.failures).toBe(3);
    expect(c.events.filter((e) => e.type === "warning" && e.message === "Compaction automatique suspendue après plusieurs échecs.")).toHaveLength(1);
  });

  test("SPEC-MOT-012/CA-03 — automatic compaction disabled: only the warnings appear", async () => {
    const c = contextBench([full("first"), { text: "second" }], { window: 11_000, settings: { autoCompact: { ...SETTINGS.autoCompact, enabled: false } } });
    await runTurn(c.deps, "one", signal());
    await runTurn(c.deps, "two", signal());
    expect(c.provider.requests).toHaveLength(2);
    expect(c.conversation.segment).toBe(0);
    expect(c.events.filter((e) => e.type === "warning").map((e) => (e as { message: string }).message)[0]).toContain("Contexte occupé à");
  });

  test("SPEC-MOT-012/CA-04 — a cost cap reached while a compaction is needed: refused at admission, the run stops on the limit, no failure counted", async () => {
    const ledger = new BudgetLedger(0.07, "USD");
    const c = contextBench([{ ...full("first"), usage: { input: 9_500, output: 100 } }, { text: "never" }], { window: 11_000, model: testModel("large"), ledger });
    await runTurn(c.deps, "one", signal());
    const r = await runTurn(c.deps, "two", signal());
    expect(r.stopCause).toBe("budget_limit");
    expect(r.message).toContain("compaction nécessaire");
    expect(c.context.failures).toBe(0);
    expect(c.provider.requests).toHaveLength(1);
  });
});

describe("SPEC-MOT-013 local micro-compaction (model without conversation-bound thinking)", () => {
  const reads = (n: number, dir: string): ScriptedResponse[] => Array.from({ length: n }, (_, i) => ({ toolCalls: [{ name: "read_file", input: { path: join(dir, `f${i}.txt`) } }] }));

  /** Files in a folder created before the bench, so that the script can name them. */
  function files(n: number): string {
    const ws = workspace();
    for (let i = 0; i < n; i++) ws.write(`project/f${i}.txt`, `content of file ${i}\n`);
    return ws.project;
  }
  const resultsOf = (history: readonly unknown[]) =>
    (history as Array<{ role: string; parts?: Array<{ type: string; content: Array<{ text: string }> }> }>).flatMap((m) => (m.role === "user" ? (m.parts ?? []).filter((p) => p.type === "tool_result") : []));

  test("SPEC-MOT-013/CA-01 — 20 old reads and the threshold crossed: only the 8 most recent stay intact", async () => {
    const dir = files(20);
    const c = contextBench([...reads(20, dir), { text: "done" }], { settings: { microCompact: { ...SETTINGS.microCompact, triggerRatio: 0.0001 } } });
    await runTurn(c.deps, "read everything", signal());
    const results = resultsOf(c.provider.requests.at(-1)!.history);
    expect(results).toHaveLength(20);
    expect(results.filter((p) => p.content[0]!.text === CLEARED_MARKER)).toHaveLength(12);
    expect(results.slice(12).every((p) => p.content[0]!.text.includes("content of file"))).toBe(true);
    expect(c.events.some((e) => e.type === "micro_compacted")).toBe(true);
  });

  test("SPEC-MOT-013/CA-02 — a request after two hours: the old compactable results are removed", async () => {
    let now = 1_000_000;
    const dir = files(10);
    const c = contextBench([...reads(10, dir), { text: "first done" }, { text: "second" }], { clock: () => now });
    await runTurn(c.deps, "read", signal());
    const beforeIdle = c.provider.requests.length;
    expect(resultsOf(c.provider.requests[beforeIdle - 1]!.history).some((p) => p.content[0]!.text === CLEARED_MARKER)).toBe(false);
    now += 2 * 60 * 60_000;
    await runTurn(c.deps, "again", signal());
    const results = resultsOf(c.provider.requests[beforeIdle]!.history);
    expect(results.filter((p) => p.content[0]!.text === CLEARED_MARKER)).toHaveLength(2);
    expect(c.events.some((e) => e.type === "micro_compacted" && e.reason === "idle")).toBe(true);
  });

  test("TECH — D-12: no local micro-compaction for a model whose history is append-only", async () => {
    const model = { ...testModel("default"), capabilities: { ...testModel("default").capabilities, appendOnlyHistory: true } };
    const c = contextBench([{ text: "a" }], { model, settings: { microCompact: { ...SETTINGS.microCompact, triggerRatio: 0.0001 } } });
    expect(c.context.localMicroCompaction).toBe(false);
  });
});

describe("SPEC-MOT-014 service-side clearing", () => {
  let server: FakeServer | undefined;
  afterEach(() => server?.stop());
  const anthropicConfig = { api: { provider: "anthropic", baseUrl: null } };

  test("SPEC-MOT-014/CA-01 — a model without the capability: no strategy is joined", async () => {
    server = startFakeAnthropic([{ text: "plain" }]);
    const r = await cli(["--non-interactive", "--model", "vendor-optional", "x"], workspace(), { env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: server.url }, userConfig: anthropicConfig });
    expect(r.stdout).toBe("plain\n");
    expect(server.requests[0]!.body["context_management"]).toBeUndefined();
    expect(server.requests[0]!.headers["anthropic-beta"] ?? "").not.toContain("context-management");
  });

  test("SPEC-MOT-014/CA-02 — a rejected strategy: the request is sent again without it and the function is disabled", async () => {
    server = startFakeAnthropic([{ status: 400, errorType: "invalid_request_error" }, { toolUses: [{ id: "t1", name: "read_file", input: { path: "/nowhere.txt" } }] }, { text: "done" }]);
    const r = await cli(["--non-interactive", "--model", "vendor-context", "x"], workspace(), { env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: server.url }, userConfig: anthropicConfig });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("done\n");
    const first = server.requests[0]!;
    expect(first.headers["anthropic-beta"]).toContain("context-management-2025-06-27");
    expect(first.body["context_management"]).toMatchObject({ edits: [{ type: "clear_tool_uses_20250919", trigger: { type: "input_tokens" }, keep: { type: "tool_uses", value: 8 }, clear_tool_inputs: ["write_file", "edit_file", "update_notebook_cell"] }] });
    expect(server.requests[1]!.body["context_management"]).toBeUndefined();
    expect(server.requests[2]!.body["context_management"]).toBeUndefined(); // disabled for the session
  });

  test("TECH — SPEC-MOT-014/EF-02 — with service-side clearing, local micro-compaction is off", () => {
    const model = testModel("vendor-context", "anthropic");
    const meter = new ContextMeter({ model, outputReserveTokens: 1000 });
    const b = bench([]);
    const m = new ContextManager(meter, SETTINGS, { provider: b.provider, model, conversation: b.conversation, hooks: NEUTRAL_HOOKS, emit: () => undefined, thinking: b.deps.thinking, summaryMaxTokens: 1000, rebuildSystem: () => [], restoredElements: () => [] });
    expect(m.serviceClearing).toBe(true);
    expect(m.localMicroCompaction).toBe(false);
    expect(m.strategy()).toMatchObject({ keepToolUses: 8, clearInputsOf: ["write_file", "edit_file", "update_notebook_cell"] });
  });
});

test("TECH — compaction is refused when there is nothing to compact (ERR-01)", async () => {
  const b = bench([]);
  const meter = new ContextMeter({ model: b.deps.model, outputReserveTokens: 1000 });
  const outcome = await compactConversation({ provider: b.provider, model: b.deps.model, conversation: b.conversation, meter, hooks: NEUTRAL_HOOKS, emit: () => undefined, thinking: b.deps.thinking, summaryMaxTokens: 1000, rebuildSystem: () => [], restoredElements: () => [] }, undefined, false, signal());
  expect(outcome).toEqual({ kind: "empty", message: "Rien à compacter." });
});
