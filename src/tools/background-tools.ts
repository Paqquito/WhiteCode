// Implements: SPEC-OUT-020 (§ 5.1, § 5.3, FA-01 to FA-04, EF-01 to EF-07, CA-01 to CA-04), SPEC-OUT-022 (§ 5.3 steps 1 and 2, § 6, EF-01, FA-02)
// The tools of the tasks: the work items of the list of the context, shared with `update_todo_list` (EF-06), and the
// background tasks of the session (output, stop, monitor).

import outputDescription from "../../prompts/tools/background_output.md" with { type: "text" };
import stopDescription from "../../prompts/tools/background_stop.md" with { type: "text" };
import monitorDescription from "../../prompts/tools/monitor_process.md" with { type: "text" };
import workItemDescription from "../../prompts/tools/work_items.md" with { type: "text" };
import type { BackgroundTasks } from "../engine/background";
import { renderTasks, TASK_STATUSES, type Task, type TaskStatus } from "../engine/task-list";
import { MAIN_AGENT } from "./update-todo-list";
import { textOutcome, type Tool, type ToolContext } from "./types";
import { storeReference } from "../session/private-storage";

const free = () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: false, openWorld: false });
const listChange = () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false });
const noBackground = () => textOutcome("Background tasks are not available in this session.", true, "unavailable");
const noList = () => textOutcome("The task list is not available in this session.", true, "unavailable");

/** Hooks of the work items (EF-03). */
export interface WorkItemHooks {
  readonly fire: (event: "work_item_added" | "work_item_done", fields: Record<string, unknown>) => void;
}

function detail(t: Task): string {
  return [
    `#${t.id} ${t.subject}`,
    `status: ${t.status}`,
    `owner: ${t.owner || "(free)"}`,
    ...(t.description ? [`description: ${t.description}`] : []),
    ...(t.blockedBy.length > 0 ? [`blocked by: ${t.blockedBy.map((d) => `#${d}`).join(", ")}`] : []),
    ...(t.blocks.length > 0 ? [`blocks: ${t.blocks.map((d) => `#${d}`).join(", ")}`] : []),
  ].join("\n");
}

export function createWorkItemTools(hooks: WorkItemHooks): Tool<never>[] {
  const create: Tool<{ subject: string; description?: string; progress_label?: string; owner?: string }> = {
    name: "work_item_create",
    inputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", minLength: 1, description: "What the task is, in the imperative." },
        description: { type: "string", description: "Detail of the task." },
        progress_label: { type: "string", description: "The task as an ongoing action." },
        owner: { type: "string", description: "Agent that owns it. Default: none (a free task)." },
      },
      required: ["subject"],
      additionalProperties: false,
    },
    description: () => workItemDescription.trim(),
    flags: listChange,
    isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: (i) => `Create the task « ${i.subject} »`,
    async execute(i, ctx) {
      if (!ctx.taskList) return noList();
      const t = ctx.taskList.create(i.subject, { ...(i.owner ? { owner: i.owner } : {}), ...(i.description ? { description: i.description } : {}), ...(i.progress_label ? { progressLabel: i.progress_label } : {}) });
      hooks.fire("work_item_added", { kind: "work_item", itemId: t.id, subject: t.subject });
      return textOutcome(`Task #${t.id} created.\n\n${detail(t)}`);
    },
  };
  const get: Tool<{ item_id: string }> = {
    name: "work_item_get",
    inputSchema: { type: "object", properties: { item_id: { type: "string", minLength: 1 } }, required: ["item_id"], additionalProperties: false },
    description: () => "Reads the detail of a task of the task list: status, owner, description and dependencies.",
    flags: free, // EF-05
    isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: (i) => `Read task #${i.item_id}`,
    async execute(i, ctx) {
      const t = ctx.taskList?.get(i.item_id);
      if (!ctx.taskList) return noList();
      return t ? textOutcome(detail(t)) : textOutcome(`Unknown task: ${i.item_id}.`, true, "invalid_input");
    },
  };
  const update: Tool<{ item_id: string; status?: string; owner?: string; subject?: string; description?: string; blocks?: string[]; blocked_by?: string[] }> = {
    name: "work_item_update",
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", minLength: 1 },
        status: { type: "string", description: "pending, in_progress, completed, or deleted to remove the task." },
        owner: { type: "string", description: "Claims a free task for this agent." },
        subject: { type: "string" },
        description: { type: "string" },
        blocks: { type: "array", items: { type: "string" }, description: "Tasks that wait for this one." },
        blocked_by: { type: "array", items: { type: "string" }, description: "Tasks this one waits for." },
      },
      required: ["item_id"],
      additionalProperties: false,
    },
    description: () => "Changes a task of the task list: its status, its owner (to claim a free task), its text or its dependencies; status `deleted` removes it.",
    flags: listChange,
    isEnabled: () => true,
    validate: (i) => (i.status !== undefined && i.status !== "deleted" && !TASK_STATUSES.includes(i.status as TaskStatus) ? `Invalid status: ${i.status}.` : undefined),
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: (i) => `Update task #${i.item_id}`,
    async execute(i, ctx) {
      if (!ctx.taskList) return noList();
      const before = ctx.taskList.get(i.item_id)?.status;
      const r = ctx.taskList.update(i.item_id, {
        ...(i.status !== undefined ? { status: i.status as TaskStatus | "deleted" } : {}),
        ...(i.owner !== undefined ? { owner: i.owner } : {}),
        ...(i.subject !== undefined ? { subject: i.subject } : {}),
        ...(i.description !== undefined ? { description: i.description } : {}),
        ...(i.blocks !== undefined ? { blocks: i.blocks } : {}),
        ...(i.blocked_by !== undefined ? { blockedBy: i.blocked_by } : {}),
      });
      if (!r.ok) return textOutcome(r.reason, true, "invalid_input");
      if (!r.task) return textOutcome(`Task #${i.item_id} removed.`);
      if (r.task.status === "completed" && before !== "completed") hooks.fire("work_item_done", { kind: "work_item", itemId: r.task.id, subject: r.task.subject });
      return textOutcome(`Task #${r.task.id} updated.\n\n${detail(r.task)}`);
    },
  };
  const list: Tool<Record<string, never>> = {
    name: "work_item_list",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    description: () => "Lists the tasks of the task list, with their id, status, owner and blocks.",
    flags: free, // EF-05
    isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: () => "List the tasks",
    async execute(_i, ctx) {
      if (!ctx.taskList) return noList();
      const owner = ctx.agentName ?? MAIN_AGENT;
      ctx.taskList.markRead(owner);
      const tasks = ctx.taskList.tasks;
      const blocked = tasks.filter((t) => t.blockedBy.some((d) => ctx.taskList!.get(d)?.status !== "completed"));
      return textOutcome(`${renderTasks(tasks, owner)}${blocked.length > 0 ? `\n\nBlocked: ${blocked.map((t) => `#${t.id}`).join(", ")}.` : ""}`);
    },
  };
  return [create, get, update, list] as Tool<never>[];
}

export const backgroundOutputTool: Tool<{ task_id: string; block?: boolean; timeout?: number }> = {
  name: "background_output",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", minLength: 1 },
      block: { type: "boolean", description: "Wait for the end of the task. Default: true." },
      timeout: { type: "integer", minimum: 0, maximum: 600_000, description: "Longest wait in milliseconds. Default: 30000." },
    },
    required: ["task_id"],
    additionalProperties: false,
  },
  description: () => outputDescription.trim(),
  flags: free, // EF-05
  isEnabled: () => true,
  ruleSubject: () => ({ kind: "none" }),
  permissionContribution: () => "allow",
  summary: (i) => `Output of task ${i.task_id}`,
  async execute(i, ctx) {
    const bg = ctx.background;
    if (!bg) return noBackground();
    const t = bg.get(i.task_id);
    if (!t) return textOutcome(`Unknown background task: ${i.task_id}.`, true, "invalid_input");
    if (i.block !== false && t.status === "running") await bg.wait(t.id, i.timeout ?? 30_000, ctx.signal);
    const tail = bg.tail(t.id, 20_000);
    const state = t.status === "running" ? "still running" : `${t.status}${t.exitCode !== undefined && t.exitCode !== null ? ` (exit code ${t.exitCode})` : ""}`;
    // FA-03: the end of a large output, and where the whole of it is.
    return textOutcome(`Task ${t.id} (${t.description}): ${state}.${t.summary && t.kind === "agent" ? `\nReport:\n${t.summary}` : ""}\nOutput file: ${storeReference(t.outputFile)}\n\n${tail || "(no output yet)"}`);
  },
};

export const backgroundStopTool: Tool<{ task_id: string }> = {
  name: "background_stop",
  inputSchema: { type: "object", properties: { task_id: { type: "string", minLength: 1 } }, required: ["task_id"], additionalProperties: false },
  description: () => stopDescription.trim(),
  flags: () => ({ readOnly: false, concurrencySafe: true, destructive: false, requiresPermission: false, openWorld: false }),
  isEnabled: () => true,
  ruleSubject: () => ({ kind: "none" }),
  permissionContribution: () => "allow",
  summary: (i) => `Stop task ${i.task_id}`,
  async execute(i, ctx) {
    if (!ctx.background) return noBackground();
    const t = ctx.background.get(i.task_id);
    if (!t) return textOutcome(`Unknown background task: ${i.task_id}.`, true, "invalid_input");
    if (t.status !== "running") return textOutcome(`Task ${t.id} already ended (${t.status}).`);
    await ctx.background.stop(t.id); // FA-04, EF-04: its processes and their descendants; the output is kept
    return textOutcome(`Task ${t.id} stopped. Its output stays in ${storeReference(t.outputFile)}.`);
  },
};

/** A shell command run in the background as a task of the session (SPEC-OUT-008 FA-01, SPEC-AGT-017). */
export function startShellTask(ctx: ToolContext, kind: "shell" | "monitor", command: string, description: string, timeoutMs: number, powershell: boolean): string {
  const shell = ctx.shell!;
  const t = ctx.background!.start(kind, description, async (signal, write) => {
    const r = powershell ? await shell.runPowerShell(command, timeoutMs, signal, write) : await shell.runPosix(command, timeoutMs, signal, write);
    const status = r.interrupted ? (signal.reason === "rate" ? "rate_limited" : "stopped") : r.timedOut ? "timed_out" : r.exitCode === 0 ? "completed" : "failed";
    return { status, exitCode: r.exitCode };
  });
  return t.id;
}

export const monitorProcessTool: Tool<{ command: string; description: string; timeout_ms?: number; persistent?: boolean }> = {
  name: "monitor_process",
  // EF-01: decided like `run_shell`, by its rules.
  permissionName: "run_shell",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", minLength: 1, description: "Command whose every output line is an event, usually a filter on a stream." },
      description: { type: "string", minLength: 1, maxLength: 120, description: "What is watched, shown with each notification." },
      timeout_ms: { type: "integer", minimum: 1_000, maximum: 3_600_000, description: "Time limit. Default: 5 minutes." },
      persistent: { type: "boolean", description: "Accepted; a monitor never outlives the session." },
    },
    required: ["command", "description"],
    additionalProperties: false,
  },
  description: () => monitorDescription.trim(),
  flags: () => ({ readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: true }),
  isEnabled: (env) => env.shells?.posix !== undefined || env.shells?.powershell !== undefined,
  ruleSubject: (i) => ({ kind: "command", command: i.command }),
  summary: (i) => `Monitor: ${i.description}`,
  async execute(i, ctx) {
    if (!ctx.background || !ctx.shell) return noBackground();
    const id = startShellTask(ctx, "monitor", i.command, i.description, i.timeout_ms ?? 300_000, ctx.shell.options.posix === undefined);
    return textOutcome(`Monitor ${id} started. Its lines will reach you as notifications; stop it with background_stop (task_id ${id}).`);
  },
};
