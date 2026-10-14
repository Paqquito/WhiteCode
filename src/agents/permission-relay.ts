// Supports: SPEC-AGT-014 (FIFO permission relay with one deadline), SPEC-PER-001 (cancellation), gap E-168.
/** Shared by every member of one team; includes waiting and every approval authority in one deadline. */
export class TeamPermissionQueue {
  #tail: Promise<void> = Promise.resolve();
  readonly #deadlines = new WeakMap<AbortSignal, { readonly at: number; readonly controller: AbortController }>();
  constructor(readonly timeoutMs: () => number) {}
  expired(signal: AbortSignal): boolean {
    const deadline = this.#deadlines.get(signal);
    if (deadline && Date.now() >= deadline.at) { deadline.controller.abort(); return true; }
    return signal.aborted;
  }
  async run<T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const previous = this.#tail;
    let release!: () => void;
    const slot = new Promise<void>(resolve => { release = resolve; });
    this.#tail = previous.then(() => slot);
    const controller = new AbortController(), active = AbortSignal.any([signal, controller.signal]);
    const timeoutMs = this.timeoutMs(); this.#deadlines.set(active, { at: Date.now() + timeoutMs, controller });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let abort = () => {};
    const cancelled = new Promise<undefined>(resolve => { abort = () => resolve(undefined); active.addEventListener("abort", abort, { once: true }); if (active.aborted) abort(); });
    try {
      const work = previous.then(() => this.expired(active) ? undefined : action(active));
      const result = await Promise.race([work, cancelled]);
      return this.expired(active) ? undefined : result;
    } finally { clearTimeout(timer); active.removeEventListener("abort", abort); controller.abort(); release(); }
  }
}
