// Supports: SPEC-MOD-029, SPEC-OUT-034, gap E-161.
// Implements: SPEC-MOT-001 (EF-07 structured events), SPEC-MOT-002 (EF-07 per-call events)
// Supports: SPEC-MOD-003 (EF-05 order, EF-08 conversation rebuilt from the events)

import type { ContentPart, ToolResultPart, Usage } from "../providers/types";

export type StopCause =
  | "completed"
  | "refusal"
  | "iteration_limit"
  | "budget_limit"
  | "cost_cap_unverifiable"
  | "duration_limit"
  | "unproductive_loop"
  | "blocked"
  | "interrupted"
  | "error";

export type EngineEvent =
  | { readonly type: "addressed_message"; readonly message: string; readonly status: "normal" | "proactive"; readonly attachments: readonly import("../tools/message-user").AddressedAttachment[] }
  | { readonly type: "notification"; readonly message: string }
  | { readonly type: "token_goal"; readonly consumed: number; readonly goal: number }
  | { readonly type: "turn_started"; readonly sessionId: string }
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  | { readonly type: "user_message"; readonly content: ReadonlyArray<ContentPart | ToolResultPart>; readonly synthetic?: boolean; readonly recordId?: string }
  | { readonly type: "assistant_message"; readonly text: string; readonly toolCalls: ReadonlyArray<{ readonly callId: string; readonly name: string; readonly input: unknown }> }
  | { readonly type: "tool_call"; readonly callId: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_started"; readonly callId: string }
  | { readonly type: "tool_result"; readonly callId: string; readonly isError: boolean; readonly durationMs: number; readonly output: string }
  | { readonly type: "permission"; readonly callId: string; readonly decision: "allow" | "deny"; readonly reason: string; readonly step: number }
  | { readonly type: "warning"; readonly message: string }
  /** Visible wait before a new attempt (SPEC-API-003 EF-04). */
  | { readonly type: "retry"; readonly attempt: number; readonly maxRetries: number; readonly delayMs: number; readonly reason: string }
  /** The partial response already streamed is replaced by a new attempt (SPEC-API-003 FA-01). */
  | { readonly type: "response_restarted" }
  /** Full compaction done (SPEC-MOT-011 step 6: confirmation with the gain). */
  | { readonly type: "compacted"; readonly automatic: boolean; readonly tokensBefore: number; readonly tokensAfter: number }
  /** Old tool results removed locally (SPEC-MOT-013). */
  | { readonly type: "micro_compacted"; readonly removed: number; readonly reason: "threshold" | "idle" }
  /** Unproductive loop detected (SPEC-MOT-046 § 7.2). */
  | { readonly type: "loop_detected"; readonly callId: string; readonly toolName: string; readonly count: number }
  | { readonly type: "turn_completed"; readonly result: TurnResult }
  /** The consumption of one request, by model (SPEC-CMD-016: the cost detailed by model). */
  | { readonly type: "usage"; readonly model: string; readonly usage: Usage; readonly cost?: number };

export interface UsageTotals extends Usage {}

export interface CostTotals {
  /** Cost computed from the usage reported by the provider; undefined when the model has no price (EF-05 of SPEC-API-006). */
  readonly confirmed?: number;
  /** Confirmed costs plus the bounds of calls whose cost is not reliably known (SPEC-MOD-005 § 5.5). */
  readonly conservative?: number;
  /** Reservations of calls still in progress. */
  readonly reserved?: number;
  /** Cost cap of the execution, in the reference currency. */
  readonly cap?: number;
  readonly currency: string;
}

export interface TurnResult {
  readonly stopCause: StopCause;
  readonly message?: string;
  /** English diagnostic for a parent model; the visible message remains in French. */
  readonly modelMessage?: string;
  readonly refusalCategory?: string | null;
  readonly iterations: number;
  readonly usage: UsageTotals;
  readonly cost: CostTotals;
  readonly durationMs: number;
  readonly finalText: string;
  readonly model: string;
}

export type EventSink = (event: EngineEvent) => void;
