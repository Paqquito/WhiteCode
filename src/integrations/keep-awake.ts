// Implements: SPEC-INT-022 (shared active-work lease, quiet fallback, bounded release), gap E-218.
import type { AwakeRelease } from "../platform/keep-awake";
export class KeepAwake {
  #desired = false;
  #closed = false;
  #failed = false;
  #opening?: Promise<void>;
  #release?: AwakeRelease;
  #stopping: Promise<void> = Promise.resolve();
  #timer?: ReturnType<typeof setTimeout>;
  constructor(
    readonly options: {
      enabled: () => boolean;
      acquire: () => Promise<AwakeRelease>;
      releaseDelayMs?: number;
    },
  ) {}
  update(active: boolean): void {
    const desired = !this.#closed && this.options.enabled() && active;
    if (desired !== this.#desired) this.#failed = false;
    this.#desired = desired;
    clearTimeout(this.#timer);
    if (desired) {
      if (!this.#release && !this.#opening && !this.#failed)
        this.#opening = (async () => {
          await this.#stopping;
          if (!this.#desired) return;
          try {
            const release = await this.options.acquire();
            if (this.#closed || !this.#desired) await release();
            else this.#release = release;
          } catch {
            this.#failed = true;
          }
        })().finally(() => {
          this.#opening = undefined;
        });
    } else if (this.#release)
      this.#timer = setTimeout(() => {
        if (!this.#desired) void this.#drop();
      }, this.options.releaseDelayMs ?? 250);
  }
  async #drop(): Promise<void> {
    const release = this.#release;
    this.#release = undefined;
    if (release) this.#stopping = this.#stopping.then(release).catch(() => {});
    await this.#stopping;
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#desired = false;
    clearTimeout(this.#timer);
    await this.#opening;
    await this.#drop();
  }
}
