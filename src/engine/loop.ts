// Implements: SPEC-MOT-001 (§ 5.3 steps 1 to 10, FA-01 to FA-03, EF-01 to EF-10, RG-01 to RG-04, CA-01 to CA-06, CA-10), SPEC-MOD-005 (FA-01 to FA-03, FA-06, EF-02, EF-03, EF-08, EF-10),
//             SPEC-API-003 (§ 5.1, § 5.3, FA-01, FA-02, EF-01 to EF-06, ERR-01 to ERR-03, RG-01, CA-01 to CA-04), SPEC-API-002 (FA-01, CA-02)
// Supports: SPEC-MOT-008 (§ 5.3 step 3, EF-02, EF-03: messages typed during the work, at the safe point), SPEC-MOT-007 (reminders before each request), decision D-12 (append-only history), gaps E-021 (retries around the SDK), E-022, E-056 (retry after a partial response), E-072 (empty final response), SPEC-SES-001 (EF-01)
// Supports: SPEC-CFG-003 (policy check before context compaction), gap E-120.
// Supports: SPEC-MOD-005 (CA-04, CA-05: actual result model and shared request admission), gap E-139.
// Supports: SPEC-API-001 (tool calls require the effective model capability), gap E-145.

import type { HookBus } from "../extension-points/hooks";
import type { ApiEffort, ModelPricing, ResolvedModel } from "../providers/catalog";
import { ProviderError, type ContentPart, type ModelEvent, type ModelProvider, type ModelRequest, type StopReason, type ThinkingRequest, type ToolCall, type ToolResultPart, type Usage } from "../providers/types";
import type { TranscriptWriter } from "../session/transcript";
import { costOf, requestBound, type Reservation } from "./budget";
import type { Conversation } from "./conversation";
import type { EventSink, StopCause, TurnResult } from "./events";
import { ResponseExecution, type ExecutorDeps } from "./executor";
import type { ContextManager } from "./context-manager";
import { RunLimits } from "./limits";
import { formatReminder, type ReminderCenter } from "./reminders";
import type { FallbackPolicy } from "./fallback";
import { tokenTarget } from "./token-target";
import { keywordRanges } from "./max-keyword";

export interface RetryPolicy {
  /** `api.maxRetries`: number of new attempts after the first one (EF-03). */
  readonly maxRetries: number;
  /** Interruptible wait (EF-04, FA-02); injectable for the tests. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

export interface LoopDeps {
  readonly tokenTarget?: { readonly enabled: boolean; readonly completionRatio: number };
  readonly maxKeyword?: string;
  /** Implements: SPEC-MOT-019. Projection leaves the raw conversation and transcript intact. */
  readonly projectHistory?: (request: ModelRequest) => ModelRequest;
  /** SPEC-HOK-009: non-blocking internal processors, after persistence of a complete assistant response. */
  readonly postSampling?: (assistant: Extract<import("../providers/types").HistoryMessage, { role: "assistant" }>, agent?: string) => void;
  readonly provider: ModelProvider;
  readonly model: ResolvedModel;
  readonly conversation: Conversation;
  readonly executor: Omit<ExecutorDeps, "emit">;
  readonly hooks: HookBus;
  readonly transcript?: TranscriptWriter;
  readonly maxOutputTokens: number;
  readonly thinking: ThinkingRequest;
  /** Effort sent with each request, read at each request (a session level may change, SPEC-MOT-025). */
  readonly effort?: ApiEffort;
  /** Iteration limit of this turn when no run limits are given; undefined = no limit (interactive default, gap E-018). */
  readonly maxIterations?: number;
  /** A saved child's admitted requests; kept when the same agent is resumed. */
  readonly requestCounter?: { count: number };
  /** Limits of the whole execution, shared by every turn (SPEC-MOD-005). */
  readonly limits?: RunLimits;
  /** Price used for the budget and the cost (catalogue or authorised override, gap E-055). */
  readonly pricing?: ModelPricing;
  /** Authorised prices apply to backup models too (managed cap, CA-14). */
  readonly pricingForModel?: (model: ResolvedModel) => ModelPricing | undefined;
  readonly retry?: RetryPolicy;
  readonly maxOutputContinuations: number;
  readonly maxStopHookContinuations: number;
  readonly emit: EventSink;
  readonly clock?: () => number;
  /** Identifier of a sub-agent: its requests form their own sequence (SPEC-AGT-001). */
  readonly agentId?: string;
  /** Identifier of the session, carried by the requests (never sent to the service). */
  readonly conversationId?: string;
  /** Messages typed during the turn, taken at the safe point after the results of the tools (SPEC-MOT-008). */
  readonly takeQueued?: () => ReadonlyArray<ContentPart>;
  /** Operator note to append before the next request (mode change reminder, SPEC-PER-003 CA-06). */
  readonly pendingNote?: () => string | undefined;
  /** A user message was recorded, with its record identifier when the session is persisted (SPEC-SES-006 EF-02). */
  readonly onUserMessage?: (recordId: string | undefined) => void;
  /** Called before each request: settings changed on disk are applied (SPEC-CFG-005). */
  readonly beforeRequest?: () => void;
  /** Backup model after consecutive overloads (SPEC-API-005). */
  readonly fallback?: FallbackPolicy;
  /** System reminders asked before each request (SPEC-MOT-007). */
  readonly reminders?: ReminderCenter;
  /** Calls of a response and their results, once executed: feeds the reminders that depend on the files touched (SPEC-MOT-005 FA-01, FA-02). */
  readonly afterToolResults?: (calls: readonly ToolCall[], results: readonly ToolResultPart[]) => void;
  /** SPEC-OUT-041: validated results belong to this agent, consumed at the safe point. */
  readonly takeSubmittedResult?: () => { readonly value: unknown } | undefined;
  /** Context of the main agent: occupation, micro-compaction, automatic compaction, service-side clearing (SPEC-MOT-010 to 014). */
  readonly context?: ContextManager;
}

const CONTINUE_AFTER_TRUNCATION =
  "Your previous response was cut off by the output limit. Continue exactly where it stopped, without repeating what you already wrote.";

/** Gap E-072 (correction D-10): sent once when a final response holds no text for the user. */
const ASK_FOR_ANSWER = "Your last response contained no answer for the user. Give your answer now.";
const QUEUED_DURING_WORK = "The user sent the message above while you were working. Take it into account from now on.";

/** Error classes that are retried (§ 5.1): transient failures, rate limit, overload. */
const RETRYABLE = new Set(["connection", "timeout", "idle_timeout", "server", "overloaded", "rate_limit"]);

/** Exponential delay with jitter, between 0.5 s and 30 s (§ 5.3 point 2); the provider's indication wins (EF-02). */
export function retryDelayMs(attempt: number, retryAfterMs: number | undefined, random: () => number = Math.random): number {
  if (retryAfterMs !== undefined && retryAfterMs >= 0) return retryAfterMs;
  const base = Math.min(30_000, 500 * 2 ** attempt);
  return Math.round(Math.min(30_000, Math.max(500, base * (0.8 + 0.4 * random()))));
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError("aborted", "Attente interrompue."));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("aborted", "Attente interrompue."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Final message of an error that is not retried, or whose attempts are exhausted (EF-05: cause and possible action). */
function finalMessage(e: ProviderError, attempts: number, forModel = false): string {
  if (forModel) {
    if (e.kind === "authentication" || e.kind === "permission") return "Check the API credentials and provider permissions.";
    if (e.kind === "rate_limit") return `The provider rate limit was reached after ${attempts} attempts. Retry later or reduce concurrent runs.`;
    if (RETRYABLE.has(e.kind)) return `The model service failed after ${attempts} attempts. Retry later or check the connection.`;
    return `The model request failed (${e.kind}). Review the model and provider configuration before retrying.`;
  }
  switch (e.kind) {
    case "authentication":
    case "permission":
      return `Clé d'API refusée : vérifiez votre configuration. (${e.message})`; // ERR-02
    case "rate_limit":
      return `Limite de débit du fournisseur atteinte après ${attempts} essai${attempts > 1 ? "s" : ""} : réessayez plus tard ou réduisez le nombre d'exécutions simultanées.`;
    case "connection":
    case "timeout":
    case "idle_timeout":
    case "server":
    case "overloaded":
      return `Le service du modèle ne répond pas après ${attempts} essai${attempts > 1 ? "s" : ""} (${e.message}) : réessayez plus tard ou vérifiez la connexion.`; // ERR-01
    default:
      return e.message;
  }
}

export async function runTurn(deps: LoopDeps, request: string | readonly ContentPart[], signal: AbortSignal): Promise<TurnResult> {
  const content: ContentPart[] = typeof request === "string" ? [{ type: "text", text: request }] : [...request];
  const prompt = content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
  const target = deps.tokenTarget?.enabled && !deps.agentId ? tokenTarget(content.find(p => p.type === "text")?.text ?? "") : undefined;
  const maximal = !deps.agentId && deps.maxKeyword && keywordRanges(content.find(p => p.type === "text")?.text ?? "", deps.maxKeyword).length > 0;
  const now = deps.clock ?? Date.now;
  const started = now();
  const conv = deps.conversation;
  const limits = deps.limits ?? new RunLimits({ maxIterations: deps.maxIterations, clock: now });
  const pricing = deps.pricing ?? deps.model.pricing;
  const ledger = limits.ledger;
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let iterations = 0;
  let continuations = 0;
  let stopHookContinuations = 0;
  let finalText = "";
  let refusalCategory: string | null | undefined;
  let usageUnknown = false;
  // Cost of the responses, each with the price of the model that gave it (the backup model may have another one).
  let cost = 0;
  let costUnknown = false;
  let continuing = false;
  let emptyRelaunched = false;
  let lastModel = deps.model.id;
  const requests = deps.requestCounter ?? { count: 0 };

  // Duration limit (FA-03): the turn's own signal is aborted at the deadline; an interruption keeps its own cause.
  const local = new AbortController();
  let durationExceeded = false;
  const onParentAbort = () => local.abort();
  if (signal.aborted) local.abort();
  else signal.addEventListener("abort", onParentAbort, { once: true });
  const unsubscribeStop = limits.onStop(() => local.abort());
  const remaining = limits.remainingMs();
  const deadlineTimer =
    remaining === undefined
      ? undefined
      : setTimeout(() => {
          durationExceeded = true;
          local.abort();
        }, remaining);
  const turnSignal = local.signal;

  const persist = (type: Parameters<TranscriptWriter["append"]>[0], data: Record<string, unknown>) => deps.transcript?.append(type, data);
  const finish = (stopCause: StopCause, message?: string, modelMessage?: string): TurnResult => {
    if (limits.stopped) { stopCause = limits.stopped.cause; message = limits.stopped.message; modelMessage = undefined; }
    unsubscribeStop();
    clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", onParentAbort);
    const confirmed = usageUnknown || costUnknown ? undefined : cost;
    const result: TurnResult = {
      stopCause,
      message,
      modelMessage,
      refusalCategory,
      iterations,
      usage: { ...usage },
      cost: { confirmed, currency: deps.model.currency },
      durationMs: now() - started,
      finalText,
      model: lastModel,
    };
    persist("system", { event: "turn_end", stopCause, message, iterations, usage: result.usage, cost: result.cost, durationMs: result.durationMs });
    deps.transcript?.flush();
    deps.emit({ type: "turn_completed", result });
    return result;
  };
  const interrupted = () => {
    if (limits.stopped) return finish(limits.stopped.cause, limits.stopped.message);
    if (durationExceeded) { const reason = { cause: "duration_limit" as const, message: limits.beforeRequest()?.message ?? "Durée maximale atteinte." }; limits.stop(reason); return finish(reason.cause, reason.message); }
    return finish("interrupted", "Interrompu.");
  };
  const requestStop = () => {
    const global = limits.beforeRequest();
    if (global) { limits.stop(global); return global; }
    if (deps.maxIterations !== undefined && requests.count >= deps.maxIterations) return { cause: "iteration_limit" as const, message: `Nombre maximal d'itérations de cet agent atteint (${deps.maxIterations}).` };
    return undefined;
  };

  try {
  // Steps 1 and 2: input and `prompt_submitted` hook.
  const gate = await deps.hooks.promptSubmitted(prompt);
  if (turnSignal.aborted) return interrupted();
  if (gate.block) return finish("blocked", gate.block);
  conv.appendUser(content);
  const userRecord = persist("user", { content });
  deps.onUserMessage?.(userRecord); // SPEC-SES-006 EF-02: a checkpoint per user message
  deps.emit({ type: "user_message", content, ...(userRecord ? { recordId: userRecord } : {}) });
  deps.executor.loopGuard?.newTurn(); // a user message resets the series (SPEC-MOT-046 § 5.1)

  for (;;) {
    if (turnSignal.aborted) return interrupted();
    // FA-01, FA-03 of SPEC-MOD-005: limits checked before each request.
    const stop = requestStop();
    if (stop) return finish(stop.cause, stop.message);
    deps.beforeRequest?.();

    // SPEC-MOT-012: before the request, between two iterations (RG-01); a compaction refused by the budget stops the run.
    if (deps.context) {
      const context = await deps.context.beforeRequest(turnSignal);
      if (turnSignal.aborted) return interrupted();
      if (context.stop) return finish(context.stop.cause, context.stop.message);
    }

    // SPEC-MOT-007: reminders, tagged (EF-01), appended and never removed (D-12), persisted with their type (EF-04).
    const mode = deps.pendingNote?.();
    const notes = [
      ...(mode ? [{ type: "mode_change", text: mode }] : []),
      ...limits.approaching((m) => deps.emit({ type: "warning", message: m })).map((text) => ({ type: "limit_approaching", text })),
      ...(deps.reminders?.collect() ?? []),
      ...(deps.context?.notices() ?? []),
    ];
    for (const note of notes) {
      const text = formatReminder(note.text);
      conv.appendNote(text);
      persist("system", { event: "note", type: note.type, text });
    }

    // One request, with its retries (SPEC-API-003). Each attempt is admitted by the budget on its own (EF-10).
    let complete: Extract<ModelEvent, { type: "message_complete" }> | undefined;
    let execution!: ResponseExecution;
    let reservation: Reservation | undefined;
    let requestModel = deps.model;
    let requestPricing = pricing;
    let overflowRecovered = false;
    for (let attempt = 0; ; attempt++) {
      const stop = requestStop();
      if (stop) return finish(stop.cause, stop.message);
      // SPEC-API-005: the backup model while the main one is overloaded, then the main one again (EF-03).
      requestModel = deps.fallback?.model() ?? deps.model;
      requestPricing = deps.pricingForModel ? deps.pricingForModel(requestModel) : requestModel === deps.model ? pricing : requestModel.pricing;
      const tools = conv.toolsForModel(requestModel.capabilities.toolCalling);
      const base: ModelRequest = {
        model: requestModel,
        system: conv.system,
        tools,
        history: conv.messages,
        maxOutputTokens: Math.min(deps.maxOutputTokens, requestModel.maxOutputTokens),
        thinking: maximal && requestModel.capabilities.thinking !== "none" ? { ...deps.thinking, enabled: true, budgetTokens: Math.max(0, Math.min(deps.maxOutputTokens, requestModel.maxOutputTokens) - 1024) } : deps.thinking,
        effort: maximal ? (["max", "high", "medium", "low"] as const).find(level => requestModel.capabilities.effort.includes(level)) : deps.effort,
        segment: conv.segment,
        ...(deps.agentId ? { purpose: "subagent" as const, agent: deps.agentId } : {}),
        ...(deps.conversationId ? { conversationId: deps.conversationId } : {}),
      };
      const decorated = deps.context ? deps.context.decorate(base) : base;
      const modelRequest = deps.projectHistory ? deps.projectHistory(decorated) : decorated;
      if (ledger) {
        const admission = ledger.admit(requestBound(modelRequest, requestPricing), "main");
        if (!admission.admitted) return finish(admission.reason, admission.message); // FA-02, FA-08: not sent
        reservation = admission.reservation;
      }
      execution = new ResponseExecution({ ...deps.executor, emit: deps.emit }, turnSignal);
      let text = "";
      try {
        // No await separates the last check from this slot: concurrent agents cannot overbook the run.
        limits.countIteration();
        requests.count++;
        iterations++;
        lastModel = requestModel.id;
        const stream = deps.provider.stream(modelRequest, turnSignal);
        for await (const event of stream) {
          switch (event.type) {
            case "text_delta":
              text += event.text;
              deps.emit(event);
              break;
            case "thinking_delta":
              deps.emit(event);
              break;
            case "tool_call":
              if (!requestModel.capabilities.toolCalling) throw new ProviderError("malformed_response", "Le modèle n'a pas déclaré la capacité d'appels d'outils.");
              deps.emit({ type: "tool_call", callId: event.call.callId, name: event.call.name, input: event.call.input });
              execution.submit(event.call);
              break;
            case "message_complete":
              if (!requestModel.capabilities.toolCalling && event.assistant.toolCalls.length > 0) throw new ProviderError("malformed_response", "Le modèle n'a pas déclaré la capacité d'appels d'outils.");
              complete = event;
              break;
          }
        }
        if (!complete) throw new ProviderError("malformed_response", "Réponse inattendue du service du modèle.");
        break;
      } catch (error) {
        // The calls of an incomplete response are cancelled; their results are never used (RG-01, gap E-056).
        execution.cancel();
        await execution.results();
        complete = undefined;
        // A cancelled or failed call may have been billed: its bound stays counted (CA-12 of SPEC-MOD-005).
        if (reservation) ledger?.keepConservatively(reservation);
        const e = error instanceof ProviderError ? error : new ProviderError("malformed_response", String(error));
        // FA-01 of SPEC-MOT-001: an incomplete response is not added to the history; it stays in the transcript.
        persist("system", { event: e.kind === "aborted" ? "response_interrupted" : "provider_error", kind: e.kind, partialText: text, attempt: attempt + 1 });
        if (e.kind === "aborted" || turnSignal.aborted) return interrupted();
        if (e.kind === "context_too_long" && !overflowRecovered) {
          overflowRecovered = true;
          const recovery = await deps.context?.recoverOverflow(turnSignal);
          if (turnSignal.aborted) return interrupted();
          if (recovery?.kind === "budget") return finish(recovery.cause, recovery.message);
          if (recovery?.kind === "compacted") { if (text !== "") deps.emit({ type: "response_restarted" }); continue; }
        }
        const maxRetries = deps.retry?.maxRetries ?? 0;
        // SPEC-API-005 CA-01, EF-01: at the threshold, the next attempt goes to the backup model, and the user is told.
        if (e.kind === "overloaded" && deps.fallback?.overloaded(requestModel)) {
          deps.emit({ type: "warning", message: `Le modèle ${requestModel.id} est surchargé : les requêtes vont au modèle de repli ${deps.fallback.backup.id} pendant un moment.` });
          persist("system", { event: "fallback", from: requestModel.id, to: deps.fallback.backup.id });
        }
        if (RETRYABLE.has(e.kind) && attempt < maxRetries) {
          const stop = requestStop();
          if (stop) return finish(stop.cause, stop.message);
          const delayMs = retryDelayMs(attempt, e.retryAfterMs, deps.retry?.random);
          // EF-04: the wait is visible and interruptible (FA-02, CA-04).
          deps.emit({ type: "retry", attempt: attempt + 1, maxRetries, delayMs, reason: e.message });
          try {
            await (deps.retry?.sleep ?? defaultSleep)(delayMs, turnSignal);
          } catch {
            return interrupted();
          }
          if (turnSignal.aborted) return interrupted();
          // FA-01 of SPEC-API-003: the whole request is sent again; the partial content is replaced.
          if (text !== "") deps.emit({ type: "response_restarted" });
          continue;
        }
        const message = finalMessage(e, attempt + 1);
        await deps.hooks.turnFailed(message);
        if (turnSignal.aborted) return interrupted();
        return finish("error", message, finalMessage(e, attempt + 1, true));
      }
    }

    const response = complete!;
    deps.fallback?.succeeded();
    const responseCost = costOf(requestPricing, response.usage);
    if (responseCost === undefined) costUnknown = true;
    else cost += responseCost;
    const stopReason: StopReason = response.stopReason;
    for (const k of ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const) usage[k] += response.usage[k];
    if (reservation && ledger) {
      // CA-11 of SPEC-MOD-005: without usage information, the bound stays counted.
      if (response.usageReported === false) ledger.keepConservatively(reservation);
      else ledger.settle(reservation, responseCost);
    }
    if (response.usageReported === false) usageUnknown = true;
    deps.emit({ type: "usage", model: requestModel.id, usage: response.usage, ...(response.usageReported !== false && responseCost !== undefined ? { cost: responseCost } : {}) });
    if (target) deps.emit({ type: "token_goal", consumed: usage.outputTokens, goal: target });
    const assistant = response.assistant;
    conv.appendAssistant(assistant); // verbatim, thinking blocks included (D-12)
    if (deps.context) {
      // SPEC-MOT-010 EF-01: the provider counts become the reference for the occupation.
      deps.context.meter.recordResponse(response.usage, response.usageReported !== false, conv.messages.length, conv.segment);
      deps.context.responseReceived();
      if (response.contextEditing?.rejected) deps.context.serviceClearingRejected();
    }
    persist("assistant", {
      content: assistant.native.content,
      provider: assistant.native.provider,
      text: assistant.text,
      toolCalls: assistant.toolCalls,
      stopReason,
      usage: response.usage,
      providerRequestId: response.providerRequestId,
    });
    deps.postSampling?.(assistant, deps.agentId);
    deps.emit({ type: "assistant_message", text: assistant.text, toolCalls: assistant.toolCalls.map((c) => ({ callId: c.callId, name: c.name, input: c.input })) });

    execution.responseComplete(stopReason);
    let results: ToolResultPart[] = [];
    if (assistant.toolCalls.length > 0) {
      results = await execution.results();
      conv.appendToolResults(results); // one result per call, in call order (RG-01)
      deps.afterToolResults?.(assistant.toolCalls, results);
      deps.emit({ type: "user_message", content: results });
      for (const r of results) persist("tool_result", { callId: r.callId, isError: r.isError, content: r.content });
    }
    // A response that continues a truncated one completes its text (FA-02, CA-05).
    finalText = continuing ? finalText + assistant.text : assistant.text;
    continuing = false;

    if (turnSignal.aborted) return interrupted();

    if (stopReason === "refusal") {
      refusalCategory = response.refusalCategory;
      return finish("refusal", "Le modèle a refusé de traiter cette demande.");
    }
    if (execution.stopTurnRequested) return finish("interrupted", "Tour arrêté par l'utilisateur.");
    // FA-01 of SPEC-MOT-046, CA-10 of SPEC-MOT-001: a second loop without interface stops the turn.
    if (execution.unproductiveLoop) return finish("unproductive_loop", "Boucle improductive : le modèle répète le même appel malgré le rappel.");
    const submitted = deps.takeSubmittedResult?.();
    if (submitted) finalText = JSON.stringify(submitted.value);
    if (assistant.toolCalls.length > 0 && !submitted) {
      // SPEC-MOT-008 step 3: the safe point. The messages typed during the work follow the results of the tools, never
      // between a call and its result (EF-03), in the order they were typed (EF-02), with a reminder (SPEC-MOT-007).
      const queued = turnSignal.aborted ? [] : (deps.takeQueued?.() ?? []);
      if (queued.length > 0) {
        conv.appendUser(queued);
        persist("user", { content: queued, queued: true });
        deps.emit({ type: "user_message", content: queued });
        const note = formatReminder(QUEUED_DURING_WORK);
        conv.appendNote(note);
        persist("system", { event: "note", type: "queued_messages", text: note });
      }
      continue; // back to step 4
    }

    if (stopReason === "max_tokens") {
      // FA-02: automatic continuation, without prefilling the assistant message (portable to every provider).
      if (continuations < deps.maxOutputContinuations) {
        continuations++;
        continuing = true;
        conv.appendUser([{ type: "text", text: CONTINUE_AFTER_TRUNCATION }]);
        persist("user", { content: [{ type: "text", text: CONTINUE_AFTER_TRUNCATION }], synthetic: true });
        deps.emit({ type: "user_message", content: [{ type: "text", text: CONTINUE_AFTER_TRUNCATION }], synthetic: true });
        continue;
      }
      deps.emit({ type: "warning", message: "Réponse tronquée par la limite de sortie." });
    }

    // Gap E-072: a final response without text (reasoning only, or nothing) is relaunched once; if it stays empty,
    // the turn ends with a warning instead of a silent empty answer.
    if (finalText.trim() === "") {
      if (!emptyRelaunched) {
        emptyRelaunched = true;
        conv.appendUser([{ type: "text", text: ASK_FOR_ANSWER }]);
        persist("user", { content: [{ type: "text", text: ASK_FOR_ANSWER }], synthetic: true });
        deps.emit({ type: "user_message", content: [{ type: "text", text: ASK_FOR_ANSWER }], synthetic: true });
        continue;
      }
      deps.emit({ type: "warning", message: "Le modèle n'a produit aucune réponse." });
    }

    if (target && usage.outputTokens < target * deps.tokenTarget!.completionRatio) {
      if (usageUnknown) return finish("error", "Objectif de jetons invérifiable : le fournisseur ne rapporte pas la consommation.");
      const note = formatReminder(`Output-token objective: ${usage.outputTokens} of ${target} reported output tokens. The requested work should continue until the objective is approached; all cost, time and iteration limits still apply.`);
      conv.appendNote(note); persist("system", { event: "note", type: "token_goal", text: note }); continue;
    }

    // Step 9: `turn_completed` hook, bounded by RG-06.
    const after = await deps.hooks.turnCompleted(finalText);
    if (turnSignal.aborted) return interrupted();
    if (after.continueWith && stopHookContinuations < deps.maxStopHookContinuations) {
      stopHookContinuations++;
      conv.appendUser([{ type: "text", text: after.continueWith }]);
      persist("user", { content: [{ type: "text", text: after.continueWith }], fromHook: true });
      deps.emit({ type: "user_message", content: [{ type: "text", text: after.continueWith }], synthetic: true });
      continue;
    }
    return finish("completed");
  }
  } finally {
    unsubscribeStop();
    clearTimeout(deadlineTimer);
    signal.removeEventListener("abort", onParentAbort);
  }
}
