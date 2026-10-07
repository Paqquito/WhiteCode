// Implements: SPEC-MOD-003 (§ 5.2 formats `text`, `json` and `jsonl` closing, EF-07, EF-10, FA-03, CA-03), SPEC-MOD-002 (EF-03, RG-02, § 7.3), decision D-03
// Supports: gaps E-035 (exit code of a refusal), E-037 (`turns` and `iterations`), E-050 (several input messages)

import { ExitCode, type ExitCodeValue } from "../cli/exit-codes";
import type { StopCause, TurnResult } from "../engine/events";

export type ResultFormat = "text" | "json" | "jsonl";

export function exitCodeFor(cause: StopCause, bySignal: boolean): ExitCodeValue {
  switch (cause) {
    case "completed":
      return ExitCode.Success;
    case "iteration_limit":
    case "budget_limit":
    case "cost_cap_unverifiable":
    case "duration_limit":
    case "unproductive_loop":
      return ExitCode.Limit;
    case "blocked":
      return ExitCode.BlockedByPolicy;
    case "interrupted":
      return bySignal ? ExitCode.Interrupted : ExitCode.ExecutionError;
    case "refusal":
    case "error":
      return ExitCode.ExecutionError;
  }
}

export interface RunSummary {
  readonly sessionId: string;
  readonly result: TurnResult;
  readonly exitCode: ExitCodeValue;
  /** Turns of the run: one per input message. */
  readonly turns: number;
}

/** Totals of several turns: sums of iterations, usage, cost and duration; answer and cause of the last one. */
export function combineResults(results: readonly TurnResult[]): TurnResult {
  const last = results[results.length - 1]!;
  const sum = (f: (r: TurnResult) => number) => results.reduce((n, r) => n + f(r), 0);
  const costs = results.map((r) => r.cost.confirmed);
  return {
    ...last,
    iterations: sum((r) => r.iterations),
    durationMs: sum((r) => r.durationMs),
    usage: {
      inputTokens: sum((r) => r.usage.inputTokens),
      outputTokens: sum((r) => r.usage.outputTokens),
      cacheReadTokens: sum((r) => r.usage.cacheReadTokens),
      cacheWriteTokens: sum((r) => r.usage.cacheWriteTokens),
    },
    cost: { currency: last.cost.currency, confirmed: costs.every((c) => c !== undefined) ? costs.reduce((n, c) => n! + c!, 0) : undefined },
  };
}

/** Closing information: the `json` document and the `jsonl` closing event carry the same fields (EF-07). */
export function closingFields(s: RunSummary): Record<string, unknown> {
  const r = s.result;
  return {
    result: r.finalText,
    haltReason: r.stopCause,
    ...(r.message ? { message: r.message } : {}),
    ...(r.refusalCategory !== undefined ? { refusalCategory: r.refusalCategory } : {}),
    exitCode: s.exitCode,
    turns: s.turns,
    iterations: r.iterations,
    elapsedMs: r.durationMs,
    model: r.model,
    usage: r.usage,
    // EF-10: confirmed, conservative and reserved costs are distinct; no reservation exists without a cap (increment 4).
    cost: {
      currency: r.cost.currency,
      confirmed: r.cost.confirmed ?? null,
      conservative: r.cost.conservative ?? r.cost.confirmed ?? null,
      reserved: r.cost.reserved ?? 0,
      ...(r.cost.cap !== undefined ? { cap: r.cost.cap } : {}),
      known: r.cost.confirmed !== undefined,
    },
  };
}

/** Single structured document of the `json` format. */
export function jsonDocument(s: RunSummary): Record<string, unknown> {
  return { type: "result", sessionId: s.sessionId, ...closingFields(s) };
}

/** Text written on the standard output (EF-03). In `text`, a failure leaves the output empty (FA-03). */
export function renderResult(format: Exclude<ResultFormat, "jsonl">, s: RunSummary): string {
  if (format === "json") return `${JSON.stringify(jsonDocument(s))}\n`;
  if (s.result.stopCause === "error" || s.result.stopCause === "blocked") return "";
  return s.result.finalText.endsWith("\n") || s.result.finalText === "" ? s.result.finalText : `${s.result.finalText}\n`;
}
