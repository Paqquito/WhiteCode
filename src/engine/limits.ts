// Implements: SPEC-MOD-005 (§ 5.1, § 5.2 points 2 to 5, FA-01, FA-03, FA-06, EF-01 to EF-04, EF-07, RG-02, CA-01, CA-06)
// Supports: SPEC-MOD-005 (CA-05: slots consumed before sending, shared by concurrent agents).
// Counters of one execution, shared by every turn and sub-agent (EF-04).

import type { BudgetLedger } from "./budget";

/** Reminder given to the model when a limit is near (FA-06), in the language of the texts for the model. */
export const CONVERGE_NOTE = (what: string) =>
  `Note: ${what} of this run is almost used up. Converge now: finish the most important part of the task, then give your final answer with what was done, what was verified and what remains.`;

export interface RunLimitsOptions {
  /** Iteration limit (round trips with the model); undefined = none. */
  readonly maxIterations?: number;
  /** Absolute time (ms) after which the run stops; undefined = none. */
  readonly deadline?: number;
  readonly durationSeconds?: number;
  readonly warnRatio?: number;
  readonly ledger?: BudgetLedger;
  readonly clock?: () => number;
  readonly startedAt?: number;
}

export class RunLimits {
  #iterations = 0;
  readonly #warned = new Set<string>();
  readonly #clock: () => number;
  readonly #startedAt: number;
  #stopped: { cause: "iteration_limit" | "duration_limit"; message: string } | undefined;
  readonly #stopListeners = new Set<() => void>();

  constructor(readonly options: RunLimitsOptions) {
    this.#clock = options.clock ?? Date.now;
    this.#startedAt = options.startedAt ?? this.#clock();
  }

  get iterations(): number {
    return this.#iterations;
  }

  get ledger(): BudgetLedger | undefined {
    return this.options.ledger;
  }

  countIteration(): void {
    this.#iterations++;
  }

  get stopped(): { cause: "iteration_limit" | "duration_limit"; message: string } | undefined { return this.#stopped; }

  stop(reason: { cause: "iteration_limit" | "duration_limit"; message: string }): void {
    if (this.#stopped) return;
    this.#stopped = reason;
    for (const listener of this.#stopListeners) listener();
  }

  onStop(listener: () => void): () => void {
    this.#stopListeners.add(listener);
    if (this.#stopped) listener();
    return () => { this.#stopListeners.delete(listener); };
  }

  /** Checked before each request (§ 5.2 point 3). */
  beforeRequest(): { cause: "iteration_limit" | "duration_limit"; message: string } | undefined {
    if (this.#stopped) return this.#stopped;
    const o = this.options;
    if (o.maxIterations !== undefined && this.#iterations >= o.maxIterations) return { cause: "iteration_limit", message: `Nombre maximal d'itérations atteint (${o.maxIterations}).` };
    if (this.deadlineReached()) return { cause: "duration_limit", message: `Durée maximale atteinte (${o.durationSeconds ?? "?"} s).` };
    return undefined;
  }

  deadlineReached(): boolean {
    return this.options.deadline !== undefined && this.#clock() >= this.options.deadline;
  }

  /** Milliseconds before the deadline, or undefined. */
  remainingMs(): number | undefined {
    return this.options.deadline === undefined ? undefined : Math.max(0, this.options.deadline - this.#clock());
  }

  /**
   * FA-06, EF-07: once per limit, at `warnRatio` of it, a warning for the user and a note asking the model to converge.
   * Returns the notes to add before the next request.
   */
  approaching(warn: (message: string) => void): string[] {
    const ratio = this.options.warnRatio ?? 0.8;
    const notes: string[] = [];
    const check = (key: string, used: number, limit: number | undefined, label: string, what: string) => {
      if (limit === undefined || limit <= 0 || this.#warned.has(key) || used < ratio * limit) return;
      this.#warned.add(key);
      warn(`${label} : ${Math.round((used / limit) * 100)} % de la limite atteints.`);
      notes.push(CONVERGE_NOTE(what));
    };
    const o = this.options;
    check("iterations", this.#iterations, o.maxIterations, "Itérations", "the iteration budget");
    if (o.deadline !== undefined) check("duration", this.#clock() - this.#startedAt, o.deadline - this.#startedAt, "Durée", "the time budget");
    const s = o.ledger?.snapshot;
    if (s?.cap !== undefined) check("cost", s.conservative + s.reserved, s.cap, "Coût", "the cost budget");
    return notes;
  }
}
