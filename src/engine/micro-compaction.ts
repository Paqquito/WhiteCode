// Implements: SPEC-MOT-013 (§ 5.1 to 5.4, FA-01, EF-01 to EF-04, RG-01, CA-01, CA-02), SPEC-MOT-014 (EF-02 never on the contents cleared by the service)
// Supports: decision D-12 (only for models whose history is not append-only)

import type { ToolResultPart } from "../providers/types";
import type { Conversation } from "./conversation";

/** Tools whose results can be removed: reads, searches, commands, web access (§ 5.1). Writes describe the produced state: kept (EF-01). */
export const COMPACTABLE_TOOLS: ReadonlySet<string> = new Set(["read_file", "find_files", "search_content", "run_shell", "run_powershell", "fetch_url", "search_web"]);

/** RG-01: the model learns that the content can be read again. */
export const CLEARED_MARKER = "[Old tool result removed to save context. Call the tool again if you need this content.]";

/** Replaces the content of every compactable result except the `keepRecent` most recent ones; returns how many were replaced. */
export function microCompact(conversation: Conversation, keepRecent: number): number {
  const toolOf = new Map<string, string>();
  for (const m of conversation.messages) if (m.role === "assistant") for (const c of m.toolCalls) toolOf.set(c.callId, c.name);
  const compactable: string[] = [];
  for (const m of conversation.messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "tool_result" || !COMPACTABLE_TOOLS.has(toolOf.get(p.callId) ?? "")) continue;
      if (p.content.length === 1 && p.content[0]!.type === "text" && p.content[0]!.text === CLEARED_MARKER) continue; // already removed
      compactable.push(p.callId);
    }
  }
  // Oldest first; the most recent are kept intact (EF-02).
  const toClear = new Set(compactable.slice(0, Math.max(0, compactable.length - keepRecent)));
  if (toClear.size === 0) return 0; // FA-01
  // Old images go too (step 4): the whole content of the result is replaced by the marker.
  return conversation.rewriteToolResults((p): ToolResultPart | undefined => (toClear.has(p.callId) ? { ...p, content: [{ type: "text", text: CLEARED_MARKER }] } : undefined));
}
