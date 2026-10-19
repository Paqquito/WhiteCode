// Implements: SPEC-MOD-027, SPEC-CMD-100, SPEC-OUT-023.
// Supports: gap E-166.
import type { Tool } from "../tools/types";
import { textOutcome } from "../tools/types";
export type WakeCause = "deadline" | "message" | "notification" | "wake" | "interruption";
export class WakeEvents {
  readonly #listeners = new Set<(cause: WakeCause) => void>();
  #pending?: WakeCause;
  get waiting(): number { return this.#listeners.size; }
  acknowledge(): void { this.#pending = undefined; }
  emit(cause: WakeCause): void { this.#pending = cause; for (const listener of [...this.#listeners]) listener(cause); }
  wait(durationMs: number, tickMs: number, signal: AbortSignal): Promise<{ cause: WakeCause; elapsedMs: number }> {
    const started = performance.now();
    return new Promise(resolve => {
      let settled = false;
      const finish = (cause: WakeCause) => { if (settled) return; settled = true; this.#pending = undefined; clearTimeout(timer); signal.removeEventListener("abort", abort); this.#listeners.delete(finish); resolve({ cause, elapsedMs: performance.now() - started }); };
      const abort = () => finish("interruption");
      const timer = setTimeout(() => finish(durationMs <= tickMs ? "deadline" : "wake"), Math.min(durationMs, tickMs));
      this.#listeners.add(finish); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      else if (this.#pending) finish(this.#pending);
    });
  }
}
export interface WaitInput { readonly duration: number; readonly reason?: string }
export function waitTool(options: { readonly events: WakeEvents; readonly enabled: () => boolean; readonly maxMs: () => number; readonly tickMs: () => number; readonly waiting: (until?: number) => void }): Tool<WaitInput> {
  const bounded = (duration: number) => Math.max(1000, Math.min(3600000, options.maxMs(), duration * 1000));
  return {
    name: "wait", idleWait: true, inputSchema: { type: "object", properties: { duration: { type: "number" }, reason: { type: "string", maxLength: 500 } }, required: ["duration"], additionalProperties: false },
    description: () => "Wait without a shell process until the deadline, a user message, a task notification or a wake signal. Use this only while proactive mode or persistent assistant mode is active. Every wake consumes another model request, and the context cache expires after inactivity. Duration is in seconds, clamped to 1–3600 and the configured maximum.",
    flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: options.enabled,
    validate: () => options.enabled() ? undefined : "Waiting requires an active proactive or persistent assistant mode.",
    permissionContribution: () => "allow", ruleSubject: () => ({ kind: "none" }),
    summary: input => `Veille jusqu’à ${new Date(Date.now() + bounded(input.duration)).toLocaleTimeString("fr-FR")}`,
    timeoutMs: input => bounded(input.duration) + 1000,
    async execute(input, ctx) {
      if (!options.enabled()) return textOutcome("Waiting requires an active proactive or persistent assistant mode.", true, "unavailable");
      const duration = bounded(input.duration); options.waiting(Date.now() + duration);
      try { const result = await options.events.wait(duration, Math.max(1000, options.tickMs()), ctx.signal); return textOutcome(JSON.stringify({ cause: result.cause, duration_seconds: result.elapsedMs / 1000, ...(duration !== input.duration * 1000 ? { adjusted_duration_seconds: duration / 1000 } : {}) })); }
      finally { options.waiting(undefined); }
    },
  };
}
export class ProactiveWake {
  #active = false;
  #next?: number;
  #cooldown = 0;
  #interval = 0;
  readonly #timer: ReturnType<typeof setInterval>;
  constructor(readonly options: { readonly now: () => number; readonly intervalMs: () => number; readonly ready: () => boolean; readonly pressure: () => boolean; readonly submit: (message: string) => boolean; readonly changed: () => void }) { this.#timer = setInterval(() => this.poll(), 250); }
  get active(): boolean { return this.#active; }
  toggle(): boolean { this.#active = !this.#active; this.activity(); this.options.changed(); return this.#active; }
  activity(): void { this.#next = undefined; }
  backoff(ms: number): void { this.#cooldown = Math.max(this.#cooldown, this.options.now() + Math.max(60000, ms)); this.activity(); }
  poll(): void {
    if (!this.#active || !this.options.ready()) { this.#next = undefined; return; }
    const now = this.options.now(), interval = Math.max(60000, this.options.intervalMs()) * (this.options.pressure() ? 4 : 1);
    if (interval !== this.#interval) { this.#interval = interval; this.#next = undefined; }
    this.#next ??= Math.max(now + interval, this.#cooldown);
    if (now < this.#next) return;
    this.#next = Math.max(now + interval, this.#cooldown);
    if (this.options.submit(`[Proactive wake at ${new Date(now).toISOString()}; the session has been idle. Ordinary permissions and budgets apply. Act only when useful; otherwise prefer waiting. Every wake consumes a model request.]`)) this.options.changed();
  }
  close(): void { clearInterval(this.#timer); this.#active = false; this.#next = undefined; }
}
