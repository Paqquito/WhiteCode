// Implements: SPEC-MOT-046 (§ 4, § 5.1 to 5.4, FA-01 to FA-03, EF-01 to EF-04, RG-01, RG-02, CA-01 to CA-09), SPEC-MOT-001 (CA-10)
// Supports: gap E-006 (reset by a changed result, series of failures by tool, fingerprint of content and status)

import { createHash } from "node:crypto";
import type { ContentPart } from "../providers/types";

/** Tools whose repetition is normal: consulting a background task, waiting (§ 5.1). They count as a different call. */
export const REPEATABLE_TOOLS: ReadonlySet<string> = new Set(["background_output", "wait"]);
/** Tools that write files: a successful call resets the series of identical calls (§ 5.1). */
const FILE_WRITERS: ReadonlySet<string> = new Set(["write_file", "edit_file", "update_notebook_cell"]);

/** Canonical form of the input: object keys sorted, values compared as they are (§ 4). */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprint(isError: boolean, content: readonly ContentPart[]): string {
  const h = createHash("sha256");
  h.update(isError ? "error\n" : "ok\n");
  for (const c of content) h.update(c.type === "text" ? `t:${c.text}` : `i:${c.mediaType}:${c.dataBase64}`);
  return h.digest("hex");
}

export interface GuardEntry {
  readonly key: string;
  readonly toolName: string;
  /** Fingerprint of the result, once known. */
  result?: string;
}

export type GuardVerdict = { readonly suspend: false; readonly entry?: GuardEntry } | { readonly suspend: true; readonly entry: GuardEntry; readonly count: number };

export const REPETITION_REMINDER = (count: number) =>
  `This exact call was already made ${count - 1} times in a row with the same result, so it was not executed again. Repeating it will not help: change your approach, or explain what is blocking you.`;
export const FAILURE_REMINDER = (count: number) =>
  `This tool failed ${count} times in a row with the same error. Do not retry the same way: read the error, check your assumptions (for example read the file again), and change your approach.`;

/** Series of one agent: identical calls, and identical failures by tool. */
export class LoopGuard {
  #series: GuardEntry[] = [];
  readonly #failures = new Map<string, { message: string; count: number }>();
  /** Tools for which the user chose "continue": no suspension until the next turn (FA-02). */
  readonly #continued = new Set<string>();
  #loopsInTurn = 0;

  constructor(
    readonly threshold: number,
    readonly enabled = true,
  ) {}

  /** A user message resets both series (§ 5.1). */
  newTurn(): void {
    this.#series = [];
    this.#failures.clear();
    this.#continued.clear();
    this.#loopsInTurn = 0;
  }

  /** A compaction resets both series too. */
  compacted(): void {
    this.#series = [];
    this.#failures.clear();
  }

  /**
   * Arrival of a complete call, before the hook and the permission decision (§ 5.1). Parallel identical calls,
   * whose results are still unknown, count as consecutive (edge case of § 8).
   */
  check(toolName: string, input: unknown): GuardVerdict {
    if (!this.enabled) return { suspend: false };
    if (REPEATABLE_TOOLS.has(toolName)) {
      this.#series = [];
      return { suspend: false };
    }
    const key = `${toolName}\u0000${canonical(input)}`;
    const last = this.#series[this.#series.length - 1];
    if (last && last.key !== key) this.#series = [];
    // E-006 (a): a changed result restarts the series at the call after the change.
    let count = 1;
    for (let i = this.#series.length - 1; i >= 0; i--) {
      const current = this.#series[i]!;
      const later = this.#series[i + 1];
      if (later && later.result !== undefined && current.result !== undefined && later.result !== current.result) break;
      count++;
    }
    const entry: GuardEntry = { key, toolName };
    this.#series.push(entry);
    if (count >= this.threshold && !this.#continued.has(toolName)) {
      this.#loopsInTurn++;
      return { suspend: true, entry, count };
    }
    return { suspend: false, entry };
  }

  /** Number of loops detected in the current turn: a second one without interface stops the turn (FA-01, EF-03). */
  get loopsInTurn(): number {
    return this.#loopsInTurn;
  }

  /** The user chose "continue": the series restarts for this tool until the next turn (FA-02). */
  continueAnyway(entry: GuardEntry): void {
    this.#continued.add(entry.toolName);
    this.#series = [entry];
  }

  /** A call refused by the permissions enters no series (§ 5.1, CA-06). */
  forget(entry: GuardEntry): void {
    this.#series = this.#series.filter((e) => e !== entry);
  }

  /** Result of an executed call; returns the reminder to attach to an identical failure at the threshold (step 5, CA-04). */
  record(entry: GuardEntry | undefined, toolName: string, isError: boolean, content: readonly ContentPart[]): string | undefined {
    if (!this.enabled) return undefined;
    if (entry) entry.result = fingerprint(isError, content);
    if (!isError && FILE_WRITERS.has(toolName)) this.#series = []; // a file write resets the series of identical calls
    if (!isError) {
      this.#failures.delete(toolName);
      return undefined;
    }
    const message = content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    const previous = this.#failures.get(toolName);
    const count = previous && previous.message === message ? previous.count + 1 : 1;
    this.#failures.set(toolName, { message, count });
    return count >= this.threshold ? FAILURE_REMINDER(count) : undefined;
  }
}
