// Supports: SPEC-MOT-038, SPEC-MOT-040 (one private worker per purpose, cancellation and bounded exit), gap E-163.
export class MemoryJobs {
  readonly #active = new Map<string, { readonly controller: AbortController; readonly promise: Promise<void> }>();
  #closed = false;
  constructor(readonly options: { readonly signal: AbortSignal; readonly remainingMs?: () => number | undefined; readonly report: (purpose: string, error: unknown) => void }) {}
  launch(purpose: string, action: (signal: AbortSignal) => Promise<void>): boolean {
    const remaining = this.options.remainingMs?.();
    if (this.#closed || this.options.signal.aborted || this.#active.has(purpose) || remaining !== undefined && remaining <= 0) return false;
    const controller = new AbortController(), signal = AbortSignal.any([controller.signal, this.options.signal, AbortSignal.timeout(Math.min(45_000, remaining ?? 45_000))]);
    const promise = Promise.resolve().then(() => action(signal)).catch(error => { if (!signal.aborted) this.options.report(purpose, error); }).finally(() => this.#active.delete(purpose));
    this.#active.set(purpose, { controller, promise }); return true;
  }
  async close(waitMs = 0): Promise<void> {
    this.#closed = true; const jobs = [...this.#active.values()]; if (!jobs.length) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (waitMs > 0) { await Promise.race([Promise.all(jobs.map(job => job.promise)), new Promise<void>(resolve => { timer = setTimeout(resolve, waitMs); })]); if (timer) clearTimeout(timer); }
    for (const job of jobs) job.controller.abort();
    await Promise.race([Promise.all(jobs.map(job => job.promise)), new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    if (timer) clearTimeout(timer);
  }
  abort(): void { this.#closed = true; for (const job of this.#active.values()) job.controller.abort(); }
}
