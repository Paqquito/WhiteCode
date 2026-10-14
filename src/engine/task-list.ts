// Implements: SPEC-OUT-020 (§ 4 list of the context and list version, EF-01, EF-06, EF-07), SPEC-OUT-021 (§ 5.1, § 5.3 step 2, FA-01, FA-02, EF-01, EF-05),
//             SPEC-MOT-007 (reminder of a forgotten task list)
import type { ReminderProducer } from "./reminders";

// Task list of the context: every agent sees the same list; each one replaces only its own tasks, and a change based
// on an outdated version of the list is refused with the current list.

export type TaskStatus = "pending" | "in_progress" | "completed";

export const TASK_STATUSES: readonly TaskStatus[] = ["pending", "in_progress", "completed"];

export interface Task {
  readonly id: string;
  readonly subject: string;
  readonly progressLabel?: string;
  /** Detail of a task created by `work_item_create` (SPEC-OUT-020). */
  readonly description?: string;
  readonly status: TaskStatus;
  /** Agent owning the task; empty: a free task that an agent may claim (SPEC-OUT-020 § 5.3 step 4). */
  readonly owner: string;
  readonly blocks: readonly string[];
  readonly blockedBy: readonly string[];
}

export interface TaskViewItem {
  readonly id?: string;
  readonly content: string;
  readonly progressLabel?: string;
  readonly status: TaskStatus;
}

export type ReplaceOutcome =
  | { readonly ok: true; readonly tasks: readonly Task[]; readonly warning?: string }
  | { readonly ok: false; readonly reason: string; readonly tasks: readonly Task[] };

export class TaskList {
  #tasks: Task[] = [];
  #version = 0;
  #next = 1;
  /** Version of the list each agent last received (§ 5.3 step 2). */
  readonly #read = new Map<string, number>();
  readonly #listeners: Array<(tasks: readonly Task[]) => void> = [];

  get version(): number {
    return this.#version;
  }

  get tasks(): readonly Task[] {
    return this.#tasks;
  }

  /** Called on every change: persistence in the session (§ 7.2), display. */
  onChange(listener: (tasks: readonly Task[]) => void): void {
    this.#listeners.push(listener);
  }

  /** List of a reopened session (SPEC-SES-002 step 4); the agents have read it. */
  restore(tasks: readonly Task[]): void {
    this.#tasks = [...tasks];
    this.#next = 1 + tasks.reduce((n, t) => Math.max(n, Number.parseInt(t.id, 10) || 0), 0);
    this.#version++;
  }

  /** The agent has received the current list. */
  markRead(owner: string): void {
    this.#read.set(owner, this.#version);
  }

  /** A task added by another agent (a teammate or a sub-agent, SPEC-OUT-020 work_item_create). */
  add(owner: string, subject: string, status: TaskStatus = "pending"): Task {
    const task: Task = { id: String(this.#next++), subject, status, owner, blocks: [], blockedBy: [] };
    this.#tasks.push(task);
    this.#changed();
    return task;
  }

  /**
   * SPEC-OUT-021 EF-01: `view` becomes the whole list of tasks of `owner`; the tasks of other agents are kept and the
   * dependencies of kept tasks too. Refused when the list changed since the owner last read it (EF-05, SPEC-OUT-020 EF-07).
   */
  replaceView(owner: string, view: readonly TaskViewItem[]): ReplaceOutcome {
    if ((this.#read.get(owner) ?? 0) !== this.#version) {
      this.markRead(owner);
      return { ok: false, reason: "The task list changed since you last read it (another agent updated it). Here is the current list; send your view again from it.", tasks: this.#tasks };
    }
    const mine = new Map(this.#tasks.filter((t) => t.owner === owner).map((t) => [t.id, t]));
    for (const item of view) {
      if (item.id !== undefined && !mine.has(item.id)) {
        return { ok: false, reason: `Unknown task id for your list: ${item.id}. Use the ids returned by the last update.`, tasks: this.#tasks };
      }
    }
    const kept = new Set(view.flatMap((i) => (i.id !== undefined ? [i.id] : [])));
    const others = this.#tasks.filter((t) => t.owner !== owner);
    const next: Task[] = [];
    for (const item of view) {
      const previous = item.id !== undefined ? mine.get(item.id) : undefined;
      next.push({
        id: previous?.id ?? String(this.#next++),
        subject: item.content,
        progressLabel: item.progressLabel,
        status: item.status,
        owner,
        blocks: (previous?.blocks ?? []).filter((d) => kept.has(d) || others.some((t) => t.id === d)),
        blockedBy: (previous?.blockedBy ?? []).filter((d) => kept.has(d) || others.some((t) => t.id === d)),
      });
    }
    // Order: the tasks of other agents keep their place, the owner's view follows.
    this.#tasks = [...others, ...next];
    this.#changed();
    this.markRead(owner);
    const running = next.filter((t) => t.status === "in_progress").length;
    return { ok: true, tasks: this.#tasks, ...(running > 1 ? { warning: `${running} tasks are in progress: keep exactly one task in progress at a time.` } : {}) }; // FA-01
  }

  /** SPEC-OUT-020 `work_item_create`: a new task, free unless an owner is given. */
  create(subject: string, o: { readonly owner?: string; readonly description?: string; readonly progressLabel?: string } = {}): Task {
    const task: Task = { id: String(this.#next++), subject, ...(o.description ? { description: o.description } : {}), ...(o.progressLabel ? { progressLabel: o.progressLabel } : {}), status: "pending", owner: o.owner ?? "", blocks: [], blockedBy: [] };
    this.#tasks.push(task);
    this.#changed();
    return task;
  }

  get(id: string): Task | undefined {
    return this.#tasks.find((t) => t.id === id);
  }

  /**
   * SPEC-OUT-020 `work_item_update`. A claim (a new owner) takes a free task only, and never a blocked one (FA-01): the
   * first owner recorded wins (FA-02); a circular dependency is refused (EF-02). One change at a time (EF-01).
   */
  update(
    id: string,
    patch: { readonly status?: TaskStatus | "deleted"; readonly owner?: string; readonly subject?: string; readonly description?: string; readonly blocks?: readonly string[]; readonly blockedBy?: readonly string[] },
  ): { readonly ok: true; readonly task?: Task } | { readonly ok: false; readonly reason: string } {
    const at = this.#tasks.findIndex((t) => t.id === id);
    if (at === -1) return { ok: false, reason: `Unknown task: ${id}.` };
    const task = this.#tasks[at]!;
    if (patch.status === "deleted") {
      this.#tasks = this.#tasks.filter((t) => t.id !== id).map((t) => ({ ...t, blocks: t.blocks.filter((d) => d !== id), blockedBy: t.blockedBy.filter((d) => d !== id) }));
      this.#changed();
      return { ok: true };
    }
    if (patch.owner !== undefined && patch.owner !== task.owner) {
      if (task.owner !== "") return { ok: false, reason: `Task ${id} is already owned by ${task.owner}.` };
      const open = task.blockedBy.filter((d) => this.get(d)?.status !== "completed");
      if (open.length > 0) return { ok: false, reason: `Task ${id} is blocked by ${open.map((d) => `#${d}`).join(", ")}: it cannot be claimed before they are completed.` };
    }
    for (const d of [...(patch.blocks ?? []), ...(patch.blockedBy ?? [])]) if (!this.get(d) || d === id) return { ok: false, reason: `Invalid dependency: ${d}.` };
    const blockedBy = patch.blockedBy ?? task.blockedBy;
    const blocks = patch.blocks ?? task.blocks;
    // EF-02: following "blocked by" from the task never comes back to it.
    const graph = new Map(this.#tasks.map((t) => [t.id, t.id === id ? [...blockedBy] : [...t.blockedBy]]));
    for (const b of blocks) graph.set(b, [...(graph.get(b) ?? []).filter((x) => x !== id), id]);
    const reaches = (from: string, seen = new Set<string>()): boolean => (graph.get(from) ?? []).some((n) => n === id || (!seen.has(n) && (seen.add(n), reaches(n, seen))));
    if (reaches(id)) return { ok: false, reason: `Circular dependency: task ${id} would wait for itself.` };
    const next: Task = {
      ...task,
      ...(patch.subject !== undefined ? { subject: patch.subject } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
      blocks: [...blocks],
      blockedBy: [...blockedBy],
    };
    this.#tasks = this.#tasks.map((t) => {
      if (t.id === id) return next;
      // The reverse side of the dependencies stays consistent.
      const b = new Set(t.blocks);
      const bb = new Set(t.blockedBy);
      if (blockedBy.includes(t.id)) b.add(id);
      else b.delete(id);
      if (blocks.includes(t.id)) bb.add(id);
      else bb.delete(id);
      return { ...t, blocks: [...b], blockedBy: [...bb] };
    });
    this.#changed();
    return { ok: true, task: next };
  }

  /** SPEC-AGT-011: unfinished work becomes available again when its teammate stops. */
  release(owner: string): void {
    let changed = false;
    this.#tasks = this.#tasks.map(task => {
      if (task.owner !== owner || task.status === "completed") return task;
      changed = true;
      return { ...task, owner: "", status: "pending" };
    });
    if (changed) this.#changed();
  }

  #changed(): void {
    this.#version++;
    for (const l of this.#listeners) l(this.#tasks);
  }
}

/** Text of the list for the model: the result of the tool, the compaction, the reminders. */
export function renderTasks(tasks: readonly Task[], owner?: string): string {
  if (tasks.length === 0) return "The task list is empty.";
  const mark: Record<TaskStatus, string> = { pending: "[ ]", in_progress: "[~]", completed: "[x]" };
  return tasks.map((t) => `${mark[t.status]} #${t.id} ${t.subject}${t.status === "in_progress" && t.progressLabel ? ` (${t.progressLabel})` : ""}${owner !== undefined && t.owner !== owner ? ` — owned by ${t.owner}` : ""}`).join("\n");
}

/**
 * SPEC-OUT-021 FA-02: when the list still has open tasks and was not updated for `interval` requests, a reminder shows it
 * again; it comes back at the same frequency while the list stays untouched (SPEC-MOT-007 § 5.5).
 */
export function todoReminderProducer(list: TaskList, interval: number): ReminderProducer {
  let version = list.version;
  let since = 0;
  return {
    type: "todo",
    produce() {
      if (list.version !== version) {
        version = list.version;
        since = 0;
        return [];
      }
      since++;
      if (since < interval || !list.tasks.some((t) => t.status !== "completed")) return [];
      since = 0;
      return [
        {
          type: "todo",
          text: `The task list has not been updated for ${interval} requests. If the work has moved on, update it with update_todo_list:\n${renderTasks(list.tasks)}`,
          priority: 1,
          repeatable: true,
        },
      ];
    },
  };
}

/** SPEC-OUT-021 EF-03, SPEC-MOT-011 CA-02: element restored after a compaction, so that the list stays known to the model. */
export function taskListElements(list: TaskList, owner: string): string[] {
  return list.tasks.length > 0 ? [`Restored: the task list of the session.\n${renderTasks(list.tasks, owner)}`] : [];
}

