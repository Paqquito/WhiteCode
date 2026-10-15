// Implements: SPEC-API-001 (EF-01 common interface, EF-02 capability matrix), gap E-032 (neutral history, native assistant content)
// Provider-neutral request and event model. The engine depends only on these types, never on a provider protocol.

import type { ApiEffort, ResolvedModel } from "./catalog";

export interface TextPart {
  readonly type: "text";
  readonly text: string;
}

export interface ImagePart {
  readonly type: "image";
  readonly mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  readonly dataBase64: string;
}

export type ContentPart = TextPart | ImagePart;

export interface ToolResultPart {
  readonly type: "tool_result";
  readonly callId: string;
  readonly isError: boolean;
  readonly content: readonly ContentPart[];
}

export interface ToolCall {
  readonly callId: string;
  readonly name: string;
  readonly input: unknown;
}

export type HistoryMessage = (
  | { readonly role: "user"; readonly parts: ReadonlyArray<ContentPart | ToolResultPart> }
  /** Operator note appended to the history (reminder, mode change): never removed (decision D-12). */
  | { readonly role: "system_note"; readonly text: string }
  | {
      readonly role: "assistant";
      readonly text: string;
      readonly toolCalls: readonly ToolCall[];
      /** Provider-native content, echoed back verbatim so that thinking blocks stay valid (D-12). */
      readonly native: { readonly provider: string; readonly content: unknown };
    }) & { readonly contextId?: string };

export interface SystemBlock {
  readonly text: string;
  /** True for the last block of the stable part: the cache boundary (SPEC-MOT-003 EF-02). */
  readonly cacheBoundary?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ThinkingRequest {
  readonly enabled: boolean;
  readonly mode: "adaptive" | "budget";
  readonly budgetTokens: number;
  readonly showSummaries: boolean;
}

export interface ModelRequest {
  readonly serviceOptions?: { readonly service_tier: string };
  /** Supports: SPEC-CMD-084. A deliberate prefix change, excluded from cache anomaly counts. */
  readonly intentionalCacheReset?: boolean;
  readonly model: ResolvedModel;
  readonly system: readonly SystemBlock[];
  readonly tools: readonly ToolDefinition[];
  readonly history: readonly HistoryMessage[];
  readonly maxOutputTokens: number;
  readonly thinking: ThinkingRequest;
  /** Product effort level, already mapped to a level the model accepts, or undefined (SPEC-MOT-025). */
  readonly effort?: ApiEffort;
  /** Segment of the conversation (D-12): within a segment, each main request extends the previous main request. */
  readonly segment?: number;
  /** A side request (summary of a compaction) branches off the segment; it is not a step of the main sequence. */
  readonly purpose?: "main" | "compaction" | "subagent" | "side";
  /** The sub-agent sending a request of purpose `subagent`: its own sequence of requests (SPEC-AGT-001). */
  readonly agent?: string;
  /** The session the request belongs to: a session that replaces another (`/clear`) starts a new sequence. Never sent. */
  readonly conversationId?: string;
  /** Service-side clearing of old tool results, for a model with the `contextEditing` capability (SPEC-MOT-014). */
  readonly contextEditing?: ContextEditingStrategy;
}

/** Neutral strategy of service-side clearing (SPEC-MOT-014); each adapter translates it into its protocol. */
export interface ContextEditingStrategy {
  /** Input size from which old tool results are cleared. */
  readonly triggerTokens: number;
  /** Recent tool uses always kept. */
  readonly keepToolUses: number;
  /** Minimum volume cleared each time (gap E-061). */
  readonly clearAtLeastTokens?: number;
  /** Tools whose call inputs may be cleared too (writes, § 5.1). */
  readonly clearInputsOf: readonly string[];
}

export type StopReason = "end_turn" | "tool_use" | "max_tokens" | "refusal" | "pause_turn" | "other";

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
}

export type ModelEvent =
  | { readonly type: "text_delta"; readonly text: string }
  | { readonly type: "thinking_delta"; readonly text: string }
  /** A tool call whose block is complete (its input may still be invalid and must be validated). */
  | { readonly type: "tool_call"; readonly call: ToolCall }
  | {
      readonly type: "message_complete";
      readonly stopReason: StopReason;
      readonly refusalCategory?: string | null;
      readonly usage: Usage;
      /** False when the provider sent no usage information: the cost is then unknown (SPEC-MOD-005 CA-11). */
      readonly usageReported?: boolean;
      readonly serviceCostMultiplier?: number;
      /** Service-side clearing: applied edits, or the strategy was rejected and the request sent again without it (ERR-01 of SPEC-MOT-014). */
      readonly contextEditing?: { readonly rejected?: boolean; readonly clearedToolUses?: number; readonly clearedInputTokens?: number };
      readonly assistant: Extract<HistoryMessage, { role: "assistant" }>;
      readonly providerRequestId?: string;
    };

export type ProviderErrorKind =
  | "authentication"
  | "permission"
  | "rate_limit"
  | "overloaded"
  | "server"
  | "connection"
  | "timeout"
  | "idle_timeout"
  | "context_too_long"
  | "invalid_request"
  | "not_found"
  | "aborted"
  | "malformed_response";

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
    readonly providerRequestId?: string,
  ) {
    super(message);
  }
}

export interface ModelProvider {
  readonly id: string;
  /** Optional anonymous connection warmup; never blocks initialization (SPEC-API-022). */
  preconnect?(): void;
  /** Streams the response; throws ProviderError. Implementations must honour the abort signal. */
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent>;
}
