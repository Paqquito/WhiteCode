// Implements: SPEC-AGT-016 (§ 5.1, § 5.3 steps 2 to 4, FA-01, FA-02, FA-03, EF-01 to EF-04, CA-01, CA-02), SPEC-AGT-017 (§ 5.3, EF-01, CA-01),
//             SPEC-AGT-018 (§ 5.3 steps 1 and 4), SPEC-OUT-022 (§ 5.3 steps 2 to 4, FA-01, EF-02 to EF-04, CA-01 to CA-03)
// Background tasks of a session: a shell command, an agent or a monitor that go on while the conversation continues.
// Each writes its output to its own file; its end is announced to its owner exactly once, at the next request.
// Supports: SPEC-AGT-017 (CA-02), SPEC-AGT-018 (CA-01), gap E-147.

import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Reminder, ReminderProducer } from "./reminders";

export type TaskKind = "shell" | "agent" | "monitor" | "workflow";
export type TaskStatus = "running" | "completed" | "failed" | "stopped" | "timed_out" | "rate_limited";

export interface BackgroundTask {
  readonly id: string;
  readonly kind: TaskKind;
  readonly description: string;
  readonly startedAt: number;
  status: TaskStatus;
  endedAt?: number;
  exitCode?: number | null;
  /** The report of an agent, or the cause of the end. */
  summary?: string;
  /** Visible activity of an agent; counters use reported events only. */
  activity?: string;
  toolCalls?: number;
  tokens?: number;
  readonly outputFile: string;
}

export interface BackgroundOptions {
  /** Folder of the output files (in the work folder of the session). */
  readonly dir: string;
  /** `tasks.maxOutputBytes`: beyond, the output is no longer written (with a mention). */
  readonly maxOutputBytes: number;
  /** A monitor beyond this number of lines per minute is stopped (SPEC-OUT-022 FA-01). */
  readonly monitorMaxLinesPerMinute: number;
  /** Window grouping the lines of a monitor into one notification (EF-02). */
  readonly monitorWindowMs: number;
  readonly now?: () => number;
}

/** What a monitor has emitted since its last notification. */
interface MonitorState {
  pending: string[];
  timer?: ReturnType<typeof setTimeout>;
  times: number[];
  partial: string;
}

export class BackgroundTasks {
  readonly #o: BackgroundOptions;
  readonly #tasks = new Map<string, BackgroundTask>();
  readonly #controllers = new Map<string, AbortController>();
  readonly #done = new Map<string, Promise<void>>();
  readonly #monitors = new Map<string, MonitorState>();
  readonly #notes: Reminder[] = [];
  #next = 1;
  readonly #listeners: Array<() => void> = [];
  readonly #foreground = new Map<symbol, () => string | undefined>();

  constructor(options: BackgroundOptions) {
    this.#o = options;
  }

  get tasks(): readonly BackgroundTask[] {
    return [...this.#tasks.values()];
  }

  get running(): readonly BackgroundTask[] {
    return this.tasks.filter((t) => t.status === "running");
  }

  get outputLimitBytes(): number { return this.#o.maxOutputBytes; }
  get hasForeground(): boolean { return this.#foreground.size > 0; }

  /** A workflow owns tasks started through this view and joins them before it ends (E-165). */
  scope(owner: AbortSignal): { readonly tasks: BackgroundTasks; readonly close: () => Promise<void> } {
    const owned = new Set<string>();
    let closed = false;
    const tasks = new Proxy(this, {
      get: (target, key) => {
        if (key === "start") return (kind: TaskKind, description: string, work: Parameters<BackgroundTasks["start"]>[2]) => {
          owner.throwIfAborted();
          if (closed) throw new Error("The owning workflow has ended.");
          const task = target.start(kind, description, async (signal, write) => {
            const combined = AbortSignal.any([signal, owner]);
            try { const result = await work(combined, write); return combined.aborted ? { ...result, status: "stopped" as const } : result;
            } catch (error) { if (combined.aborted) return { status: "stopped" as const }; throw error; }
          });
          owned.add(task.id); return task;
        };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return { tasks, close: async () => { closed = true; await Promise.all([...owned].map(id => this.stop(id))); } };
  }

  /** Offers an already authorized command; newest active command wins, without another launch. */
  offerForeground(detach: () => string | undefined): () => void {
    const key = Symbol();
    this.#foreground.set(key, detach); this.#changed();
    return () => { if (this.#foreground.delete(key)) this.#changed(); };
  }

  detachForeground(): string | undefined {
    for (const [key, detach] of [...this.#foreground].reverse()) {
      const id = detach(); this.#foreground.delete(key); this.#changed();
      if (id) return id;
    }
    return undefined;
  }

  updateActivity(id: string, activity: string, toolCalls = 0, tokens = 0): void {
    const task = this.#tasks.get(id);
    if (!task || task.status !== "running") return;
    task.activity = activity; task.toolCalls = toolCalls; task.tokens = tokens; this.#changed();
  }

  onChange(listener: () => void): () => void {
    this.#listeners.push(listener);
    return () => { const index = this.#listeners.indexOf(listener); if (index !== -1) this.#listeners.splice(index, 1); };
  }

  /** EF-03, CA-01: the ends and the monitor lines, each delivered once, at the next request of the owner (FA-03). */
  readonly reminders: ReminderProducer = { type: "background_task", produce: () => this.#notes.splice(0) };

  #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  #changed(): void {
    for (const l of this.#listeners) l();
  }

  /**
   * Starts a task: `work` runs with the signal of the task and writes through `write`; its outcome ends the task. The
   * identifier comes back at once (SPEC-AGT-017 § 5.3 step 3).
   */
  start(kind: TaskKind, description: string, work: (signal: AbortSignal, write: (chunk: string) => void) => Promise<{ readonly status: TaskStatus; readonly exitCode?: number | null; readonly summary?: string }>): BackgroundTask {
    mkdirSync(this.#o.dir, { recursive: true });
    const id = `${kind === "agent" ? "a" : kind === "monitor" ? "m" : kind === "workflow" ? "w" : "b"}${this.#next++}`;
    const task: BackgroundTask = { id, kind, description, startedAt: this.#now(), status: "running", outputFile: join(this.#o.dir, `${id}.log`) };
    writeFileSync(task.outputFile, "");
    this.#tasks.set(id, task);
    const controller = new AbortController();
    this.#controllers.set(id, controller);
    let written = 0;
    let capped = false;
    const write = (chunk: string) => {
      if (capped) return;
      const bytes = Buffer.byteLength(chunk, "utf8");
      if (written + bytes > this.#o.maxOutputBytes) {
        capped = true;
        appendFileSync(task.outputFile, `\n[Output stopped: it exceeded ${this.#o.maxOutputBytes} bytes.]\n`);
        return;
      }
      written += bytes;
      appendFileSync(task.outputFile, chunk); // EF-02: readable during the run
      if (kind === "monitor") this.#monitorChunk(task, chunk);
    };
    const done = work(controller.signal, write)
      .then(
        (r) => this.#finish(task, r.status, r.exitCode, r.summary),
        (e: unknown) => this.#finish(task, "failed", null, (e as Error)?.message ?? String(e)),
      )
      .finally(() => this.#controllers.delete(id));
    this.#done.set(id, done);
    this.#changed();
    return task;
  }

  #finish(task: BackgroundTask, status: TaskStatus, exitCode: number | null | undefined, summary: string | undefined): void {
    if (task.status !== "running") return;
    if (task.kind === "monitor") this.#flushMonitor(task);
    task.status = status;
    task.endedAt = this.#now();
    task.exitCode = exitCode ?? null;
    if (summary !== undefined) task.summary = summary;
    this.#notes.push({ type: "background_task", text: this.#endNote(task), priority: 3 });
    this.#changed();
  }

  /** § 5.3 step 3: a summary and where to read the output. */
  #endNote(t: BackgroundTask): string {
    const what = t.kind === "agent" ? "background agent" : t.kind === "monitor" ? "monitor" : t.kind === "workflow" ? "workflow" : "background command";
    const how =
      t.status === "completed"
        ? `ended${t.exitCode !== null && t.exitCode !== undefined ? ` with exit code ${t.exitCode}` : ""}`
        : t.status === "stopped"
          ? "was stopped"
          : t.status === "timed_out"
            ? "reached its time limit"
            : t.status === "rate_limited"
              ? "was stopped because its output came too fast: filter the command more (for example with grep) and start it again"
              : `failed${t.exitCode !== null && t.exitCode !== undefined ? ` with exit code ${t.exitCode}` : ""}`;
    const report = (t.kind === "agent" || t.kind === "workflow") && t.summary ? `\nReport:\n${t.summary}` : t.summary && t.status !== "completed" ? ` (${t.summary})` : "";
    const tail = t.kind !== "agent" ? `\nLast output:\n${this.tail(t.id, 1_500) || "(none)"}` : "";
    return `The ${what} ${t.id} (${t.description}) ${how}.${report}${tail}\nRead its whole output with background_output (task_id ${t.id}).`;
  }

  /** SPEC-OUT-022 § 5.3 step 3, EF-02, EF-03: lines grouped over a short window; a flood stops the monitor (FA-01). */
  #monitorChunk(task: BackgroundTask, chunk: string): void {
    let m = this.#monitors.get(task.id);
    if (!m) this.#monitors.set(task.id, (m = { pending: [], times: [], partial: "" }));
    const lines = (m.partial + chunk).split(/\r?\n/);
    m.partial = lines.pop() ?? "";
    const now = this.#now();
    for (const line of lines) {
      if (line.trim() === "") continue;
      m.pending.push(line);
      m.times.push(now);
    }
    while (m.times.length > 0 && now - m.times[0]! > 60_000) m.times.shift();
    if (m.times.length > this.#o.monitorMaxLinesPerMinute) {
      m.pending = [];
      this.#controllers.get(task.id)?.abort("rate");
      return;
    }
    if (m.pending.length > 0 && !m.timer) m.timer = setTimeout(() => this.#flushMonitor(task), this.#o.monitorWindowMs);
  }

  #flushMonitor(task: BackgroundTask): void {
    const m = this.#monitors.get(task.id);
    if (!m) return;
    clearTimeout(m.timer);
    m.timer = undefined;
    if (m.pending.length === 0) return;
    const lines = m.pending.splice(0);
    this.#notes.push({ type: "monitor_event", text: `The monitor ${task.id} (${task.description}) reported:\n${lines.slice(-50).join("\n")}`, priority: 3 });
    this.#changed();
  }

  /** True when the monitor was stopped for its rate (FA-01). */
  rateLimited(id: string): boolean {
    const m = this.#monitors.get(id);
    return m !== undefined && m.times.length > this.#o.monitorMaxLinesPerMinute;
  }

  get(id: string): BackgroundTask | undefined {
    return this.#tasks.get(id);
  }

  /** The end of the output (SPEC-OUT-020 FA-03). */
  tail(id: string, maxChars: number): string {
    const t = this.#tasks.get(id);
    if (!t) return "";
    try {
      const size = statSync(t.outputFile).size;
      const text = readFileSync(t.outputFile, "utf8");
      return size > maxChars ? text.slice(-maxChars) : text;
    } catch {
      return "";
    }
  }

  /** Waits for the end of a task, at most `timeoutMs`; false when it still runs. */
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
    const done = this.#done.get(id);
    if (!done) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopped = await Promise.race([
      done.then(() => true),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), timeoutMs);
        signal?.addEventListener("abort", () => r(false), { once: true });
      }),
    ]);
    clearTimeout(timer);
    return stopped;
  }

  /** FA-01, EF-01, EF-04: the task stops, its processes and their descendants with it; its output is kept. */
  async stop(id: string): Promise<boolean> {
    const t = this.#tasks.get(id);
    if (!t || t.status !== "running") return false;
    this.#controllers.get(id)?.abort("stop");
    await this.#done.get(id);
    return true;
  }

  /** FA-02: at the end of the session the local tasks stop; the names of those stopped are returned. */
  async stopAll(): Promise<string[]> {
    const running = this.running.map((t) => t.id);
    await Promise.all(running.map((id) => this.stop(id)));
    return running;
  }
}
