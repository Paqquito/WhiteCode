// Supports: SPEC-CMD-101, gap E-161.
// Implements: SPEC-MOT-019, SPEC-OUT-043 (stable identifiers, projection, growth notices, persisted decisions).
// Supports: SPEC-SES-002, decision D-12, E-158.
import type { Conversation } from "./conversation";
import type { HistoryMessage, ModelRequest } from "../providers/types";
import type { Reminder } from "./reminders";
import type { TranscriptRecord } from "../session/transcript";

export class HistoryPruning {
  readonly #pruned = new Set<string>();
  #version = 0;
  #growth: number | undefined;
  #first: HistoryMessage | undefined;
  constructor(private readonly conversation: Conversation, readonly step: number, private readonly save: (ids: readonly string[]) => void = () => {}, records: readonly TranscriptRecord[] = []) {
    this.#first = conversation.messages[0];
    const boundary = records.findLastIndex(r => r.type === "compaction");
    for (const r of records.slice(boundary + 1)) if (r.type === "system" && r.data["event"] === "history_pruned" && Array.isArray(r.data["ids"])) {
      for (const id of r.data["ids"]) if (typeof id === "string" && /^m[1-9][0-9]*$/.test(id)) this.#pruned.add(id);
    }
  }
  #sync(): void {
    const first = this.conversation.messages[0];
    if (this.#first && first !== this.#first) { this.#pruned.clear(); this.#growth = undefined; this.#version++; }
    this.#first = first;
  }
  prune(ids: readonly string[]): { pruned: string[]; ignored: string[]; freedTokens: number } {
    this.#sync(); const pruned: string[] = [], ignored: string[] = []; let freedTokens = 0;
    for (const id of new Set(ids.slice(0, 100))) {
      const index = /^m[1-9][0-9]*$/.test(id) ? Number(id.slice(1)) - 1 : -1;
      const message = this.conversation.messages[index];
      if (!message || message.role !== "user" || message.parts.length === 0 || message.parts.some(p => p.type !== "tool_result") || this.#pruned.has(id)) { ignored.push(id); continue; }
      freedTokens += Math.ceil(JSON.stringify(message.parts).length / 4); this.#pruned.add(id); pruned.push(id);
    }
    if (pruned.length) { this.#version++; this.#growth = undefined; this.save(pruned); }
    return { pruned, ignored, freedTokens };
  }
  notices(tokens: number): Reminder[] {
    this.#sync(); if (this.#growth === undefined) { this.#growth = tokens; return []; }
    if (tokens - this.#growth < this.step) return []; this.#growth = tokens;
    return [{ type: "history_growth", text: "The context has grown. prune_history is available for tool results that are no longer useful; pruning is optional. Message identifiers appear as [mN].", priority: 1, repeatable: true }];
  }
  pruneOldLargeResults(): { pruned: string[]; ignored: string[]; freedTokens: number } {
    const candidates = this.history().slice(0, -2).flatMap((message, index) => message.role === "user" && message.parts.length > 0 && message.parts.every(part => part.type === "tool_result") && JSON.stringify(message.parts).length > 2048 ? [`m${index + 1}`] : []);
    return this.prune(candidates);
  }
  history(): readonly HistoryMessage[] {
    this.#sync(); const calls = new Map(this.conversation.messages.flatMap(m => m.role === "assistant" ? m.toolCalls.map(c => [c.callId, c] as const) : []));
    return this.conversation.messages.map((message, index): HistoryMessage => {
      const contextId = `m${index + 1}`;
      if (!this.#pruned.has(contextId) || message.role !== "user") return { ...message, contextId };
      return { ...message, contextId, parts: message.parts.map(p => {
        if (p.type !== "tool_result") return p;
        const call = calls.get(p.callId), input = call?.input as Record<string, unknown> | undefined;
        const target = input?.["path"] ?? input?.["url"] ?? input?.["command"] ?? "";
        return { ...p, content: [{ type: "text" as const, text: `[Pruned result: tool ${call?.name ?? "unknown"}, target ${JSON.stringify(target).slice(0, 200)}, removed approximately ${Math.ceil(JSON.stringify(p.content).length / 4)} tokens. Original result remains in the session transcript.]` }] };
      }) };
    });
  }
  decorate(request: ModelRequest): ModelRequest {
    const history = this.history(); return { ...request, history, segment: (request.segment ?? 0) + this.#version };
  }
}
