import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Host } from "./helpers/control";
import { workspace, type Workspace } from "./helpers/env";
import { bunCommand, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const workflow = (ws: Workspace, name: string, steps: unknown[]) => ws.write(`home/config/workflows/${name}.yaml`, JSON.stringify({ name, description: "Verify workflow lifetime.", maxParallel: 2, steps }));
const script = (ws: Workspace, name: string, body: string) => bunCommand(ws.write(`project/${name}.ts`, body).replace(/\\/g, "/"));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitUntil(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) { if (Date.now() >= deadline) throw new Error("Workflow fixture did not start."); await Bun.sleep(10); }
}

test("TECH — stopping an outer workflow joins its nested workflow and every active agent before reporting success", async () => {
  const ws = workspace();
  workflow(ws, "outer-lifetime", [{ id: "delegate", type: "agent", prompt: "OUTER_LAUNCH_47", tools: ["run_workflow", "spawn_agent"] }]);
  workflow(ws, "inner-lifetime", [{ id: "wait", type: "agent", prompt: "INNER_CHILD_WAIT_47" }]);
  const active = new Set<string>(), ended = new Set<string>(), aborted = new Set<string>();
  let nestedId = "", stoppedState: unknown, nestedOutput = "";
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "run_workflow", input: { workflow: "outer-lifetime" } }] },
    { text: "PARENT_READY_47" },
    request => {
      const id = /Workflow started as task (\w+)/.exec(JSON.stringify(request.history))?.[1];
      if (!id) throw new Error("Outer workflow id missing.");
      return { toolCalls: [{ name: "background_stop", input: { task_id: id } }] };
    },
    request => {
      expect(JSON.stringify(request.history)).toContain("Task w1 stopped.");
      stoppedState = { active: active.size, ended: ended.size, aborted: aborted.size };
      return { toolCalls: [{ name: "background_output", input: { task_id: nestedId, block: false } }] };
    },
    request => { nestedOutput = JSON.stringify(request.history.at(-1)); return { text: "STOP_CHECKED_47" }; },
  ], [
    { toolCalls: [{ name: "run_workflow", input: { workflow: "inner-lifetime" } }] },
    { hang: true },
    { hang: true },
  ]);
  const stream = provider.stream.bind(provider);
  provider.stream = async function* (request, signal) {
    const history = JSON.stringify(request.history), waiting = request.purpose === "subagent" && (history.includes("INNER_CHILD_WAIT_47") || history.includes("Workflow started as task"));
    if (!waiting) { yield* stream(request, signal); return; }
    const id = request.agent!;
    nestedId ||= /Workflow started as task (\w+)/.exec(history)?.[1] ?? "";
    active.add(id); signal.addEventListener("abort", () => { aborted.add(id); }, { once: true });
    try { yield* stream(request, signal); } finally { active.delete(id); ended.add(id); }
  };
  const host = new Host(ws, { provider, argv: ["--allow-rule", "run_workflow"], userConfig: { agents: { maxDepth: 3 } } });
  try {
    host.user("Launch the outer workflow.");
    await waitUntil(() => active.size === 2, 5_000);
    await host.waitFor(message => JSON.stringify(message).includes("PARENT_READY_47"));
    host.user("Stop the outer workflow.");
    await host.waitFor(message => JSON.stringify(message).includes("STOP_CHECKED_47"));
    expect(nestedId).toBe("w2");
    expect(stoppedState).toEqual({ active: 0, ended: 2, aborted: 2 });
    expect(nestedOutput).toContain("stopped");
    expect(nestedOutput).not.toContain("still running");
  } finally { host.feed.end(); await host.run; }
}, 15_000);

test("TECH — a shell-only workflow obeys max-duration after the parent finishes and never runs its dependent step", async () => {
  const ws = workspace(), pidFile = join(ws.project, "workflow.pid"), witness = join(ws.project, "dependent-step.txt");
  const longCommand = script(ws, "long-step", `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(2_500);`);
  const nextCommand = script(ws, "dependent-step", `await Bun.write(${JSON.stringify(witness)}, "MUST_NOT_RUN_47"); await Bun.sleep(10_000);`);
  workflow(ws, "shell-lifetime", [{ id: "long", type: "shell", command: longCommand }, { id: "next", type: "shell", command: nextCommand, needs: ["long"] }]);
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "run_workflow", input: { workflow: "shell-lifetime" } }] },
    { text: "PARENT_FINISHED_47" },
  ]);
  const host = new Host(ws, { provider, argv: ["--max-duration", "1", "--allow-rule", "run_workflow", "--allow-rule", "run_shell"], env: productEnv(ws) });
  try {
    host.user("Launch the shell workflow.");
    await host.waitFor(message => JSON.stringify(message).includes("PARENT_FINISHED_47"));
    await waitUntil(() => existsSync(pidFile));
    const pid = Number(readFileSync(pidFile, "utf8"));
    // The deadline may have killed the child while the foreground turn was finishing.
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await Bun.sleep(1_500);
    const runningAfterDeadline = alive(pid);
    await Bun.sleep(1_700);
    expect({ runningAfterDeadline, dependentStepRan: existsSync(witness) }).toEqual({ runningAfterDeadline: false, dependentStepRan: false });
    expect(provider.requests.filter(request => request.purpose !== "subagent")).toHaveLength(2);
  } finally { host.feed.end(); await host.run; }
}, 15_000);
