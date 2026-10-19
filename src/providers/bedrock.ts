// Implements: SPEC-API-015 (CA-01, actual authenticated replay), SPEC-API-001 (common provider interface).
// Supports: AWS Converse and Signature V4 public protocols; no model or region is selected implicitly.
import { createHash, createHmac } from "node:crypto";
import type { AwsCredentials } from "../auth/cloud-credentials";
import { ProviderError, type ContentPart, type DocumentPart, type ModelEvent, type ModelProvider, type ModelRequest, type ToolCall } from "./types";

const digest = (text: string): string => createHash("sha256").update(text).digest("hex");
const encode = (text: string): string => encodeURIComponent(text).replace(/[!'()*]/g, character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
const hmac = (key: string | Buffer, text: string): Buffer => createHmac("sha256", key).update(text).digest();

/** Authentication is computed just before sending; the exported secret never becomes a request field. */
export function signBedrock(url: URL, body: string, region: string, credentials: AwsCredentials, now = new Date()): Record<string, string> {
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8);
  const headers: Record<string, string> = { "content-type": "application/json", host: url.host, "x-amz-date": date, ...(credentials.sessionToken ? { "x-amz-security-token": credentials.sessionToken } : {}) };
  const names = Object.keys(headers).sort(), signed = names.join(";");
  const query = [...url.searchParams].map(([key, value]) => [encode(key), encode(value)] as const).sort(([a, b], [c, d]) => a < c ? -1 : a > c ? 1 : b < d ? -1 : b > d ? 1 : 0).map(([key, value]) => `${key}=${value}`).join("&");
  const canonical = ["POST", url.pathname.split("/").map(encode).join("/"), query, names.map(name => `${name}:${headers[name]!.trim().replace(/\s+/g, " ")}\n`).join(""), signed, digest(body)].join("\n");
  const scope = `${day}/${region}/bedrock/aws4_request`, signing = hmac(hmac(hmac(hmac("AWS4" + credentials.secretAccessKey, day), region), "bedrock"), "aws4_request");
  const signature = createHmac("sha256", signing).update(`AWS4-HMAC-SHA256\n${date}\n${scope}\n${digest(canonical)}`).digest("hex");
  headers["authorization"] = `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
  return headers;
}
function content(part: ContentPart, request: ModelRequest): Record<string, unknown> {
  if (part.type === "text") return { text: part.text };
  if (part.type === "image") return request.model.capabilities.images ? { image: { format: part.mediaType.split("/")[1], source: { bytes: part.dataBase64 } } } : { text: "[Image omitted: the model does not accept images]" };
  return request.model.capabilities.pdf ? { document: { format: "pdf", name: "Attached document", source: { bytes: part.dataBase64 } } } : { text: "[PDF omitted: the model does not accept documents]" };
}
export function bedrockBody(request: ModelRequest): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  for (const message of request.history) {
    if (message.role === "system_note") messages.push({ role: "user", content: [{ text: message.text }] });
    else if (message.role === "assistant") messages.push({ role: "assistant", content: message.native.provider === "bedrock" ? message.native.content : [{ text: message.text }, ...message.toolCalls.map(call => ({ toolUse: { toolUseId: call.callId, name: call.name, input: call.input } }))] });
    else messages.push({ role: "user", content: message.parts.map(part => part.type === "tool_result" ? { toolResult: { toolUseId: part.callId, status: part.isError ? "error" : "success", content: part.content.map(inner => content(inner, request)) } } : content(part, request)) });
  }
  return { messages, system: request.system.map(block => ({ text: block.text })), inferenceConfig: { maxTokens: request.maxOutputTokens }, ...(request.tools.length ? { toolConfig: { tools: [...request.tools].sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(tool => ({ toolSpec: { name: tool.name, description: tool.description, inputSchema: { json: tool.inputSchema } } })) } } : {}), ...(request.model.providerOptions["additionalModelRequestFields"] ? { additionalModelRequestFields: request.model.providerOptions["additionalModelRequestFields"] } : {}) };
}
export class BedrockProvider implements ModelProvider {
  readonly id = "bedrock";
  constructor(readonly options: { readonly baseURL: string; readonly region: string; readonly credentials: AwsCredentials; readonly fetch?: typeof fetch; readonly timeoutMs: number; readonly headers: Readonly<Record<string, string>>; readonly documentAllowed?: (part: DocumentPart) => boolean }) {}
  async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
    const timed = AbortSignal.timeout(this.options.timeoutMs), combined = AbortSignal.any([signal, timed]);
    try {
      for (const message of request.history) if (message.role === "user") for (const part of message.parts) if (part.type === "document" && this.options.documentAllowed?.(part) === false) throw new ProviderError("permission", "Le document joint n'est plus autorisé par les permissions actuelles.");
      const url = new URL(this.options.baseURL.replace(/\/$/, "") + "/model/" + encode(request.model.id) + "/converse"), body = JSON.stringify(bedrockBody(request));
      const response = await (this.options.fetch ?? fetch)(url, { method: "POST", redirect: "error", signal: combined, headers: { ...this.options.headers, ...signBedrock(url, body, this.options.region, this.options.credentials) }, body });
      if (!response.ok) {
        const type = (response.headers.get("x-amzn-errortype") ?? "").split(":")[0];
        await response.body?.cancel();
        const authentication = response.status === 401 || response.status === 403 && ["ExpiredTokenException", "UnrecognizedClientException", "InvalidSignatureException"].includes(type!);
        throw new ProviderError(authentication ? "authentication" : response.status === 403 ? "permission" : response.status === 429 ? "rate_limit" : response.status >= 500 ? "server" : "invalid_request", authentication ? "Identifiants cloud expirés ou refusés." : "Requête au fournisseur cloud refusée.", response.status);
      }
      if (!response.body) throw new ProviderError("malformed_response", "Réponse cloud vide.");
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 16 * 1024 * 1024) throw new ProviderError("malformed_response", "Réponse cloud trop volumineuse."); chunks.push(next.value); } }
      finally { await reader.cancel().catch(() => undefined); }
      const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { output?: { message?: { role?: string; content?: unknown[] } }; stopReason?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number } };
      const blocks = value.output?.message?.content;
      if (value.output?.message?.role !== "assistant" || !Array.isArray(blocks)) throw new ProviderError("malformed_response", "Message cloud invalide.");
      let text = ""; const calls: ToolCall[] = [];
      for (const raw of blocks) {
        if (!raw || typeof raw !== "object") throw new ProviderError("malformed_response", "Bloc cloud invalide.");
        const block = raw as { text?: unknown; toolUse?: { toolUseId?: unknown; name?: unknown; input?: unknown } };
        if (typeof block.text === "string") { text += block.text; yield { type: "text_delta", text: block.text }; }
        else if (block.toolUse) { const call = block.toolUse; if (typeof call.toolUseId !== "string" || typeof call.name !== "string") throw new ProviderError("malformed_response", "Appel d'outil cloud invalide."); const normalized = { callId: call.toolUseId, name: call.name, input: call.input }; calls.push(normalized); yield { type: "tool_call", call: normalized }; }
      }
      const usage = value.usage, number = (n: number | undefined) => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
      yield { type: "message_complete", stopReason: value.stopReason === "tool_use" ? "tool_use" : value.stopReason === "max_tokens" ? "max_tokens" : value.stopReason === "guardrail_intervened" || value.stopReason === "content_filtered" ? "refusal" : value.stopReason === "end_turn" || value.stopReason === "stop_sequence" ? "end_turn" : "other", usage: { inputTokens: number(usage?.inputTokens), outputTokens: number(usage?.outputTokens), cacheReadTokens: number(usage?.cacheReadInputTokens), cacheWriteTokens: number(usage?.cacheWriteInputTokens) }, usageReported: !!usage && typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number", assistant: { role: "assistant", text, toolCalls: calls, native: { provider: this.id, content: blocks } }, providerRequestId: response.headers.get("x-amzn-requestid") ?? undefined };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(signal.aborted ? "aborted" : timed.aborted ? "timeout" : error instanceof SyntaxError ? "malformed_response" : "connection", signal.aborted ? "Requête cloud interrompue." : timed.aborted ? "Délai de requête cloud dépassé." : "Échange avec le fournisseur cloud impossible.");
    }
  }
}
