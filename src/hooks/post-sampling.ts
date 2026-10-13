// Implements: SPEC-HOK-009 (EF-01 to EF-04, RG-01, CA-01, CA-02).
import type { HistoryMessage } from "../providers/types";
export interface SamplingContext {
  readonly assistant: Extract<HistoryMessage, { role: "assistant" }>;
  readonly agent?: string;
  readonly minimal: boolean;
  readonly ephemeral: boolean;
}
export interface SamplingProcessor {
  readonly name: string;
  readonly timeoutMs: number;
  readonly includeSubagents?: boolean;
  readonly allowMinimal?: boolean;
  readonly allowEphemeral?: boolean;
  enabled(context: SamplingContext): boolean;
  run(context: SamplingContext, signal: AbortSignal): Promise<void>;
}
function freeze(value: unknown): void {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); }
}
/** Internal registration only; every handler receives an immutable detached copy, never the conversation. */
export class PostSampling {
  readonly #running = new Set<AbortController>();
  #closed = false;
  constructor(readonly processors: readonly SamplingProcessor[], readonly log: (name: string, error: string) => void) {}
  dispatch(context: SamplingContext): void {
    if (this.#closed) return;
    for (const processor of this.processors) {
      if (context.agent && !processor.includeSubagents || context.minimal && !processor.allowMinimal || context.ephemeral && !processor.allowEphemeral) continue;
      let copy: SamplingContext;
      try { copy = structuredClone(context); freeze(copy); }
      catch (error) { this.#failure(processor.name, error); continue; }
      const controller = new AbortController(); this.#running.add(controller);
      const timer = setTimeout(() => controller.abort(), Math.max(1, Math.min(processor.timeoutMs, 300000))); timer.unref();
      void Promise.resolve().then(async () => { if (processor.enabled(copy) && !controller.signal.aborted) await processor.run(copy, controller.signal); })
        .catch(error => this.#failure(processor.name, error))
        .finally(() => { clearTimeout(timer); this.#running.delete(controller); });
    }
  }
  #failure(name: string, error: unknown): void { try { this.log(name, error instanceof Error ? error.message : String(error)); } catch {} }
  close(): void { this.#closed = true; for (const controller of this.#running) controller.abort(); this.#running.clear(); }
}
