// Implements: SPEC-AGT-010 (complete isolated context prefix).
// Supports: SPEC-MOT-038, SPEC-MOT-040, gap E-163.
import type { HistoryMessage } from "../providers/types";

/** A call without all of its results belongs to the caller's unfinished step and cannot enter the fork. */
export function completeForkHistory(history: readonly HistoryMessage[]): HistoryMessage[] {
  const pending = new Map<string, number>();
  for (let index = 0; index < history.length; index++) {
    const message = history[index]!;
    if (message.role === "assistant") { for (const call of message.toolCalls) pending.set(call.callId, index); }
    else if (message.role === "user") { for (const part of message.parts) if (part.type === "tool_result") pending.delete(part.callId); }
  }
  const end = pending.size ? Math.min(...pending.values()) : history.length;
  return structuredClone(history.slice(0, end));
}
