// Implements: SPEC-MOD-005 (CA-18, admission of metadata requests).
// Supports: SPEC-SES-008 (CA-01, asynchronous title), gap E-162.
import { costOf, requestBound, type BudgetLedger } from "./budget";
import type { ModelPricing, ResolvedModel } from "../providers/catalog";
import type { ModelProvider, ModelRequest } from "../providers/types";

/** Optional work never sends a request that the shared ledger refuses. Unknown usage remains conservatively counted. */
export async function sampleSideText(o: { readonly provider: ModelProvider; readonly model: ResolvedModel; readonly ledger: BudgetLedger; readonly pricing?: ModelPricing; readonly system: string; readonly text: string; readonly consumer: string; readonly maxOutputTokens?: number; readonly signal: AbortSignal }): Promise<string | undefined> {
  o.signal.throwIfAborted();
  const request: ModelRequest = { model: o.model, system: [{ text: o.system }], tools: [], history: [{ role: "user", parts: [{ type: "text", text: o.text }] }], maxOutputTokens: Math.min(o.maxOutputTokens ?? 128, o.model.maxOutputTokens), thinking: { enabled: false, mode: "adaptive", budgetTokens: 0, showSummaries: false }, purpose: "side" };
  const admitted = o.ledger.admit(requestBound(request, o.pricing), o.consumer);
  if (!admitted.admitted) return undefined;
  try {
    for await (const event of o.provider.stream(request, o.signal)) {
      if (event.type !== "message_complete") continue;
      if (event.usageReported === false) o.ledger.keepConservatively(admitted.reservation); else o.ledger.settle(admitted.reservation, costOf(o.pricing, event.usage));
      return event.assistant.text.trim();
    }
    return undefined;
  } finally { o.ledger.keepConservatively(admitted.reservation); }
}
