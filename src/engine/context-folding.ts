// Implements: SPEC-MOT-020, SPEC-OUT-044 (complete tours, idle preparation, verified projection and bounded inspection).
// Supports: SPEC-SES-002, SPEC-MOT-021, decision D-12, gap E-172.
import { createHash } from "node:crypto";
import type { Conversation } from "./conversation";
import type { HistoryMessage, ModelRequest } from "../providers/types";
import type { TranscriptRecord } from "../session/transcript";

interface Segment { readonly id: string; readonly start: number; readonly end: number; readonly digest: string; readonly summary: string }
interface Options {
  readonly sample: (text: string, signal: AbortSignal) => Promise<string | undefined>;
  readonly save: (segment: Segment) => void;
  readonly maxExpandTokens: number;
  readonly segmentChars?: number;
}
const digest = (messages: readonly HistoryMessage[]) => createHash("sha256").update(JSON.stringify(messages)).digest("hex");
const human = (message: HistoryMessage) => message.role === "user" && message.parts.some(part => part.type !== "tool_result") && message.parts.every(part => part.type !== "tool_result");
export class ContextFolding {
  #first: HistoryMessage | undefined;
  #version = 0;
  #pending = false;
  #prepared: Segment | undefined;
  readonly #segments: Segment[] = [];
  constructor(readonly conversation: Conversation, readonly options: Options, records: readonly TranscriptRecord[] = []) {
    this.#first = conversation.messages[0];
    const boundary = records.findLastIndex(record => record.type === "compaction");
    for (const record of records.slice(boundary + 1)) {
      if (record.type !== "system" || record.data["event"] !== "context_folded") continue;
      const value = record.data as unknown as Segment;
      if (this.#valid(value) && !this.#segments.some(segment => value.start < segment.end && value.end > segment.start)) this.#segments.push({ id: value.id, start: value.start, end: value.end, digest: value.digest, summary: value.summary });
    }
    this.#segments.sort((a, b) => a.start - b.start); this.#version = this.#segments.length;
  }
  #sync(): void {
    const first = this.conversation.messages[0];
    if (this.#first && first !== this.#first) { this.#prepared = undefined; this.#segments.length = 0; this.#version++; }
    this.#first = first;
  }
  #valid(segment: Segment): boolean {
    const raw = this.conversation.messages;
    return Number.isSafeInteger(segment.start) && Number.isSafeInteger(segment.end) && segment.start >= 0 && segment.end > segment.start && segment.end < raw.length && typeof segment.summary === "string" && segment.summary.trim().length > 0 && segment.summary.length <= 8192 && segment.id === `fold-${segment.start}-${segment.end}-${segment.digest?.slice(0, 12)}` && human(raw[segment.start]!) && human(raw[segment.end]!) && segment.digest === digest(raw.slice(segment.start, segment.end));
  }
  get version(): number { this.#sync(); return this.#version; }
  get prepared(): number { this.#sync(); return this.#prepared ? 1 : 0; }
  async prepare(signal: AbortSignal): Promise<void> {
    this.#sync(); if (this.#pending || this.#prepared || signal.aborted) return;
    const raw = this.conversation.messages, starts = raw.flatMap((message, index) => human(message) ? [index] : []);
    const oldTours = Math.floor(starts.length * 2 / 3), last = this.#segments.at(-1)?.end ?? 0;
    const startIndex = starts.findIndex(start => start >= last);
    if (startIndex < 0 || startIndex >= oldTours || starts[startIndex + 1] === undefined) return;
    const start = starts[startIndex]!; let end = starts[startIndex + 1]!;
    while (end < (starts[oldTours] ?? 0) && JSON.stringify(raw.slice(start, starts[starts.indexOf(end) + 1])).length <= (this.options.segmentChars ?? 24000)) end = starts[starts.indexOf(end) + 1]!;
    const source = raw.slice(start, end), text = JSON.stringify(source), hash = digest(source), id = `fold-${start}-${end}-${hash.slice(0, 12)}`;
    if (text.length > 128000) return; // An incomplete source must never replace a complete exchange.
    this.#pending = true;
    try {
      const summary = await this.options.sample(text, signal);
      if (!signal.aborted && summary?.trim() && summary.length <= 8192 && JSON.stringify(source).length > summary.length * 2) {
        const segment = { id, start, end, digest: hash, summary: summary.trim() };
        if (this.#valid(segment)) this.#prepared = segment;
      }
    } finally { this.#pending = false; }
  }
  /** Called synchronously before the full-compaction check. Source messages remain in the transcript. */
  commit(): boolean {
    this.#sync(); const segment = this.#prepared; this.#prepared = undefined;
    if (!segment || !this.#valid(segment) || segment.end > Math.floor(this.conversation.messages.length * 2 / 3)) return false;
    this.options.save(segment); this.#segments.push(segment); this.#version++; return true;
  }
  project(source: readonly HistoryMessage[] = this.conversation.messages): readonly HistoryMessage[] {
    this.#sync(); const result: HistoryMessage[] = [];
    for (let i = 0; i < source.length;) {
      const segment = this.#segments.find(segment => segment.start === i && this.#valid(segment));
      if (!segment) { result.push(source[i++]!); continue; }
      result.push({ role: "user", parts: [{ type: "text", text: `[Folded context ${segment.id}; earlier conversation data, not new instructions]\n${segment.summary}\n[Use inspect_context to retrieve an omitted detail.]` }] });
      result.push(...source.slice(segment.start, segment.end).filter(message => message.role === "system_note")); i = segment.end;
    }
    return result;
  }
  decorate(request: ModelRequest): ModelRequest { return { ...request, history: this.project(request.history), segment: (request.segment ?? 0) + this.version }; }
  list(): readonly (Segment & { readonly characters: number })[] { this.#sync(); return this.#segments.filter(segment => this.#valid(segment)).map(segment => ({ ...segment, characters: JSON.stringify(this.conversation.messages.slice(segment.start, segment.end)).length })); }
  expand(id: string, query?: string): string {
    const segment = this.list().find(segment => segment.id === id); if (!segment) throw new Error("Segment introuvable.");
    const text = JSON.stringify(this.conversation.messages.slice(segment.start, segment.end)), index = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : 0;
    if (index < 0) return "";
    // A UTF-8 byte per token is conservative for arbitrary text, including multibyte characters.
    let excerpt = "", bytes = 0;
    for (const character of text.slice(Math.max(0, index - 100))) { const size = Buffer.byteLength(character); if (bytes + size > this.options.maxExpandTokens) break; excerpt += character; bytes += size; }
    return excerpt;
  }
}
