// Simulated provider for engine tests. It replays scripted responses and checks, on every request,
// that the history of the segment is append-only (decision D-12): request n+1 must extend request n; its tool list
// may only grow by appending.

import { ProviderError, type HistoryMessage, type ModelEvent, type ModelProvider, type ModelRequest, type ProviderErrorKind, type StopReason, type ToolCall } from "../../src/providers/types";

export interface ScriptedResponse {
  readonly text?: string;
  readonly toolCalls?: ReadonlyArray<{ name: string; input: unknown; id?: string }>;
  readonly stopReason?: StopReason;
  /** Delay before the response completes, in milliseconds. */
  readonly delayMs?: number;
  /** Never completes until aborted. */
  readonly hang?: boolean;
  readonly usage?: { input: number; output: number };
  /** The provider sends no usage information. */
  readonly noUsage?: boolean;
  /** Fails after the text and the tool calls (a partial response), with this provider error. */
  readonly error?: { readonly kind: ProviderErrorKind; readonly retryAfterMs?: number; readonly status?: number };
}

/** A response, or a function of the request that gives it (a value known only during the run, such as an id). */
export type ScriptStep = ScriptedResponse | ((request: ModelRequest) => ScriptedResponse);

export class PrefixViolation extends Error {}

let counter = 0;

export class ScriptedProvider implements ModelProvider {
  readonly id = "simulated";
  readonly requests: ModelRequest[] = [];
  readonly #script: ScriptStep[];
  /** Responses of the sub-agents, when they run alongside the main agent (background agents). */
  readonly #agents: ScriptStep[] | undefined;

  constructor(script: ScriptStep[], agents?: ScriptStep[]) {
    this.#script = [...script];
    this.#agents = agents ? [...agents] : undefined;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    // Main requests of a segment extend each other; a new segment starts afresh; a side request (compaction) is only checked against the main one.
    // A sub-agent has its own sequence of requests.
    const previous = [...this.requests].reverse().find((r) => (r.purpose ?? "main") === (request.purpose === "subagent" ? "subagent" : "main") && r.agent === request.agent);
    if (previous && (previous.segment ?? 0) === (request.segment ?? 0)) assertPrefix(previous, request);
    this.requests.push(structuredClone(request));
    const queue = request.purpose === "subagent" && this.#agents ? this.#agents : this.#script;
    const next = queue.shift() ?? { text: "done" };
    const step = typeof next === "function" ? next(request) : next;
    if (step.hang) {
      await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { kind: "aborted" })), { once: true }));
    }
    if (step.text) yield { type: "text_delta", text: step.text };
    const calls: ToolCall[] = (step.toolCalls ?? []).map((c) => ({ callId: c.id ?? `call_${++counter}`, name: c.name, input: c.input }));
    for (const call of calls) yield { type: "tool_call", call };
    // A provider honours the abort signal (ModelProvider): the delay ends at an interruption.
    if (step.delayMs) {
      await new Promise<void>((r) => {
        const timer = setTimeout(r, step.delayMs);
        signal.addEventListener("abort", () => (clearTimeout(timer), r()), { once: true });
      });
    }
    if (signal.aborted) throw new ProviderError("aborted", "aborted");
    if (step.error) throw new ProviderError(step.error.kind, `simulated ${step.error.kind}`, step.error.status, step.error.retryAfterMs);
    const native = [
      { type: "thinking", thinking: "", signature: `sig-${counter}` },
      ...(step.text ? [{ type: "text", text: step.text }] : []),
      ...calls.map((c) => ({ type: "tool_use", id: c.callId, name: c.name, input: c.input })),
    ];
    yield {
      type: "message_complete",
      stopReason: step.stopReason ?? (calls.length > 0 ? "tool_use" : "end_turn"),
      usage: step.noUsage ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } : { inputTokens: step.usage?.input ?? 100, outputTokens: step.usage?.output ?? 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      usageReported: !step.noUsage,
      assistant: { role: "assistant", text: step.text ?? "", toolCalls: calls, native: { provider: "simulated", content: native } },
    };
  }
}

function assertPrefix(previous: ModelRequest, next: ModelRequest): void {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(previous.system, next.system)) throw new PrefixViolation("system instructions changed within a segment");
  // Tools may only be appended within a segment (connector tools, loaded deferred tools).
  if (!same(previous.tools, next.tools.slice(0, previous.tools.length))) throw new PrefixViolation("tool list changed within a segment");
  const prev: readonly HistoryMessage[] = previous.history;
  if (next.history.length < prev.length) throw new PrefixViolation("history shrank");
  for (let i = 0; i < prev.length; i++) {
    if (!same(prev[i], next.history[i])) throw new PrefixViolation(`history message ${i} was modified`);
  }
}
