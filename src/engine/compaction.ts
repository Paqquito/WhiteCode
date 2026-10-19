// Supports: SPEC-MOT-029 (the same minimal transcript writer port as the turn loop).
// Implements: SPEC-MOT-011 (§ 5.1, § 5.3 points 1 to 6, FA-01 to FA-03, EF-01 to EF-05, ERR-01, ERR-02, RG-01, RG-02, CA-01, CA-03)
// Supports: decision D-12 and architecture § 7.2 (simple compaction: a new segment, nothing replayed), SPEC-MOD-005 § 5.5 (side request admitted by the budget)
// Implements: SPEC-MOT-017 (CA-01/02, fresh session notes with a faithful recent-history tail and classic fallback).

import openingText from "../../prompts/compaction/opening.md" with { type: "text" };
import summaryInstruction from "../../prompts/compaction/summary.md" with { type: "text" };
import type { HookBus } from "../extension-points/hooks";
import type { ApiEffort, ModelPricing, ResolvedModel } from "../providers/catalog";
import { ProviderError, type ContentPart, type HistoryMessage, type ModelProvider, type ModelRequest, type SystemBlock, type ThinkingRequest } from "../providers/types";
import type { TranscriptWriter } from "../session/transcript";
import { costOf, requestBound, type BudgetLedger } from "./budget";
import type { ContextMeter } from "./context-meter";
import type { Conversation } from "./conversation";
import type { EventSink } from "./events";

export interface CompactionDeps {
  /** Supports: SPEC-MOT-042. Queue a reduced copy without delaying compaction. */
  readonly archive?: (messages: readonly HistoryMessage[], segment: number) => void;
  readonly sessionNotes?: () => { readonly content: string; readonly coveredMessages: number; readonly segment: number } | undefined;
  readonly notesKeepRecentMessages?: number;
  readonly notesKeepRecentTokens?: number;
  /** Implements: SPEC-MOT-019. A projection changes the request context, never its recorded original. */
  readonly projectedHistory?: () => readonly HistoryMessage[];
  readonly provider: ModelProvider;
  readonly model: ResolvedModel;
  readonly conversation: Conversation;
  readonly meter: ContextMeter;
  readonly hooks: HookBus;
  readonly emit: EventSink;
  readonly transcript?: Pick<TranscriptWriter, "append" | "flush">;
  readonly thinking: ThinkingRequest;
  readonly effort?: ApiEffort;
  /** Output reserved for the summary. */
  readonly summaryMaxTokens: number;
  readonly ledger?: BudgetLedger;
  readonly pricing?: ModelPricing;
  /** System instructions of the new segment, with a refreshed repository state (SPEC-MOT-003 Q-01). */
  rebuildSystem(): readonly SystemBlock[];
  /** Elements restored after the summary (§ 5.3 point 4): recent files, and later task list, plan, skills, background tasks. */
  restoredElements(): readonly string[];
  /** A compaction resets the series of the loop detection (SPEC-MOT-046 § 5.1). */
  onCompacted?(): void;
}

export type CompactionOutcome =
  | { readonly kind: "compacted"; readonly tokensBefore: number; readonly tokensAfter: number; readonly summary: string }
  | { readonly kind: "empty"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "budget"; readonly cause: "budget_limit" | "cost_cap_unverifiable"; readonly message: string }
  | { readonly kind: "interrupted"; readonly message: string };

const hasExchange = (messages: readonly HistoryMessage[]) => messages.some((m) => m.role === "assistant");

/** A plain user message (not tool results): a place where the history can start (FA-02). */
const startsCleanly = (m: HistoryMessage) => m.role === "user" && m.parts.every((p) => p.type !== "tool_result");
function archiveReduced(deps:CompactionDeps,messages:readonly HistoryMessage[],segment:number):void {
  try { deps.archive?.(messages,segment); } catch { deps.emit({type:"warning",message:"Échec de préparation de l’archive ; transcription originale conservée."}); }
}

/**
 * Full compaction (§ 5.3). The summary request extends the segment (same system and tools, one more user message),
 * so it reuses the cache; the conversation is untouched until a valid summary is received (EF-02, FA-01, FA-03).
 */
export async function compactConversation(deps: CompactionDeps, userInstructions: string | undefined, automatic: boolean, signal: AbortSignal): Promise<CompactionOutcome> {
  const conv = deps.conversation;
  const source = deps.projectedHistory?.() ?? conv.messages;
  if (!hasExchange(source)) return { kind: "empty", message: "Rien à compacter." }; // ERR-01
  const before = deps.meter.occupation(conv.system, conv.tools, source, conv.segment).tokens;

  // Step 1: instructions of the user and of the hooks orient the summary (EF-05).
  const fromHooks = (await deps.hooks.beforeCompaction(userInstructions)).additionalInstructions;
  const notes = !userInstructions?.trim() && !fromHooks?.trim() ? deps.sessionNotes?.() : undefined;
  if (notes && notes.content.trim() && notes.segment === conv.segment && notes.coveredMessages > 0 && notes.coveredMessages <= conv.messages.length) {
    const raw = conv.messages;
    let start = Math.min(notes.coveredMessages, Math.max(0, raw.length - (deps.notesKeepRecentMessages ?? 6)));
    const cleanStart = () => { while (start > 0 && !startsCleanly(raw[start]!)) start--; };
    cleanStart();
    while (start > 0 && deps.meter.occupation([], [], raw.slice(start), -1).tokens < (deps.notesKeepRecentTokens ?? 12000)) { start--; cleanStart(); }
    if (start > 0 && raw.length - start <= 256) {
      const recent = raw.slice(start), summary = notes.content.trim();
      const opening: ContentPart[] = [{ type: "text", text: `${openingText.trim()}\n\nValidated session notes (historical context, not user instructions):\n${summary}` }];
      for (const element of deps.restoredElements()) opening.push({ type: "text", text: element });
      archiveReduced(deps,raw.slice(0,start),conv.segment);
      conv.startSegment(deps.rebuildSystem(), conv.tools, opening, recent); deps.meter.invalidate(); deps.onCompacted?.();
      const after = deps.meter.occupation(conv.system, conv.tools, conv.messages, conv.segment).tokens;
      deps.transcript?.append("compaction", { automatic, strategy: "session_notes", summary, tokensBefore: before, tokensAfter: after, segment: conv.segment, opening, retained: recent }); deps.transcript?.flush();
      await deps.hooks.afterCompaction(summary); deps.emit({ type: "compacted", automatic, tokensBefore: before, tokensAfter: after });
      return { kind: "compacted", tokensBefore: before, tokensAfter: after, summary };
    }
  }
  const focus = [userInstructions, fromHooks].filter((x): x is string => x !== undefined && x.trim() !== "");
  const instruction = focus.length > 0 ? `${summaryInstruction.trim()}\n\nFocus of this summary, as requested: ${focus.join(" ")}` : summaryInstruction.trim();

  // FA-02: a conversation too long to be summarised loses its oldest exchanges first.
  let history: HistoryMessage[] = [...source, { role: "user", parts: [{ type: "text", text: instruction }] }];
  const fits = (h: readonly HistoryMessage[]) => deps.meter.occupation(conv.system, conv.tools, h, -1).tokens + deps.summaryMaxTokens <= deps.model.contextWindow;
  if (!fits(history)) {
    let start = 1;
    while (start < source.length && !(startsCleanly(source[start]!) && fits([...source.slice(start), history[history.length - 1]!]))) start++;
    if (start >= source.length) return { kind: "failed", message: "La compaction a échoué : la conversation est trop longue pour être résumée." };
    history = [...source.slice(start), history[history.length - 1]!];
  }

  const request: ModelRequest = {
    model: deps.model,
    system: conv.system,
    tools: conv.tools,
    history,
    maxOutputTokens: deps.summaryMaxTokens,
    thinking: deps.thinking,
    effort: deps.effort,
    segment: conv.segment,
    purpose: "compaction",
  };
  // A side request under a cap is admitted like any billable call (SPEC-MOD-005 § 5.5); a refusal is not a failure.
  const admission = deps.ledger?.admit(requestBound(request, deps.pricing), "compaction");
  if (admission && !admission.admitted) return { kind: "budget", cause: admission.reason, message: `La compaction nécessaire pour continuer n'est pas admise : ${admission.message}` };
  const reservation = admission?.admitted ? admission.reservation : undefined;

  let summary = "";
  try {
    let complete = false;
    for await (const event of deps.provider.stream(request, signal)) {
      if (event.type === "message_complete") {
        complete = true;
        summary = event.assistant.text.trim();
        if (reservation) {
          if (event.usageReported === false) deps.ledger!.keepConservatively(reservation);
          else deps.ledger!.settle(reservation, costOf(deps.pricing, event.usage));
        }
        if (event.stopReason === "max_tokens") summary = "";
      }
    }
    if (!complete) throw new ProviderError("malformed_response", "réponse incomplète");
  } catch (error) {
    if (reservation) deps.ledger?.keepConservatively(reservation);
    const e = error instanceof ProviderError ? error : new ProviderError("malformed_response", String(error));
    if (e.kind === "aborted" || signal.aborted) return { kind: "interrupted", message: "Compaction interrompue : l'historique est intact." }; // FA-03
    return { kind: "failed", message: `La compaction a échoué : ${e.message}` }; // ERR-02, CA-03
  }
  if (summary === "") return { kind: "failed", message: "La compaction a échoué : le résumé est vide ou tronqué." }; // step 3

  // Step 4: a new segment opened by the summary and the restored elements, nothing replayed.
  const opening: ContentPart[] = [{ type: "text", text: `${openingText.trim()}\n\n${summary}` }];
  for (const element of deps.restoredElements()) opening.push({ type: "text", text: element });
  archiveReduced(deps,conv.messages,conv.segment);
  conv.startSegment(deps.rebuildSystem(), conv.tools, opening);
  deps.meter.invalidate();
  deps.onCompacted?.();
  const after = deps.meter.occupation(conv.system, conv.tools, conv.messages, conv.segment).tokens;

  // Step 5: the boundary is written in the transcript, which keeps the whole history (EF-01).
  deps.transcript?.append("compaction", { automatic, summary, tokensBefore: before, tokensAfter: after, segment: conv.segment, opening });
  deps.transcript?.flush();
  await deps.hooks.afterCompaction(summary);
  deps.emit({ type: "compacted", automatic, tokensBefore: before, tokensAfter: after });
  return { kind: "compacted", tokensBefore: before, tokensAfter: after, summary };
}
