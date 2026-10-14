// Implements: SPEC-API-001 (adapters `openai` and `openai_compatible`: mandatory base URL and optional key for the latter, FA-01, EF-01, EF-04, CA-01, CA-02), SPEC-API-002 (EF-01, EF-02, EF-05, EF-07, FA-01, FA-02), SPEC-MOT-025 (EF-02)
// Supports: decisions D-01 (official SDK of the protocol), D-10 (reference provider), D-13; gaps E-021, E-022, E-032, E-042, E-043
// Adapter for servers speaking the OpenAI-compatible chat protocol (streamed chat completions with tool calls).
// Protocol details that differ between servers come from `providerOptions` of the catalogue entry, never from the engine.

import OpenAI from "openai";
import type { ContentPart, HistoryMessage, ModelEvent, ModelProvider, ModelRequest, StopReason, SystemBlock, ToolCall } from "./types";
import { ProviderError } from "./types";
import { warmProviderConnection } from "../platform/network";
import type { ModelCapabilities } from "./catalog";

export interface OpenAICompatibleOptions {
  /** Base URL: mandatory for `openai_compatible`; for `openai`, the SDK default unless `OPENAI_BASE_URL` is set. */
  readonly baseURL?: string;
  /** The connections of the product: proxy and trust store (SPEC-PER-022). */
  readonly fetch?: typeof fetch;
  readonly apiKey?: string;
  /** `OPENAI_ORG_ID` for the `openai` provider. */
  readonly organization?: string;
  /** Provider identifier: the same protocol serves `openai` and `openai_compatible` (SPEC-API-001 § 5.1). */
  readonly providerId?: "openai" | "openai_compatible";
  readonly timeoutMs: number;
  readonly idleTimeoutMs: number;
  readonly headers: Readonly<Record<string, string>>;
}

type ChatMessage = OpenAI.Chat.ChatCompletionMessageParam;

function partsToContent(parts: readonly ContentPart[], images: boolean): string | OpenAI.Chat.ChatCompletionContentPart[] {
  if (!parts.some((p) => p.type === "image")) return parts.map((p) => (p.type === "text" ? p.text : "")).join("\n");
  return parts.map((p): OpenAI.Chat.ChatCompletionContentPart =>
    p.type === "text"
      ? { type: "text", text: p.text }
      : images
        ? { type: "image_url", image_url: { url: `data:${p.mediaType};base64,${p.dataBase64}` } }
        : { type: "text", text: "[image omitted: the model does not accept images]" },
  );
}

/** Converts the neutral history to chat messages. Deterministic: same history, same bytes (D-12). */
export function toChatMessages(system: readonly SystemBlock[], history: readonly HistoryMessage[], caps: ModelCapabilities): ChatMessage[] {
  const out: ChatMessage[] = [];
  const systemText = system.map((b) => b.text).join("\n\n");
  if (systemText !== "") out.push({ role: "system", content: systemText });
  for (const m of history) {
    const label = m.contextId ? `[${m.contextId}]\n` : "";
    if (m.role === "assistant") {
      const native = m.native.content as OpenAI.Chat.ChatCompletionAssistantMessageParam;
      // Native assistant messages remain verbatim (D-12); only tool results can be pruned.
      out.push(native);
      continue;
    }
    if (m.role === "system_note") {
      out.push(caps.systemMessages ? { role: "system", content: label + m.text } : { role: "user", content: label + m.text });
      continue;
    }
    // Tool results become `tool` messages, in call order; other parts form a user message after them.
    const rest: ContentPart[] = [];
    const toolImages: ContentPart[] = [];
    for (const p of m.parts) {
      if (p.type === "tool_result") {
        const text = p.content.map((c) => (c.type === "text" ? c.text : "[image attached below]")).join("\n");
        out.push({ role: "tool", tool_call_id: p.callId, content: label + (p.isError ? `Error: ${text}` : text) });
        // A `tool` message carries text only: images of a result follow in a user message.
        for (const c of p.content) if (c.type === "image") toolImages.push(c);
      } else rest.push(p);
    }
    if (toolImages.length > 0) rest.unshift({ type: "text", text: "Images returned by the tool calls above:" }, ...toolImages);
    if (rest.length > 0) out.push({ role: "user", content: partsToContent(label ? [{ type: "text", text: label }, ...rest] : rest, caps.images) } as ChatMessage);
  }
  return out;
}

/** Builds the request body from the neutral request (exported for tests). */
export function buildChatRequest(request: ModelRequest): OpenAI.Chat.ChatCompletionCreateParamsStreaming {
  const caps = request.model.capabilities;
  const opts = request.model.providerOptions;
  const body: Record<string, unknown> = {
    model: request.model.id,
    messages: toChatMessages(request.system, request.history, caps),
    stream: true,
    stream_options: { include_usage: true },
  };
  // Name of the output limit parameter differs between servers (gap E-043); `max_tokens` by default.
  const limitParam = typeof opts["maxTokensParameter"] === "string" ? (opts["maxTokensParameter"] as string) : "max_tokens";
  body[limitParam] = request.maxOutputTokens;
  const tools: OpenAI.Chat.ChatCompletionTool[] = [...request.tools]
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  if (tools.length > 0) body["tools"] = tools; // tool choice never forced: the protocol default applies
  // Effort, when the model accepts it and the entry names the parameter (SPEC-MOT-025 EF-02).
  if (request.effort && caps.effort.includes(request.effort) && typeof opts["effortParameter"] === "string") body[opts["effortParameter"] as string] = request.effort;
  // Thinking switches of servers that expose them (`none`: nothing is sent).
  const on = caps.thinking === "always" || (caps.thinking === "optional" && request.thinking.enabled);
  const toggle = caps.thinking === "optional" ? opts[on ? "thinkingOn" : "thinkingOff"] : undefined;
  if (toggle && typeof toggle === "object") Object.assign(body, toggle);
  if (opts["extraBody"] && typeof opts["extraBody"] === "object") Object.assign(body, opts["extraBody"]);
  return body as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;
}

function retryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

/** Maps SDK errors (typed classes) to the neutral error kinds of SPEC-API-003. */
export function classifyOpenAIError(error: unknown, idle: boolean): ProviderError {
  if (idle) return new ProviderError("idle_timeout", "Le flux de réponse est resté inactif trop longtemps.");
  if (error instanceof ProviderError) return error;
  if (error instanceof OpenAI.APIUserAbortError) return new ProviderError("aborted", "Requête annulée.");
  if (error instanceof OpenAI.APIConnectionTimeoutError) return new ProviderError("timeout", "Délai de requête dépassé.");
  if (error instanceof OpenAI.APIConnectionError) return new ProviderError("connection", "Connexion au serveur du modèle impossible : vérifiez l'URL de base et que le serveur est démarré.");
  if (error instanceof OpenAI.AuthenticationError) return new ProviderError("authentication", "Authentification refusée par le serveur du modèle.", 401);
  if (error instanceof OpenAI.PermissionDeniedError) return new ProviderError("permission", "Accès refusé par le serveur du modèle.", 403);
  if (error instanceof OpenAI.NotFoundError) return new ProviderError("not_found", "Modèle ou point d'accès introuvable sur le serveur (vérifiez l'identifiant du modèle et l'URL de base).", 404);
  if (error instanceof OpenAI.RateLimitError) return new ProviderError("rate_limit", "Limite de débit du serveur atteinte.", 429, retryAfterMs(error.headers));
  if (error instanceof OpenAI.BadRequestError) return new ProviderError("invalid_request", `Requête refusée par le serveur : ${error.message}`, 400);
  if (error instanceof OpenAI.InternalServerError) return new ProviderError(error.status === 503 || error.status === 529 ? "overloaded" : "server", "Le serveur du modèle est indisponible.", error.status, retryAfterMs(error.headers));
  if (error instanceof OpenAI.APIError) return new ProviderError(error.status !== undefined && error.status >= 500 ? "server" : "invalid_request", `Erreur du serveur : ${error.message}`, error.status);
  return new ProviderError("malformed_response", `Réponse inattendue du serveur du modèle : ${(error as Error)?.message ?? String(error)}`);
}

interface PendingCall {
  id: string;
  name: string;
  args: string;
}

function parseArguments(args: string): unknown {
  if (args.trim() === "") return {};
  try {
    return JSON.parse(args);
  } catch {
    return args; // invalid JSON: the schema validation reports it to the model (SPEC-OUT-001 EF-02)
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: "openai" | "openai_compatible";
  readonly #client: OpenAI;
  readonly #idleTimeoutMs: number;
  readonly #network: typeof fetch | undefined;
  preconnect(): void { warmProviderConnection(this.#network, this.#client.baseURL); }

  constructor(options: OpenAICompatibleOptions) {
    this.id = options.providerId ?? "openai_compatible";
    this.#client = new OpenAI({
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.organization ? { organization: options.organization } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      // The key is optional for this provider (SPEC-API-001 § 5.1): without it, no authorization header is sent.
      apiKey: options.apiKey ?? "unused",
      maxRetries: 0, // retries follow SPEC-API-003, applied by the product (gap E-021)
      timeout: options.timeoutMs,
      defaultHeaders: { ...options.headers, ...(options.apiKey ? {} : { Authorization: null }) },
    });
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#network = options.fetch;
  }

  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    let idle = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        idle = true;
        controller.abort();
      }, this.#idleTimeoutMs);
    };
    const calls = new Map<number, PendingCall>();
    const emitted = new Set<number>();
    const toolCalls: ToolCall[] = [];
    let text = "";
    let finish: string | null = null;
    let usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    let usageReported = false;
    let requestId: string | undefined;
    const complete = (index: number): ToolCall | undefined => {
      const c = calls.get(index);
      if (!c || emitted.has(index)) return undefined;
      emitted.add(index);
      const call = { callId: c.id, name: c.name, input: parseArguments(c.args) };
      toolCalls.push(call);
      return call;
    };
    try {
      // D-5 (decision D-20): the idle limit runs from the first event of the stream; before it, the request timeout applies
      // (a local server may take minutes to process a long prompt before the first token).
      const { data: stream, request_id } = await this.#client.chat.completions.create(buildChatRequest(request), { signal: controller.signal }).withResponse();
      requestId = request_id ?? undefined;
      for await (const chunk of stream) {
        arm();
        if (chunk.usage) {
          usageReported = true;
          usage = {
            inputTokens: chunk.usage.prompt_tokens ?? 0,
            outputTokens: chunk.usage.completion_tokens ?? 0,
            cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
            cacheWriteTokens: 0,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        const delta = choice.delta as typeof choice.delta & { reasoning_content?: string; reasoning?: string };
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) yield { type: "thinking_delta", text: reasoning };
        if (delta.content) {
          text += delta.content;
          yield { type: "text_delta", text: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          // A new index means the previous calls are complete (EF-01 of SPEC-MOT-002).
          for (const index of calls.keys()) {
            if (index < tc.index) {
              const done = complete(index);
              if (done) yield { type: "tool_call", call: done };
            }
          }
          const c = calls.get(tc.index) ?? { id: tc.id ?? `call_${chunk.id}_${tc.index}`, name: "", args: "" };
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.name += tc.function.name;
          if (tc.function?.arguments) c.args += tc.function.arguments;
          calls.set(tc.index, c);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      // An aborted stream may end quietly: an idle stream, an interruption or a stream cut before its finish reason
      // is an incomplete response, never a complete one (SPEC-API-002 FA-01, SPEC-API-003 FA-01).
      if (idle) throw classifyOpenAIError(undefined, true);
      if (signal.aborted) throw new ProviderError("aborted", "Requête annulée.");
      if (finish === null) throw new ProviderError("connection", "Le flux de réponse s'est interrompu avant la fin.");
      for (const index of [...calls.keys()].sort((a, b) => a - b)) {
        const done = complete(index);
        if (done) yield { type: "tool_call", call: done };
      }
      const stopReason: StopReason = toolCalls.length > 0 && finish !== "length" ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end_turn";
      // A message without text holds `null` only next to tool calls: an empty response sent back by the relaunch of gap E-072
      // must still have a content, or the server refuses the request.
      const native: OpenAI.Chat.ChatCompletionAssistantMessageParam = { role: "assistant", content: text === "" && toolCalls.length > 0 ? null : text };
      if (toolCalls.length > 0) {
        native.tool_calls = [...calls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, c]) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } }));
      }
      yield {
        type: "message_complete",
        stopReason,
        usage,
        usageReported,
        assistant: { role: "assistant", text, toolCalls, native: { provider: this.id, content: native } },
        providerRequestId: requestId,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (signal.aborted && !idle) throw new ProviderError("aborted", "Requête annulée.");
      throw classifyOpenAIError(error, idle);
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }
}
