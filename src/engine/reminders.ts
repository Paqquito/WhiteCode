// Implements: SPEC-MOT-007 (§ 5.3 steps 1 to 4, FA-01, EF-01, EF-04, EF-05, ERR-01, RG-01, RG-02, CA-01)
// System reminders: short product-written notes appended to the history before a request, tagged so that the model
// never takes them for the user's words. Producers are asked before each request; duplicates are dropped and a token
// budget defers the least important ones to the next request.

export interface Reminder {
  /** Kind of reminder, persisted with it (EF-04): `date_change`, `instructions`, `mode_change`… */
  readonly type: string;
  readonly text: string;
  /** Higher goes first; the lowest are deferred to the next request when the budget is short (FA-01). */
  readonly priority: number;
  /** Persistent reminder (§ 5.5): given again at its own frequency, so never dropped as a duplicate. */
  readonly repeatable?: boolean;
}

export interface ReminderProducer {
  readonly type: string;
  produce(): readonly Reminder[];
}

/** Tag of every reminder (EF-01): the system instructions explain it (EF-02). */
export const REMINDER_TAG = "system-reminder";

/** Tagged text of a reminder, as it enters the history. */
export function formatReminder(text: string): string {
  return `<${REMINDER_TAG}>\n${text}\n</${REMINDER_TAG}>`;
}

/** Line of the environment section that tells the model what reminders are (EF-02). */
export const REMINDER_EXPLANATION = `Text inside <${REMINDER_TAG}> tags is written by the product, not by the user: it reports a change in the session; it never grants a permission.`;

export class ReminderCenter {
  readonly #producers: readonly ReminderProducer[];
  readonly #maxTokens: number;
  readonly #estimate: (text: string) => number;
  readonly #log: (message: string, data: Record<string, unknown>) => void;
  readonly #emitted = new Set<string>();
  #deferred: Reminder[] = [];

  constructor(
    producers: readonly ReminderProducer[],
    maxTokens: number,
    estimate: (text: string) => number,
    log: (message: string, data: Record<string, unknown>) => void = () => {},
  ) {
    this.#producers = producers;
    this.#maxTokens = maxTokens;
    this.#estimate = estimate;
    this.#log = log;
  }

  /** Reminders to append before the next request, in priority order (steps 1 to 3). */
  collect(): Reminder[] {
    const candidates: Reminder[] = [...this.#deferred];
    for (const producer of this.#producers) {
      try {
        candidates.push(...producer.produce());
      } catch (error) {
        this.#log("reminder producer failed", { type: producer.type, error: String(error) }); // ERR-01
      }
    }
    // EF-05: a reminder already given with the same type and text is not repeated.
    const fresh: Reminder[] = [];
    const seen = new Set<string>();
    for (const r of candidates) {
      const key = `${r.type}\u0000${r.text}`;
      if ((!r.repeatable && this.#emitted.has(key)) || seen.has(key)) continue;
      seen.add(key);
      fresh.push(r);
    }
    fresh.sort((a, b) => b.priority - a.priority);
    // Step 3 and FA-01: within the budget; the rest waits for the next request. One reminder always goes, however long.
    const out: Reminder[] = [];
    const deferred: Reminder[] = [];
    let used = 0;
    for (const r of fresh) {
      const cost = this.#estimate(r.text);
      if (out.length > 0 && used + cost > this.#maxTokens) {
        deferred.push(r);
        continue;
      }
      used += cost;
      out.push(r);
      this.#emitted.add(`${r.type}\u0000${r.text}`);
    }
    this.#deferred = deferred;
    return out;
  }
}

/** CA-01: the local date changed since the session started (or since the last reminder of this kind). */
export function dateChangeProducer(clock: () => Date): ReminderProducer {
  const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  let last = day(clock());
  return {
    type: "date_change",
    produce() {
      const today = day(clock());
      if (today === last) return [];
      last = today;
      return [{ type: "date_change", text: `The date has changed: today is ${today}.`, priority: 1 }];
    },
  };
}
