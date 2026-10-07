// Implements: SPEC-API-005 (§ 5.3 steps 1 to 3, § 5.5, FA-01, EF-01, EF-03, CA-01, CA-02)
// Backup model: after a number of consecutive overloads of the main model, requests go to the backup model for a
// cooling period, then back to the main model.

import type { ResolvedModel } from "../providers/catalog";

export class FallbackPolicy {
  readonly #main: ResolvedModel;
  readonly #backup: ResolvedModel;
  readonly #threshold: number;
  readonly #cooldownMs: number;
  readonly #clock: () => number;
  #overloads = 0;
  #until: number | undefined;

  constructor(o: { main: ResolvedModel; backup: ResolvedModel; threshold: number; cooldownMs: number; clock?: () => number }) {
    this.#main = o.main;
    this.#backup = o.backup;
    this.#threshold = o.threshold;
    this.#cooldownMs = o.cooldownMs;
    this.#clock = o.clock ?? Date.now;
  }

  get backup(): ResolvedModel {
    return this.#backup;
  }

  /** Model for the next request; EF-03: back to the main model once the cooling period is over (CA-02). */
  model(): ResolvedModel {
    if (this.#until !== undefined && this.#clock() >= this.#until) this.#until = undefined;
    return this.#until === undefined ? this.#main : this.#backup;
  }

  /** Step 1: an overload of the main model; true when the next attempt switches to the backup model (step 2, CA-01). */
  overloaded(model: ResolvedModel): boolean {
    if (model !== this.#main) return false; // FA-01: an overloaded backup follows the normal retries
    this.#overloads++;
    if (this.#overloads < this.#threshold) return false;
    this.#overloads = 0;
    this.#until = this.#clock() + this.#cooldownMs; // step 3
    return true;
  }

  /** A response was obtained: the overloads were not consecutive. */
  succeeded(): void {
    this.#overloads = 0;
  }
}
