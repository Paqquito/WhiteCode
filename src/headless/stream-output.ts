// Implements: SPEC-MOD-003 (§ 5.3 event types, § 5.4 points 3 and 4, FA-04, EF-02 to EF-06, RG-01, RG-02, CA-01, CA-02, CA-06, edge cases: large events, control characters)
// Supports: decision D-03 (`jsonl` in increment 2), gaps E-016 (`toolId` carries the tool name), E-050 (input messages)

import type { EngineEvent } from "../engine/events";
import type { ContentPart, ToolResultPart } from "../providers/types";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
// Implements: SPEC-OBS-022 (CA-01 to CA-03, EF-01 to EF-04, EF-06, RG-01), gap E-149.

/**
 * One JSON object per line (EF-02), written as soon as it is produced. Line separators that JSON leaves raw
 * (U+2028, U+2029) are escaped too, so that a reader splitting on any line break still gets whole objects (RG-02, CA-06).
 */
export function jsonLine(value: unknown): string {
  return `${JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")}\n`;
}

const TRUNCATION_MARK = "[… truncated]";

/** Shortens the longest strings of an event until it fits in `maxBytes` (edge case of § 8); marks it `truncated`. */
export function fitEvent(event: Record<string, unknown>, maxBytes: number): Record<string, unknown> {
  let line = jsonLine(event);
  if (Buffer.byteLength(line, "utf8") <= maxBytes) return event;
  const copy = structuredClone(event) as Record<string, unknown>;
  copy["truncated"] = true;
  for (let guard = 0; guard < 64; guard++) {
    // Find the longest string anywhere in the event.
    let best: { holder: Record<string, unknown> | unknown[]; key: string | number; length: number } | undefined;
    const walk = (node: unknown) => {
      if (Array.isArray(node)) node.forEach((v, i) => (typeof v === "string" ? consider(node, i, v) : walk(v)));
      else if (node && typeof node === "object") for (const [k, v] of Object.entries(node)) typeof v === "string" ? consider(node as Record<string, unknown>, k, v) : walk(v);
    };
    const consider = (holder: Record<string, unknown> | unknown[], key: string | number, v: string) => {
      if (!best || v.length > best.length) best = { holder, key, length: v.length };
    };
    walk(copy);
    if (!best) break;
    const found = best as { holder: Record<string, unknown> | unknown[]; key: string | number; length: number };
    const excess = Buffer.byteLength(line, "utf8") - maxBytes;
    const keep = Math.max(0, found.length - Math.max(excess, Math.ceil(found.length / 2)) - TRUNCATION_MARK.length);
    const value = (found.holder as Record<string | number, string>)[found.key]!;
    (found.holder as Record<string | number, unknown>)[found.key] = `${value.slice(0, keep)}${TRUNCATION_MARK}`;
    line = jsonLine(copy);
    if (Buffer.byteLength(line, "utf8") <= maxBytes) break;
  }
  return copy;
}

/** Content of a message in the stream: text parts as text, images as their type only. */
function streamContent(content: ReadonlyArray<ContentPart | ToolResultPart>): unknown[] {
  return content.map((p) => {
    if (p.type === "text") return { type: "text", text: p.text };
    if (p.type === "image") return { type: "image", mediaType: p.mediaType };
    return {
      type: "tool_result",
      callId: p.callId,
      errored: p.isError,
      content: p.content.map((c) => (c.type === "text" ? { type: "text", text: c.text } : { type: "image", mediaType: c.mediaType })),
    };
  });
}

export interface StreamOptions {
  readonly write: (text: string) => void;
  readonly includeThinking: boolean;
  readonly maxEventSize: number;
  readonly now: () => Date;
  readonly profile?: "standard" | "compact";
  readonly serializationStarted?: () => ((sizeBytes: number) => void) | undefined;
}

/** Writer of the `jsonl` format. Every event carries a type, a timestamp and the session id (EF-03). */
export class EventStream {
  #sessionId: string | null = null;
  #closed = false;
  readonly #counts = new Map<string, number>();

  constructor(private readonly options: StreamOptions) {}

  get profile(): "standard" | "compact" { return buildFlag("stream_compact_profile") ? this.options.profile ?? "standard" : "standard"; }

  set sessionId(id: string) {
    this.#sessionId = id;
  }

  get closed(): boolean {
    return this.#closed;
  }

  emit(type: string, fields: Record<string, unknown>): void {
    if (this.#closed) return;
    const event = { type, timestamp: this.options.now().toISOString(), sessionId: this.#sessionId, ...fields };
    const ended = this.options.serializationStarted?.();
    const line = jsonLine(fitEvent(event, this.options.maxEventSize));
    ended?.(Buffer.byteLength(line, "utf8"));
    this.options.write(line);
  }

  /** Engine events mapped to the event types of § 5.3; others are not written. */
  engine(e: EngineEvent): void {
    if (buildFlag("stream_compact_profile") && this.options.profile === "compact") {
      if (e.type === "thinking_delta" || e.type === "tool_call" || e.type === "user_message") return;
      if (e.type === "tool_result") {
        if (e.isError) this.emit("error", { code: "tool_error", callId: e.callId, message: e.output, elapsedMs: e.durationMs });
        return;
      }
      if (e.type === "text_delta") { this.#counts.clear(); return this.emit("assistant", { content: e.text, partial: true }); }
      if (e.type === "assistant_message") {
        if (e.text !== "") { this.#counts.clear(); return this.emit("assistant", { content: e.text, partial: false }); }
        for (const call of e.toolCalls) {
          const category = call.name === "read_file" ? "lecture" : ["find_files", "search_content", "search_web"].includes(call.name) ? "recherche" : ["write_file", "edit_file", "edit_notebook"].includes(call.name) ? "modification" : ["run_shell", "run_powershell"].includes(call.name) ? "commande" : "autre";
          this.#counts.set(category, (this.#counts.get(category) ?? 0) + 1);
        }
        if (this.#counts.size > 0) {
          const label = [...this.#counts].map(([category, count]) => category === "lecture" ? `${count} fichier${count > 1 ? "s lus" : " lu"}` : `${count} ${category}${count > 1 ? "s" : ""}`).join(", ");
          this.emit("tool_summary", { label, counts: Object.fromEntries(this.#counts) });
        }
        return;
      }
    }
    switch (e.type) {
      case "text_delta":
        return this.emit("assistant", { content: e.text, partial: true });
      case "assistant_message":
        return this.emit("assistant", { content: e.text, partial: false, toolCalls: e.toolCalls.map((c) => ({ callId: c.callId, toolId: c.name, input: c.input })) });
      case "user_message":
        return this.emit("user", { content: streamContent(e.content), ...(e.synthetic ? { synthetic: true } : {}) });
      case "thinking_delta":
        if (this.options.includeThinking) this.emit("thinking", { content: e.text }); // FA-04
        return;
      case "tool_call":
        return this.emit("tool_call", { toolId: e.name, input: e.input, callId: e.callId });
      case "tool_result":
        return this.emit("tool_result", { callId: e.callId, output: e.output, errored: e.isError, elapsedMs: e.durationMs });
      case "permission":
        return this.emit("permission", { callId: e.callId, decision: e.decision, reason: e.reason });
      case "warning":
        return this.emit("error", { code: "warning", message: e.message });
      case "retry":
        return this.emit("progress", { label: `retry ${e.attempt + 1}/${e.maxRetries + 1} in ${e.delayMs} ms: ${e.reason}`, attempt: e.attempt, delayMs: e.delayMs });
      case "response_restarted":
        // The partial assistant fragments written so far are replaced by the new attempt (FA-01 of SPEC-API-003).
        return this.emit("progress", { label: "response restarted", restarted: true });
      case "loop_detected":
        return this.emit("error", { code: "unproductive_loop_detected", message: `Repeated call to ${e.toolName} (${e.count} times).`, callId: e.callId });
      default:
        return;
    }
  }

  /** Closing event: exactly once, last (EF-04). */
  close(fields: Record<string, unknown>): void {
    if (this.#closed) return;
    this.emit("run_completed", fields);
    this.#closed = true;
  }
}
