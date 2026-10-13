// Supports: SPEC-MOT-021; real command and provider-authoritative totals.
import { expect, test } from "bun:test";
import { analyseContext, renderContextAnalysis } from "../src/commands/context-analysis";
import { Conversation } from "../src/engine/conversation";
import { ContextMeter } from "../src/engine/context-meter";
import { cli, testModel, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-MOT-021/CA-01 — command results occupying thirty percent receive actionable filtering advice", () => {
  const c = new Conversation([], []), meter = new ContextMeter({ model: testModel("small"), outputReserveTokens: 0 });
  c.appendAssistant({ role: "assistant", text: "", toolCalls: [{ name: "run_shell", callId: "shell", input: {} }], native: { provider: "fixture", content: [] } });
  c.appendToolResults([{ type: "tool_result", callId: "shell", isError: false, content: [{ type: "text", text: "x".repeat(Math.ceil(meter.effectiveWindow * .31) * 4) }] }]);
  const report = analyseContext(c, meter, true);
  expect(report.tools[0]!.ratio).toBeGreaterThanOrEqual(.3); expect(renderContextAnalysis(report)).toContain("Filtrer les sorties de commandes");
  expect(report.categories.reduce((n, c) => n + c.tokens, 0)).toBe(report.occupation.tokens);
});

test("SPEC-MOT-021/CA-02 — automated analysis produces a structured document without a model request", async () => {
  const p = new ScriptedProvider([]), r = await cli(["--non-interactive", "/context-usage --json"], workspace(), { provider: p });
  expect(r.code).toBe(0); const report = JSON.parse(r.stdout);
  expect(report.version).toBe(1); expect(report.categories.reduce((n: number, c: { tokens: number }) => n + c.tokens, 0)).toBe(report.occupation.tokens); expect(p.requests).toHaveLength(0);
});

test("TECH — context category rounding conserves the provider's actual occupation", () => {
  const c = new Conversation([{ text: "instructions" }], []), meter = new ContextMeter({ model: testModel("small"), outputReserveTokens: 0 });
  c.appendUser([{ type: "text", text: "message" }]); meter.recordResponse({ inputTokens: 111, outputTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 0 }, true, c.messages.length, c.segment);
  const report = analyseContext(c, meter, false); expect(report.occupation.tokens).toBe(119);
  expect(report.categories.reduce((n, c) => n + c.tokens, 0)).toBe(119); expect(renderContextAnalysis(report)).toContain("context.autoCompact.enabled");
});
