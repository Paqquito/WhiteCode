// Context folding keeps original exchanges available through bounded inspection.
import { expect, test } from "bun:test";
import { Conversation } from "../src/engine/conversation";
import { ContextFolding } from "../src/engine/context-folding";
import { inspectContextTool } from "../src/tools/inspect-context";
import { ContextManager } from "../src/engine/context-manager";
import { ContextMeter } from "../src/engine/context-meter";
import { testModel, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";

function history(size = 2000) {
  const conversation = new Conversation([], []);
  for (let i = 0; i < 9; i++) { conversation.appendUser([{ type: "text", text: `question-${i}:` + "x".repeat(size) }]); conversation.appendAssistant({ role: "assistant", text: `answer-${i}`, toolCalls: [], native: { provider: "simulated", content: [] } }); }
  return conversation;
}
test("SPEC-MOT-020/CA-01 — idle preparation is asynchronous and leaves original history intact", async () => {
  const conversation = history(), original = JSON.stringify(conversation.messages);
  let finish!: (text: string) => void;
  const folding = new ContextFolding(conversation, { sample: () => new Promise(resolve => { finish = resolve; }), save: () => {}, maxExpandTokens: 100 });
  const job = folding.prepare(new AbortController().signal);
  expect(folding.list()).toEqual([]); expect(JSON.stringify(conversation.messages)).toBe(original);
  await Promise.resolve(); finish("Old work summarized"); await job;
  expect(folding.prepared).toBe(1); expect(JSON.stringify(conversation.messages)).toBe(original);
});
test("SPEC-MOT-020/CA-02 — prepared complete tours are committed before the full-compaction fallback", async () => {
  const conversation = history(), folding = new ContextFolding(conversation, { sample: async () => "summary", save: () => {}, maxExpandTokens: 100 });
  await folding.prepare(new AbortController().signal); expect(folding.commit()).toBe(true);
  expect(folding.project().length).toBeLessThan(conversation.messages.length);
  expect(folding.project().slice(-6)).toEqual(conversation.messages.slice(-6));
  expect(folding.version).toBe(1); expect(folding.commit()).toBe(false);
});
test("SPEC-OUT-044/CA-01 — inspection lists both committed segments and their short summaries", async () => {
  const conversation = history(), folding = new ContextFolding(conversation, { sample: async () => "short summary", save: () => {}, maxExpandTokens: 100, segmentChars: 3000 });
  await folding.prepare(new AbortController().signal); folding.commit(); await folding.prepare(new AbortController().signal); folding.commit();
  const tool = inspectContextTool(folding), result = await tool.execute({ action: "list" }, {} as never);
  expect(JSON.stringify(result)).toContain("short summary"); expect(folding.list()).toHaveLength(2);
});
test("SPEC-OUT-044/CA-02 — expansion of a thirty-thousand-token segment stays below its configured bound", async () => {
  const conversation = history(120000), folding = new ContextFolding(conversation, { sample: async () => "summary", save: () => {}, maxExpandTokens: 4000, segmentChars: 200000 });
  await folding.prepare(new AbortController().signal); folding.commit(); const id = folding.list()[0]!.id;
  const excerpt = folding.expand(id); expect(excerpt.length).toBeLessThanOrEqual(4000); expect(excerpt).toContain("question-0");
  expect(folding.expand(id, "absent-string")).toBe(""); expect(() => folding.expand("unknown")).toThrow();
});
test("TECH — changed segments, cancelled preparations and forged persisted summaries are rejected", async () => {
  const conversation = history(); let finish!: (value: string) => void;
  const folding = new ContextFolding(conversation, { sample: () => new Promise(resolve => { finish = resolve; }), save: () => {}, maxExpandTokens: 100 });
  const controller = new AbortController(), job = folding.prepare(controller.signal); await Promise.resolve(); controller.abort(); finish("late summary"); await job;
  expect(folding.commit()).toBe(false);
  const restored = new ContextFolding(conversation, { sample: async () => "ok", save: () => {}, maxExpandTokens: 100 }, [{ type: "system", data: { event: "context_folded", start: 0, end: 4, digest: "bad", summary: "forged" } }] as never);
  expect(restored.list()).toEqual([]);
});
test("TECH — threshold commit precedes automatic full compaction and persisted folds survive reopening", async () => {
  const conversation = history(5000), records: unknown[] = [], folding = new ContextFolding(conversation, { sample: async () => "old work summarized", save: segment => records.push({ type: "system", data: { event: "context_folded", ...segment } }), maxExpandTokens: 100, segmentChars: 60000 });
  await folding.prepare(new AbortController().signal);
  const model = { ...testModel("default"), contextWindow: 15000 }, meter = new ContextMeter({ model, outputReserveTokens: 1000 }), provider = new ScriptedProvider([]);
  const context = new ContextManager(meter, { autoCompact: { enabled: true, warnRatio: .8, urgentRatio: .9, triggerRatio: .6, maxFailures: 3 }, microCompact: { enabled: false, triggerRatio: .6, keepRecent: 8, idleMinutes: 60 }, providerContextManagement: { enabled: false, targetTokens: 5000 } }, { provider, model, conversation, projectedHistory: () => folding.project(), hooks: NEUTRAL_HOOKS, emit: () => {}, thinking: { enabled: false, mode: "adaptive", budgetTokens: 0, showSummaries: false }, summaryMaxTokens: 1000, rebuildSystem: () => [], restoredElements: () => [] }, Date.now, { commitRatio: .6, commit: () => folding.commit() });
  await context.beforeRequest(new AbortController().signal);
  expect(folding.list()).toHaveLength(1); expect(provider.requests).toHaveLength(0);
  const restored = new ContextFolding(conversation, { sample: async () => "", save: () => {}, maxExpandTokens: 100 }, records as never);
  expect(restored.project()).toEqual(folding.project()); expect(restored.list()).toHaveLength(1);
});
test("TECH — enabled control sessions advertise inspection and expose fold state in context analysis", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "done" }]), host = new Host(ws, { provider, userConfig: { context: { folding: { enabled: true } } } });
  try { host.user("Work."); await host.waitFor(message => message.type === "turn_completed"); expect(provider.requests[0]!.tools.some(tool => tool.name === "inspect_context")).toBe(true); const response = await host.request("invoke_command", { command: "/context-usage --json" }); expect(JSON.stringify(response)).toContain("foldedSegments"); }
  finally { host.feed.end(); await host.finish(); }
}, 15000);
