// Continuity of context, with actual loop requests and persisted projections.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ContextManager } from "../src/engine/context-manager";
import { ContextMeter } from "../src/engine/context-meter";
import { runTurn } from "../src/engine/loop";
import { HistoryPruning } from "../src/engine/history-pruning";
import { historyPruningTool } from "../src/tools/prune-history";
import type { ToolRegistry } from "../src/tools/registry";
import { projectKey } from "../src/session/transcript";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";
import { bench } from "./helpers/engine";
import { cli, testModel, workspace } from "./helpers/env";
import { ScriptedProvider, type ScriptedResponse } from "./helpers/scripted-provider";

function setup(script: ScriptedResponse[], extra: { reactive?: boolean; notices?: boolean; warnRatio?: number } = {}) {
  const b = bench(script); const model = { ...testModel("default"), contextWindow: 100_000 };
  const context = new ContextManager(new ContextMeter({ model, outputReserveTokens: 1000 }), {
    autoCompact: { enabled: false, warnRatio: extra.warnRatio ?? 0.8, urgentRatio: 0.88, triggerRatio: 0.9, maxFailures: 3 },
    microCompact: { enabled: false, triggerRatio: 0.6, keepRecent: 8, idleMinutes: 60 },
    providerContextManagement: { enabled: false, targetTokens: 50_000 },
    reactiveCompact: { enabled: extra.reactive ?? true }, notices: extra.notices ?? true,
  }, { provider: b.provider, model, conversation: b.conversation, hooks: NEUTRAL_HOOKS, emit: b.deps.emit, thinking: b.deps.thinking, summaryMaxTokens: 1000, rebuildSystem: () => b.conversation.system, restoredElements: () => [] });
  return { ...b, context, deps: { ...b.deps, context, model } };
}
const signal = () => new AbortController().signal;

test("SPEC-MOT-016/CA-01 — a size refusal compacts once and replays the outstanding user request", async () => {
  const b = setup([{ text: "previous" }, { error: { kind: "context_too_long", message: "size refusal" } }, { text: "Summary of the previous work." }, { text: "continued" }]);
  await runTurn(b.deps, "first", signal()); const result = await runTurn(b.deps, "pending question", signal());
  expect(result.stopCause).toBe("completed"); expect(b.provider.requests[2]?.purpose).toBe("compaction");
  expect(JSON.stringify(b.provider.requests[3]?.history)).toContain("pending question");
  expect(b.events.some(e => e.type === "warning" && e.message.includes("nouvelle tentative"))).toBe(true);
});
test("SPEC-MOT-016/CA-02 — disabling the option preserves the original size error without a summary call", async () => {
  const b = setup([{ error: { kind: "context_too_long", message: "original size error" } }], { reactive: false });
  expect((await runTurn(b.deps, "question", signal())).message).toBe("original size error"); expect(b.provider.requests).toHaveLength(1);
});
test("SPEC-MOT-018/CA-01 — crossing the warning threshold appends one invisible notice to the next request", async () => {
  const b = setup([{ text: "first", usage: { input: 85_000, output: 1 } }, { text: "second", usage: { input: 85_000, output: 1 } }, { text: "third" }]);
  await runTurn(b.deps, "one", signal()); await runTurn(b.deps, "two", signal()); await runTurn(b.deps, "three", signal());
  const notes = b.provider.requests[2]!.history.filter(m => m.role === "system_note" && m.text.includes("Compaction is approaching")); expect(notes).toHaveLength(1);
  expect(b.events.filter(e => e.type === "user_message").some(e => JSON.stringify(e).includes("Compaction is approaching"))).toBe(false);
});
test("SPEC-MOT-018/CA-02 — the first request after manual compaction carries the completed notice", async () => {
  const b = setup([{ text: "first" }, { text: "A summary." }, { text: "second" }]);
  await runTurn(b.deps, "one", signal()); await b.context.compactNow(undefined, signal()); await runTurn(b.deps, "two", signal());
  expect(JSON.stringify(b.provider.requests[2]?.history)).toContain("Compaction has completed");
});
test("SPEC-OUT-043/CA-01 — pruning a 20000-token result changes the next request while retaining the raw history", async () => {
  const b = bench([]); const path = join(b.ws.project, "large.txt"), raw = ("witness ".repeat(10) + "\n").repeat(1000); writeFileSync(path, raw);
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path }, id: "read1" }] }, { toolCalls: [{ name: "prune_history", input: { message_ids: ["m3"] } }] }, { text: "done" }]);
  const pruning = new HistoryPruning(b.conversation, 15_000); (b.deps.executor.registry as ToolRegistry).addStatic(historyPruningTool(pruning) as never);
  b.conversation.extendTools([{ name: "prune_history", description: "Prune", inputSchema: historyPruningTool(pruning).inputSchema }]);
  await runTurn({ ...b.deps, provider, projectHistory: request => pruning.decorate(request) }, "read and prune", signal());
  expect(JSON.stringify(provider.requests[2]?.history)).not.toContain("witness"); expect(JSON.stringify(provider.requests[2]?.history)).toContain("Pruned result");
  const result = b.toolResults().find(r => r.callId === "read1"); expect(result?.isError).toBe(false); expect(result?.content[0]?.text?.length).toBeGreaterThan(80_000);
});
test("SPEC-OUT-043/CA-02 — a user message cannot be pruned and the tool explains the ignored identifier", async () => {
  const b = bench([{ toolCalls: [{ name: "prune_history", input: { message_ids: ["m1"] } }] }, { text: "done" }]);
  const pruning = new HistoryPruning(b.conversation, 15_000); const tool = historyPruningTool(pruning); (b.deps.executor.registry as ToolRegistry).addStatic(tool as never); b.conversation.extendTools([{ name: tool.name, description: "Prune", inputSchema: tool.inputSchema }]);
  await runTurn({ ...b.deps, projectHistory: r => pruning.decorate(r) }, "keep my words", signal());
  expect(JSON.stringify(b.toolResults())).toContain("ignored"); expect(JSON.stringify(b.provider.requests[1]?.history)).toContain("keep my words");
});
test("SPEC-MOT-019/CA-01 — growth beyond the configured step produces a pruning reminder on the real CLI request", async () => {
  const ws = workspace(), provider = new ScriptedProvider([request => {
    // Keep the reported baseline consistent with the actual request as the tool catalogue grows.
    const input = new ContextMeter({ model: request.model, outputReserveTokens: 0 }).occupation(request.system, request.tools, request.history, request.segment ?? 0).tokens;
    return { usage: { input, output: 10 }, toolCalls: [{ name: "read_file", input: { path: join(ws.project, "a.txt") } }] };
  }, { text: "done" }]); writeFileSync(join(ws.project, "a.txt"), "a ".repeat(1000));
  const run = await cli(["--non-interactive", "read it", "--approval-mode", "no_prompt"], ws, { provider, userConfig: { context: { pruning: { enabled: true, nudgeEveryTokens: 100 }, microCompact: { enabled: false } } } }); expect(run.stderr).toBe(""); expect(run.code).toBe(0);
  expect(JSON.stringify(provider.requests[1]?.history)).toContain("prune_history"); expect(provider.requests[0]?.tools.some(t => t.name === "prune_history")).toBe(true);
});
test("TECH — pruning resets the growth baseline and never reintroduces a pruned body into compaction", async () => {
  const b = setup([{ text: "A summary." }]); b.conversation.appendUser([{ type: "text", text: "keep" }]);
  b.conversation.appendAssistant({ role: "assistant", text: "", native: { provider: "simulated", content: [] }, toolCalls: [{ callId: "old", name: "read_file", input: { path: "old.txt" } }] });
  b.conversation.appendToolResults([{ type: "tool_result", callId: "old", isError: false, content: [{ type: "text", text: "private-obsolete-body ".repeat(1000) }] }]);
  const pruning = new HistoryPruning(b.conversation, 100); expect(pruning.notices(1000)).toEqual([]); expect(pruning.notices(1200)).toHaveLength(1);
  expect(pruning.prune(["m3"]).pruned).toEqual(["m3"]); expect(pruning.notices(1100)).toEqual([]); expect(pruning.notices(1150)).toEqual([]);
  const model = b.deps.model, context = new ContextManager(b.context.meter, b.context.settings, { provider: b.provider, model, conversation: b.conversation, projectedHistory: () => pruning.history(), hooks: NEUTRAL_HOOKS, emit: b.deps.emit, thinking: b.deps.thinking, summaryMaxTokens: 1000, rebuildSystem: () => b.conversation.system, restoredElements: () => [] });
  expect((await context.compactNow(undefined, signal())).kind).toBe("compacted"); expect(JSON.stringify(b.provider.requests[0]?.history)).not.toContain("private-obsolete-body");
});
test("SPEC-MOT-019/CA-02 — after closing and reopening, the same pruning projection is applied and the transcript keeps the witness", async () => {
  const ws = workspace(); writeFileSync(join(ws.project, "a.txt"), "original-witness".repeat(100));
  const config = { context: { pruning: { enabled: true }, microCompact: { enabled: false } } };
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "a.txt") }, id: "r1" }] }, request => {
    const result = request.history.find(m => m.role === "user" && m.parts.some(p => p.type === "tool_result" && p.callId === "r1"));
    if (!result?.contextId) throw new Error("missing stable identifier"); return { toolCalls: [{ name: "prune_history", input: { message_ids: [result.contextId] } }] };
  }, { text: "done" }]);
  const id = "11111111-1111-4111-8111-111111111111";
  expect((await cli(["--non-interactive", "read and prune", "--assign-session-id", id, "--approval-mode", "no_prompt"], ws, { provider, userConfig: config })).code).toBe(0);
  const transcript = readFileSync(join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)), `${id}.jsonl`), "utf8"); expect(transcript).toContain("original-witness");
  const reopened = new ScriptedProvider([{ text: "resumed" }]); const resumed = await cli(["--non-interactive", "continue", `--reopen=${id}`, "--approval-mode", "no_prompt"], ws, { provider: reopened, userConfig: config }); expect(resumed.stderr).toBe(""); expect(resumed.code).toBe(0);
  expect(JSON.stringify(reopened.requests[0]?.history)).toContain("Pruned result"); expect(JSON.stringify(reopened.requests[0]?.history)).not.toContain("original-witness");
});
