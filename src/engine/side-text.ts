// Implements: SPEC-MOD-005 (CA-18, admission of metadata requests).
// Supports: SPEC-SES-008 (CA-01, asynchronous title), gap E-162.
import { costOf, requestBound, type BudgetLedger } from "./budget";
import type { ModelPricing, ResolvedModel } from "../providers/catalog";
import type { ModelProvider, ModelRequest, Usage, HistoryMessage, ToolCall } from "../providers/types";

/** A progress fork may snapshot an agent waiting for tools; only the fork receives explicit pending results. */
function branchHistory(messages: readonly HistoryMessage[]): HistoryMessage[] {
  const history = [...messages], pending = new Map<string, ToolCall>();
  for (const message of history) {
    if (message.role === "assistant") for (const call of message.toolCalls) pending.set(call.callId, call);
    else if (message.role === "user") for (const part of message.parts) if (part.type === "tool_result") pending.delete(part.callId);
  }
  if (pending.size) history.push({ role: "user", parts: [...pending.keys()].map(callId => ({ type: "tool_result", callId, isError: true, content: [{ type: "text", text: "This tool is still running in the original agent. No result is available in this auxiliary branch. Do not execute or retry it." }] })) });
  return history;
}

/** Optional work never sends a request that the shared ledger refuses. Unknown usage remains conservatively counted. */
export async function sampleSideText(o: { readonly provider: ModelProvider; readonly model: ResolvedModel; readonly ledger: BudgetLedger; readonly pricing?: ModelPricing; readonly system: string; readonly text: string; readonly consumer: string; readonly maxOutputTokens?: number; readonly branch?: Pick<ModelRequest, "system" | "history" | "tools">; readonly usage?: (usage: Usage, cost: number | undefined) => void; readonly signal: AbortSignal }): Promise<string | undefined> {
  o.signal.throwIfAborted();
  const request: ModelRequest = { model: o.model, system: [...(o.branch?.system ?? []), { text: o.system }], tools: o.branch?.tools ?? [], history: [...branchHistory(o.branch?.history ?? []), { role: "user", parts: [{ type: "text", text: o.text }] }], maxOutputTokens: Math.min(o.maxOutputTokens ?? 128, o.model.maxOutputTokens), thinking: { enabled: false, mode: "adaptive", budgetTokens: 0, showSummaries: false }, purpose: "side" };
  const admitted = o.ledger.admit(requestBound(request, o.pricing), o.consumer);
  if (!admitted.admitted) return undefined;
  try {
    for await (const event of o.provider.stream(request, o.signal)) {
      if (event.type !== "message_complete") continue;
      if (event.usageReported === false) o.ledger.keepConservatively(admitted.reservation); else o.ledger.settle(admitted.reservation, costOf(o.pricing, event.usage));
      o.usage?.(event.usage, event.usageReported === false ? undefined : costOf(o.pricing, event.usage));
      if (event.assistant.toolCalls.length) return undefined; // A cached branch advertises definitions but never executes tools.
      return event.assistant.text.trim();
    }
    return undefined;
  } finally { o.ledger.keepConservatively(admitted.reservation); }
}
