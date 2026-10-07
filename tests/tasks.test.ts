// Task list of the context and its tool (SPEC-OUT-020, SPEC-OUT-021), its reminder (SPEC-MOT-007) and its survival
// across a compaction (SPEC-MOT-011 CA-02) and a reopening (SPEC-SES-002 step 4); PDF documents in read_file (SPEC-OUT-002).
import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { ContextManager } from "../src/engine/context-manager";
import { ContextMeter } from "../src/engine/context-meter";
import { runTurn } from "../src/engine/loop";
import { TaskList, taskListElements, todoReminderProducer } from "../src/engine/task-list";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";
import { readFileTool } from "../src/tools/read-file";
import { MAIN_AGENT, updateTodoListTool, type UpdateTodoListInput } from "../src/tools/update-todo-list";
import type { ToolContext, ToolOutcome } from "../src/tools/types";
import { readTranscript } from "../src/session/sessions";
import { projectKey } from "../src/session/transcript";
import { currentPlatform } from "../src/platform/system";
import { cli, testModel, testToolFields, workspace, type Workspace } from "./helpers/env";
import { bench } from "./helpers/engine";
import { makePdf } from "./helpers/pdf";
import { ScriptedProvider } from "./helpers/scripted-provider";

const platform = currentPlatform();
const text = (o: ToolOutcome) => o.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const ctx = (ws: Workspace, list?: TaskList, agentName?: string): ToolContext =>
  ({ platform, home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal: new AbortController().signal, ...testToolFields(), taskList: list, agentName }) as ToolContext;
const update = (ws: Workspace, list: TaskList, items: UpdateTodoListInput["items"], agent?: string) => updateTodoListTool.execute({ items }, ctx(ws, list, agent));

describe("SPEC-OUT-021 update_todo_list", () => {
  test("SPEC-OUT-021/CA-03 — a teammate added a task after the agent last read the list: the call with the old view is refused with the current list, the teammate's task is kept", async () => {
    const ws = workspace();
    const list = new TaskList();
    list.markRead(MAIN_AGENT);
    expect((await update(ws, list, [{ content: "Write the parser", status: "in_progress" }])).isError).toBe(false);
    list.add("teammate", "Review the parser");
    const refused = await update(ws, list, [{ id: "1", content: "Write the parser", status: "completed" }]);
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("The task list changed since you last read it");
    expect(text(refused)).toContain("#2 Review the parser — owned by teammate");
    expect(list.tasks.map((t) => t.subject)).toEqual(["Write the parser", "Review the parser"]);
    // Having received the current list, the agent can send its view again.
    expect((await update(ws, list, [{ id: "1", content: "Write the parser", status: "completed" }])).isError).toBe(false);
    expect(list.tasks.find((t) => t.id === "1")!.status).toBe("completed");
  });

  test("SPEC-OUT-021/CA-04 — a task owned by another agent, absent from the view sent: it is not deleted", async () => {
    const ws = workspace();
    const list = new TaskList();
    list.add("helper", "Collect the logs");
    list.markRead(MAIN_AGENT);
    await update(ws, list, [{ content: "Fix the bug", status: "pending" }]);
    expect(list.tasks.map((t) => [t.subject, t.owner])).toEqual([
      ["Collect the logs", "helper"],
      ["Fix the bug", MAIN_AGENT],
    ]);
    await update(ws, list, []); // the agent empties its own view
    expect(list.tasks.map((t) => t.subject)).toEqual(["Collect the logs"]);
  });

  test("TECH — SPEC-OUT-021/FA-01, ERR-01, EF-01 — two tasks in progress: accepted with a warning; unknown status and unknown id refused", async () => {
    const ws = workspace();
    const list = new TaskList();
    list.markRead(MAIN_AGENT);
    const two = await update(ws, list, [
      { content: "A", status: "in_progress" },
      { content: "B", status: "in_progress" },
    ]);
    expect(two.isError).toBe(false);
    expect(text(two)).toContain("keep exactly one task in progress at a time");
    expect(updateTodoListTool.validate!({ items: [{ content: "A", status: "doing" }] }, ctx(ws, list))).toContain("Invalid status: doing");
    const unknown = await update(ws, list, [{ id: "99", content: "A", status: "pending" }]);
    expect(text(unknown)).toContain("Unknown task id for your list: 99");
    // EF-01: the view replaces the whole list of the agent; the ids are kept for the items sent back.
    await update(ws, list, [{ id: "1", content: "A", status: "completed" }]);
    expect(list.tasks.map((t) => [t.id, t.status])).toEqual([["1", "completed"]]);
  });

  test("SPEC-OUT-021/CA-02 — SPEC-MOT-011/CA-02 — a compaction: the task list is still known to the model", async () => {
    const list = new TaskList();
    list.markRead(MAIN_AGENT);
    list.replaceView(MAIN_AGENT, [
      { content: "Read the spec", status: "completed" },
      { content: "Write the code", progressLabel: "Writing the code", status: "in_progress" },
    ]);
    const model = { ...testModel("default"), contextWindow: 100_000 };
    const b = bench([{ text: "first" }, { text: "1. Requests and intent: code.\n9. Next step: continue." }], { deps: { model } });
    const context = new ContextManager(
      new ContextMeter({ model, outputReserveTokens: 1000 }),
      {
        autoCompact: { enabled: false, warnRatio: 0.8, urgentRatio: 0.88, triggerRatio: 0.9, maxFailures: 3 },
        microCompact: { enabled: false, triggerRatio: 0.6, keepRecent: 8, idleMinutes: 60 },
        providerContextManagement: { enabled: false, targetTokens: 50_000 },
      },
      {
        provider: b.provider,
        model,
        conversation: b.conversation,
        hooks: NEUTRAL_HOOKS,
        emit: b.deps.emit,
        thinking: b.deps.thinking,
        summaryMaxTokens: 2000,
        pricing: model.pricing,
        rebuildSystem: () => [{ text: "system", cacheBoundary: true }],
        restoredElements: () => taskListElements(list, MAIN_AGENT),
      },
    );
    await runTurn({ ...b.deps, context }, "go", new AbortController().signal);
    expect((await context.compactNow(undefined, new AbortController().signal)).kind).toBe("compacted");
    const opening = JSON.stringify(b.conversation.messages[0]);
    expect(opening).toContain("the task list of the session");
    expect(opening).toContain("[~] #2 Write the code (Writing the code)");
  });

  test("TECH — SPEC-OUT-021/FA-02 — a list left untouched while tasks are open: a reminder every interval", () => {
    const list = new TaskList();
    list.markRead(MAIN_AGENT);
    list.replaceView(MAIN_AGENT, [{ content: "Run the tests", status: "in_progress" }]);
    const producer = todoReminderProducer(list, 3);
    const run = () => producer.produce().map((r) => r.text);
    expect([run(), run()]).toEqual([[], []]);
    expect(run()[0]).toContain("The task list has not been updated for 3 requests");
    expect([run(), run()]).toEqual([[], []]);
    expect(run()).toHaveLength(1); // again, at the same frequency
    list.replaceView(MAIN_AGENT, [{ id: "1", content: "Run the tests", status: "completed" }]);
    expect([run(), run(), run(), run()].flat()).toEqual([]); // nothing open: no reminder
  });

  test("TECH — SPEC-OUT-021 § 7.2 — the list is recorded in the session and comes back with a reopened session", async () => {
    const ws = workspace();
    const first = new ScriptedProvider([{ toolCalls: [{ name: "update_todo_list", input: { items: [{ content: "Step one", status: "in_progress" }] } }] }, { text: "started" }]);
    const r = await cli(["--non-interactive", "--result-format", "json", "plan it"], ws, { provider: first });
    const id = JSON.parse(r.stdout).sessionId as string;
    const records = readTranscript(join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)), `${id}.jsonl`)).records;
    expect(records.some((x) => x.type === "system" && x.data["event"] === "todo_list")).toBe(true);
    const second = new ScriptedProvider([{ toolCalls: [{ name: "update_todo_list", input: { items: [{ id: "1", content: "Step one", status: "completed" }] } }] }, { text: "done" }]);
    expect((await cli(["--non-interactive", `--reopen=${id}`, "finish it"], ws, { provider: second })).code).toBe(0);
    const result = second.requests[1]!.history.flatMap((m) => (m.role === "user" ? m.parts.filter((p) => p.type === "tool_result") : [])).at(-1)!;
    expect(JSON.stringify(result)).toContain("All your tasks are completed.");
  });
});

describe("SPEC-OUT-002 PDF documents", () => {
  const read = (ws: Workspace, path: string, pages?: string) => readFileTool.execute({ path, ...(pages ? { pages } : {}) }, ctx(ws));

  test("SPEC-OUT-002/CA-04 — a PDF of 40 pages without pages: the read is refused with an invitation to give pages", async () => {
    const ws = workspace();
    const path = ws.write("project/long.pdf", "");
    await Bun.write(path, makePdf(Array.from({ length: 40 }, (_, i) => `Page text ${i + 1}`)));
    const r = await read(ws, path);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("This PDF has 40 pages, more than the 15 that can be read at once: give pages, such as 1-15.");
  });

  test("TECH — SPEC-OUT-002 § 5.3 point 6, EF-04, ERR-07 — the requested pages as text, the partial read stated; a damaged PDF refused", async () => {
    const ws = workspace();
    const path = ws.write("project/doc.pdf", "");
    await Bun.write(path, makePdf(["Alpha section", "Beta section", "Gamma section"]));
    const some = text(await read(ws, path, "2-3"));
    expect(some).toContain("--- Page 2 of 3 ---\nBeta section");
    expect(some).toContain("--- Page 3 of 3 ---\nGamma section");
    expect(some).not.toContain("Alpha");
    expect(some).toContain("[Pages 2-3 of 3 shown. Use pages to read others.]");
    expect(text(await read(ws, path))).toContain("Alpha section");
    expect(text(await read(ws, path, "4"))).toBe("Pages out of range: the document has 3 pages.");
    const broken = ws.write("project/broken.pdf", "%PDF-1.4 this is not a document");
    expect(text(await read(ws, broken))).toBe("Unreadable PDF: it is protected by a password or damaged.");
    const fake = ws.write("project/fake.pdf", "plain text");
    expect(text(await read(ws, fake))).toContain("does not start with a PDF signature");
  });
});
