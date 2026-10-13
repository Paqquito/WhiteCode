// Implements: SPEC-API-001 (adapter `anthropic`), SPEC-API-002 (EF-01, EF-02, EF-04, EF-05, EF-07, FA-01, FA-02, RG-01), SPEC-MOT-023 (EF-01 to EF-03), SPEC-MOT-025 (EF-02),
//             SPEC-MOT-014 (§ 5.3 points 2 and 4, EF-01, ERR-01, RG-01, CA-01, CA-02)
// Supports: decisions D-01 (official SDK), D-11 (optional adapter, constraints confined here), D-13; gaps E-021, E-022, E-032, E-043, E-073
// Optional Anthropic adapter built on the official SDK. SDK types are used for every message structure.
// Every model-dependent behaviour comes from the catalogue capabilities and `providerOptions`; no model is named here.

import Anthropic from "@anthropic-ai/sdk";
import type { MessageStream } from "@anthropic-ai/sdk/lib/MessageStream";
import type { ContextEditingStrategy, HistoryMessage, ModelEvent, ModelProvider, ModelRequest, StopReason, ToolCall } from "./types";
import { ProviderError } from "./types";

/** Beta of service-side context management (SPEC-MOT-014), confined to this adapter (D-11). */
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";

export interface AnthropicProviderOptions {
  readonly apiKey?: string;
  readonly authToken?: string;
  readonly baseURL?: string;
  /** The connections of the product: proxy and trust store (SPEC-PER-022). */
  readonly fetch?: typeof fetch;
  /** Request timeout in milliseconds (`{{ENV_PREFIX}}REQUEST_TIMEOUT`). */
  readonly timeoutMs: number;
  /** Stream idle timeout in milliseconds (`api.streamIdleTimeout`). */
  readonly idleTimeoutMs: number;
  /** Product headers: user agent and `{{HTTP_HEADER_PREFIX}}…` headers from the identity. */
  readonly headers: Readonly<Record<string, string>>;
}

/** Converts the neutral history to SDK message parameters. Deterministic: same history, same bytes (D-12). */
export function toMessageParams(history: readonly HistoryMessage[], systemMessages: boolean): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const m of history) {
    const label = m.contextId ? `[${m.contextId}]\n` : "";
    if (m.role === "assistant") {
      // Verbatim (D-12), empty text blocks included: a translating gateway needs them to give the message a content (gap E-073).
      const native = m.native.content as Anthropic.ContentBlockParam[];
      out.push({ role: "assistant", content: native });
      continue;
    }
    if (m.role === "system_note") {
      const last = out[out.length - 1];
      if (systemMessages) out.push({ role: "system", content: label + m.text });
      else if (last && last.role === "user" && Array.isArray(last.content)) (last.content as Anthropic.ContentBlockParam[]).push({ type: "text", text: label + m.text });
      else out.push({ role: "user", content: [{ type: "text", text: label + m.text }] });
      continue;
    }
    const content: Anthropic.ContentBlockParam[] = m.parts.map((p): Anthropic.ContentBlockParam => {
      switch (p.type) {
        case "text":
          return { type: "text", text: p.text };
        case "image":
          return { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.dataBase64 } };
        case "tool_result":
          return {
            type: "tool_result",
            tool_use_id: p.callId,
            is_error: p.isError,
            content: [...(label ? [{ type: "text" as const, text: label }] : []), ...p.content.map((c): Anthropic.TextBlockParam | Anthropic.ImageBlockParam =>
              c.type === "text" ? { type: "text", text: c.text } : { type: "image", source: { type: "base64", media_type: c.mediaType, data: c.dataBase64 } },
            )],
          };
      }
    });
    if (label && m.parts.some(p => p.type !== "tool_result")) content.push({ type: "text", text: label });
    out.push({ role: "user", content });
  }
  return out;
}

/** Builds the SDK request parameters from the neutral request (exported for tests). */
export function buildParams(request: ModelRequest): Anthropic.MessageStreamParams {
  const caps = request.model.capabilities;
  const system: Anthropic.TextBlockParam[] = request.system.map((b) =>
    b.cacheBoundary ? { type: "text", text: b.text, cache_control: { type: "ephemeral" } } : { type: "text", text: b.text },
  );
  const tools: Anthropic.Tool[] = [...request.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
      ...(caps.toolInputStreaming ? { eager_input_streaming: true } : {}),
    }));

  const params: Anthropic.MessageStreamParams = {
    model: request.model.id,
    max_tokens: request.maxOutputTokens,
    system,
    messages: toMessageParams(request.history, caps.systemMessages),
    // Top-level automatic caching of the growing, append-only history.
    cache_control: { type: "ephemeral" },
  };
  if (tools.length > 0) params.tools = tools; // tool_choice is never forced: the protocol default `auto` applies

  // Thinking (SPEC-MOT-023) from the `thinking` capability: none, optional or always (D-13).
  const t = request.thinking;
  const on = caps.thinking === "always" || (caps.thinking === "optional" && t.enabled);
  if (on) {
    if (caps.thinkingBudget) {
      const budget = Math.max(1024, Math.min(t.budgetTokens, request.maxOutputTokens - 1));
      if (budget < request.maxOutputTokens) params.thinking = { type: "enabled", budget_tokens: budget };
    } else {
      params.thinking = t.showSummaries ? { type: "adaptive", display: "summarized" } : { type: "adaptive" };
    }
  } else if (caps.thinking === "optional" && !caps.thinkingBudget) {
    // The form that switches thinking off may differ between models: `providerOptions.thinkingOff` (gap E-043).
    params.thinking = (request.model.providerOptions["thinkingOff"] as Anthropic.ThinkingConfigParam | undefined) ?? { type: "disabled" };
  }
  // Effort: explicit when accepted by the model, never sent otherwise (SPEC-MOT-025 EF-02).
  if (request.effort && caps.effort.includes(request.effort)) params.output_config = { effort: request.effort };
  return params;
}

function mapStopReason(reason: Anthropic.StopReason | null): StopReason {
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "refusal":
      return "refusal";
    case "pause_turn":
      return "pause_turn";
    default:
      return "other";
  }
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

/** Maps SDK errors (typed classes, never message matching) to the neutral error kinds of SPEC-API-003. */
export function classifyError(error: unknown, idle: boolean): ProviderError {
  if (idle) return new ProviderError("idle_timeout", "Le flux de réponse est resté inactif trop longtemps.");
  if (error instanceof ProviderError) return error;
  if (error instanceof Anthropic.APIUserAbortError) return new ProviderError("aborted", "Requête annulée.");
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError("timeout", "Délai de requête dépassé.");
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError("connection", "Connexion au service du modèle impossible.");
  if (error instanceof Anthropic.AuthenticationError) return new ProviderError("authentication", "Authentification refusée par le fournisseur.", 401, undefined, error.requestID ?? undefined);
  if (error instanceof Anthropic.PermissionDeniedError) return new ProviderError("permission", "Accès refusé par le fournisseur.", 403, undefined, error.requestID ?? undefined);
  if (error instanceof Anthropic.NotFoundError) return new ProviderError("not_found", "Ressource ou modèle introuvable chez le fournisseur.", 404, undefined, error.requestID ?? undefined);
  if (error instanceof Anthropic.RateLimitError) return new ProviderError("rate_limit", "Limite de débit du fournisseur atteinte.", 429, retryAfterMs(error.headers), error.requestID ?? undefined);
  if (error instanceof Anthropic.BadRequestError) return new ProviderError("invalid_request", `Requête refusée par le fournisseur : ${error.message}`, 400, undefined, error.requestID ?? undefined);
  if (error instanceof Anthropic.InternalServerError) {
    const kind = error.status === 529 ? "overloaded" : "server";
    return new ProviderError(kind, "Le service du modèle est indisponible.", error.status, retryAfterMs(error.headers), error.requestID ?? undefined);
  }
  if (error instanceof Anthropic.APIError) {
    const body = error.error as { error?: { type?: string } } | undefined;
    if (body?.error?.type === "overloaded_error") return new ProviderError("overloaded", "Le service du modèle est surchargé.", error.status);
    if (error.status !== undefined && error.status >= 500) return new ProviderError("server", "Le service du modèle est indisponible.", error.status);
    return new ProviderError("invalid_request", `Erreur du fournisseur : ${error.message}`, error.status);
  }
  return new ProviderError("malformed_response", `Réponse inattendue du service du modèle : ${(error as Error)?.message ?? String(error)}`);
}

export class AnthropicProvider implements ModelProvider {
  readonly id = "anthropic";
  readonly #client: Anthropic;
  readonly #idleTimeoutMs: number;

  constructor(options: AnthropicProviderOptions) {
    this.#client = new Anthropic({
      apiKey: options.apiKey ?? null,
      authToken: options.authToken ?? null,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      maxRetries: 0, // retries follow SPEC-API-003, applied by the product (gap E-021)
      timeout: options.timeoutMs,
      defaultHeaders: { ...options.headers },
    });
    this.#idleTimeoutMs = options.idleTimeoutMs;
  }

  /** Service-side clearing rejected once: disabled for the rest of the session (ERR-01 of SPEC-MOT-014). */
  #contextEditingDisabled = false;

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const strategy = request.model.capabilities.contextEditing && !this.#contextEditingDisabled ? request.contextEditing : undefined;
    let emitted = false;
    try {
      for await (const event of this.#streamOnce(request, strategy, signal, false)) {
        emitted = true;
        yield event;
      }
    } catch (error) {
      // CA-02 of SPEC-MOT-014: a strategy rejected before any content is sent again without it, then disabled for the session.
      if (!strategy || emitted || !(error instanceof ProviderError) || error.kind !== "invalid_request") throw error;
      this.#contextEditingDisabled = true;
      yield* this.#streamOnce(request, undefined, signal, true);
    }
  }

  /** Beta parameters of service-side clearing (SPEC-MOT-014): strategy `clear_tool_uses_20250919`, as documented for the SDK. */
  static contextManagement(strategy: ContextEditingStrategy): Anthropic.Beta.Messages.BetaContextManagementConfig {
    return {
      edits: [
        {
          type: "clear_tool_uses_20250919",
          trigger: { type: "input_tokens", value: strategy.triggerTokens },
          keep: { type: "tool_uses", value: strategy.keepToolUses },
          ...(strategy.clearAtLeastTokens !== undefined ? { clear_at_least: { type: "input_tokens" as const, value: strategy.clearAtLeastTokens } } : {}),
          ...(strategy.clearInputsOf.length > 0 ? { clear_tool_inputs: [...strategy.clearInputsOf] } : {}),
        },
      ],
    };
  }

  async *#streamOnce(request: ModelRequest, strategy: ContextEditingStrategy | undefined, signal: AbortSignal, rejected: boolean): AsyncIterable<ModelEvent> {
    const params = buildParams(request);
    // The beta stream is used only when a strategy is joined (EF-01 of SPEC-MOT-014); both streams share the event format.
    const stream = strategy
      ? (this.#client.beta.messages.stream(
          { ...(params as unknown as Parameters<Anthropic["beta"]["messages"]["stream"]>[0]), betas: [CONTEXT_MANAGEMENT_BETA], context_management: AnthropicProvider.contextManagement(strategy) },
          { signal },
        ) as unknown as MessageStream)
      : this.#client.messages.stream(params, { signal });
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        stream.abort();
      }, this.#idleTimeoutMs);
    };
    try {
      // D-5 (decision D-20): the idle limit runs from the first event of the stream; before it, the request timeout applies
      // (a local server may take minutes to process a long prompt before the first token).
      for await (const event of stream) {
        arm();
        if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") yield { type: "text_delta", text: event.delta.text };
          else if (event.delta.type === "thinking_delta") yield { type: "thinking_delta", text: event.delta.thinking };
        } else if (event.type === "content_block_stop") {
          const block = stream.currentMessage?.content[event.index];
          if (block?.type === "tool_use") yield { type: "tool_call", call: { callId: block.id, name: block.name, input: block.input } };
        }
      }
      // An aborted stream may end quietly: it is an incomplete response (SPEC-API-002 FA-01).
      if (idle) throw classifyError(undefined, true);
      if (signal.aborted) throw new ProviderError("aborted", "Requête annulée.");
      const message = await stream.finalMessage();
      const toolCalls: ToolCall[] = message.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
        .map((b) => ({ callId: b.id, name: b.name, input: b.input }));
      const text = message.content
        .filter((b): b is Anthropic.TextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      // § 5.3 point 4: the applied edits are reported, the local estimate follows the usage of the next responses.
      const applied = (message as unknown as { context_management?: Anthropic.Beta.Messages.BetaContextManagementResponse | null }).context_management?.applied_edits ?? [];
      const cleared = applied.filter((e): e is Anthropic.Beta.Messages.BetaClearToolUses20250919EditResponse => e.type === "clear_tool_uses_20250919");
      const contextEditing =
        rejected || cleared.length > 0
          ? {
              ...(rejected ? { rejected: true } : {}),
              ...(cleared.length > 0 ? { clearedToolUses: cleared.reduce((n, e) => n + e.cleared_tool_uses, 0), clearedInputTokens: cleared.reduce((n, e) => n + e.cleared_input_tokens, 0) } : {}),
            }
          : undefined;
      yield {
        type: "message_complete",
        stopReason: mapStopReason(message.stop_reason),
        refusalCategory: message.stop_reason === "refusal" ? (message.stop_details?.category ?? null) : undefined,
        usage: {
          inputTokens: message.usage.input_tokens,
          outputTokens: message.usage.output_tokens,
          cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
        },
        ...(contextEditing ? { contextEditing } : {}),
        assistant: { role: "assistant", text, toolCalls, native: { provider: this.id, content: message.content } },
        providerRequestId: stream.request_id ?? undefined,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted && !idle) throw new ProviderError("aborted", "Requête annulée.");
      throw classifyError(error, idle);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
