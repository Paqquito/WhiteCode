// Implements: SPEC-OUT-021 (§ 5.3, FA-01, EF-01, EF-04, EF-05, ERR-01, CA-03, CA-04)
// Supports: SPEC-OUT-020 (list of the context), SPEC-MOT-045 C-11
// The model sends the whole view of its tasks; the task list of the context applies it.

import description from "../../prompts/tools/update_todo_list.md" with { type: "text" };
import { renderTasks, TASK_STATUSES, type TaskStatus } from "../engine/task-list";
import { textOutcome, type Tool } from "./types";

export interface UpdateTodoListInput {
  readonly items: ReadonlyArray<{ readonly id?: string; readonly content: string; readonly progress_label?: string; readonly status: string }>;
}

/** Agent whose list is changed when the context names none: the main agent of the session. */
export const MAIN_AGENT = "main";

export const updateTodoListTool: Tool<UpdateTodoListInput> = {
  name: "update_todo_list",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        maxItems: 100,
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Id of an existing task, from the last result; leave it out for a new task." },
            content: { type: "string", minLength: 1, description: "What the task is." },
            progress_label: { type: "string", description: "The task as an ongoing action, shown while it is in progress." },
            status: { type: "string", description: "pending, in_progress or completed." },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["items"],
    additionalProperties: false,
  },
  description: () => description.trim(),
  // EF-04: no permission; the list lives in the session only.
  flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }),
  isEnabled: () => true,
  validate(input) {
    for (const item of input.items) {
      if (!TASK_STATUSES.includes(item.status as TaskStatus)) return `Invalid status: ${item.status}. Use pending, in_progress or completed.`; // ERR-01
      if (item.content.trim() === "") return "Every task needs a non-empty content.";
    }
    return undefined;
  },
  ruleSubject: () => ({ kind: "none" }),
  // EF-04: no permission is needed (step 5 of SPEC-PER-001); an explicit deny rule still applies first.
  permissionContribution: () => "allow",
  summary: (input) => `Update the task list (${input.items.length} items)`,

  async execute(input, ctx) {
    if (!ctx.taskList) return textOutcome("The task list is not available in this session.", true, "unavailable");
    const owner = ctx.agentName ?? MAIN_AGENT;
    const outcome = ctx.taskList.replaceView(
      owner,
      input.items.map((i) => ({ id: i.id, content: i.content, progressLabel: i.progress_label, status: i.status as TaskStatus })),
    );
    if (!outcome.ok) return textOutcome(`${outcome.reason}\n\n${renderTasks(outcome.tasks, owner)}`, true, "invalid_input"); // EF-05, CA-03
    const mine = outcome.tasks.filter((t) => t.owner === owner);
    const done = mine.length > 0 && mine.every((t) => t.status === "completed");
    const head = done ? "All your tasks are completed." : "Task list updated.";
    return textOutcome([head, outcome.warning, "", renderTasks(outcome.tasks, owner)].filter((l) => l !== undefined).join("\n"));
  },
};
