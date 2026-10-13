import { expect, test } from "bun:test";
import { BudgetLedger } from "../src/engine/budget";
import { RunLimits } from "../src/engine/limits";
import { runTurn } from "../src/engine/loop";
import { withCacheDiagnostics } from "../src/providers/cache-diagnostics";
import type { ModelProvider, ModelRequest } from "../src/providers/types";
import { bench } from "./helpers/engine";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-MOT-022/CA-01 — +200k relaunches at 50000 output tokens and stops only near the requested target", async () => {
  const provider = new ScriptedProvider([{ text: "early", usage: { input: 50, output: 50_000 } }, { text: "complete", usage: { input: 50, output: 140_000 } }]);
  const result = await cli(["--non-interactive", "+200k implement the change"], workspace(), { provider }); expect(result.code).toBe(0);
  expect(provider.requests).toHaveLength(2); expect(JSON.stringify(provider.requests[1]?.history)).toContain("50000 of 200000"); expect(result.stderr).toContain("190000 / 200000");
});
test("SPEC-MOT-022/CA-02 — the cost cap stops a token objective before any further request is sent", async () => {
  const b = bench([{ text: "early", usage: { input: 100, output: 50_000 } }, { text: "must not run" }]);
  const ledger = new BudgetLedger(0.01, b.deps.model.currency);
  const pricing = { inputPerMTok: 0, outputPerMTok: 1, cacheReadPerMTok: 0, cacheWritePerMTok: 0, effectiveDate: "2026-10-13", source: "test" };
  const result = await runTurn({ ...b.deps, pricing, limits: new RunLimits({ ledger }), tokenTarget: { enabled: true, completionRatio: 0.9 } }, "+200k do it", new AbortController().signal);
  expect(result.stopCause).toBe("budget_limit"); expect(b.provider.requests).toHaveLength(1);
});

function cacheProvider() {
  let calls = 0;
  const provider: ModelProvider = { id: "test", async *stream() {
    yield { type: "message_complete", stopReason: "end_turn", usage: { inputTokens: calls++ ? 10_000 : 1_000, outputTokens: 1, cacheReadTokens: calls === 1 ? 9_000 : 0, cacheWriteTokens: 0 }, assistant: { role: "assistant", text: "ok", toolCalls: [], native: { provider: "test", content: [] } } };
  } }; return provider;
}
test("SPEC-MOT-034/CA-01 — a lost cache after instruction changes logs only the instruction cause", async () => {
  const b = bench([]), diagnostics: unknown[] = []; const provider = withCacheDiagnostics(cacheProvider(), { maxThreads: 20, log: d => diagnostics.push(d) });
  const request: ModelRequest = { model: b.deps.model, system: [{ text: "secret old instructions" }], tools: [], history: [], maxOutputTokens: 100, thinking: b.deps.thinking, segment: 0 };
  for await (const _ of provider.stream(request, new AbortController().signal)) {}
  for await (const _ of provider.stream({ ...request, system: [{ text: "secret new instructions" }], segment: 1 }, new AbortController().signal)) {}
  expect(diagnostics).toEqual([{ cause: "instructions", lostTokens: 9000, expected: false }]); expect(JSON.stringify(diagnostics)).not.toContain("secret");
});
test("SPEC-MOT-034/CA-02 — two hours of inactivity explain the loss without a cache-break diagnostic", async () => {
  const b = bench([]), diagnostics: unknown[] = []; let time = 0; const provider = withCacheDiagnostics(cacheProvider(), { maxThreads: 1, log: d => diagnostics.push(d), clock: () => time });
  const request: ModelRequest = { model: b.deps.model, system: [], tools: [], history: [], maxOutputTokens: 100, thinking: b.deps.thinking };
  for await (const _ of provider.stream(request, new AbortController().signal)) {} time = 2 * 60 * 60 * 1000;
  for await (const _ of provider.stream(request, new AbortController().signal)) {} expect(diagnostics).toEqual([]);
});
