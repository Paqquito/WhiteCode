// Implements: SPEC-CMD-028 (CA-01, EF-01, RG-01), gap E-153.
import type { HistoryMessage } from "../providers/types";
import { CLEARED_MARKER } from "../engine/micro-compaction";
export interface ContextFile { path: string; state: "complet" | "partiel" | "retiré"; tokens: number; ranges: string[]; }
export function contextFiles(messages: readonly HistoryMessage[]): ContextFile[] {
  const calls = new Map<string, string>(), files = new Map<string, ContextFile>();
  const add = (path: string, content: string, partial = false) => {
    const removed = content === CLEARED_MARKER;
    const row = files.get(path) ?? { path, state: "retiré" as const, tokens: 0, ranges: [] };
    if (!removed) { row.tokens += Math.ceil(content.length / 4); const range = /Showing lines (\d+) to (\d+) of (\d+)/.exec(content); const incomplete = partial || !!range || /line.*truncated|\[… truncated\]/.test(content);
      if (!incomplete) row.state = "complet"; else if (row.state !== "complet") row.state = "partiel";
      if (range) row.ranges.push(`${range[1]}–${range[2]} / ${range[3]}`);
    }
    files.set(path, row);
  };
  for (const message of messages) {
    if (message.role === "assistant") { for (const call of message.toolCalls) if (call.name === "read_file" && typeof (call.input as { path?: unknown })?.path === "string") calls.set(call.callId, (call.input as { path: string }).path); continue; }
    if (message.role !== "user") continue;
    for (const part of message.parts) {
      if (part.type === "tool_result" && !part.isError) { const path = calls.get(part.callId); if (!path) continue; add(path, part.content.map(row => row.type === "text" ? row.text : "[image]").join("\n")); }
      if (part.type === "text") {
        for (const match of part.text.matchAll(/<attached-file\s+path="([^"]+)"([^>]*)>\n([\s\S]*?)\n<\/attached-file>/g)) add(match[1]!, match[3]!, /partial|truncated/.test(match[2]!));
        const restored = /^Restored after the compaction, current content of (.+):\n([\s\S]*)$/.exec(part.text); if (restored) add(restored[1]!, restored[2]!);
      }
    }
  }
  return [...files.values()].sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path));
}
