// Implements: SPEC-MOT-034 (bounded per-thread diagnostics, expiry exclusion, no contents in logs).
// Supports: SPEC-API-002, SPEC-OBS-012, E-158.
import { createHash } from "node:crypto";
import type { ModelProvider } from "./types";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
interface Previous { time: number; cache: number; model: string; system: string; tools: string; history: string; length: number; segment?: number }
export function withCacheDiagnostics(provider: ModelProvider, options: { maxThreads: number; clock?: () => number; log: (diagnostic: { cause: "instructions" | "tools" | "history" | "unexplained"; lostTokens: number; expected: boolean }) => void }): ModelProvider {
  const threads = new Map<string, Previous>(), now = options.clock ?? Date.now;
  return { id: provider.id, async *stream(request, signal) {
    const tracked = !request.purpose || request.purpose === "main" || request.purpose === "subagent" || request.purpose === "compaction";
    const key = `${request.conversationId ?? "session"}\0${request.agent ?? "main"}`;
    const previous = tracked ? threads.get(key) : undefined;
    for await (const event of provider.stream(request, signal)) {
      if (tracked && event.type === "message_complete" && event.usageReported !== false) {
        const current: Previous = { time: now(), cache: event.usage.cacheReadTokens, model: request.model.id, system: hash(request.system), tools: hash(request.tools), history: hash(request.history), length: request.history.length, segment: request.segment };
        // Conservative five-minute lifetime; larger provider lifetimes may be configured in a future calibration.
        if (previous && previous.model === current.model && current.time - previous.time < 300_000 && previous.cache - current.cache >= 1000 && current.cache < previous.cache / 2) {
          const cause = previous.system !== current.system ? "instructions" : previous.tools !== current.tools ? "tools" : previous.history !== hash(request.history.slice(0, previous.length)) ? "history" : "unexplained";
          try { options.log({ cause, lostTokens: previous.cache - current.cache, expected: request.purpose === "compaction" }); } catch { /* Diagnostics never interrupt a model response. */ }
        }
        threads.delete(key); threads.set(key, current);
        while (threads.size > Math.max(1, Math.min(100, options.maxThreads))) threads.delete(threads.keys().next().value!);
      }
      yield event;
    }
  } };
}
