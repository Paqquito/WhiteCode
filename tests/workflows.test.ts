import { expect, test } from "bun:test";
import { basename } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
const definition = { name: "parallel", description: "Inspect three independent areas.", maxParallel: 3, parameters: { target: { type: "string", required: true } }, steps: ["one", "two", "three"].map(id => ({ id, type: "agent", prompt: `Inspect ${id}: {%inputs.target%}`, tools: ["read_file", "find_files"] })) };
function workflow(ws: ReturnType<typeof workspace>, value: unknown, project = false) { return ws.write(project ? `project/${loadIdentity().get("PROJECT_DIR")}/workflows/parallel.yaml` : "home/config/workflows/parallel.yaml", JSON.stringify(value)); }
test("SPEC-PLA-004/CA-01 — the workflow command lists all three built-in definitions without a model request", async () => {
  const provider = new ScriptedProvider([]), result = await cli(["--non-interactive", "/workflows"], workspace(), { provider });
  expect(result.code).toBe(0); for (const name of ["review-multi", "batch-migrate", "bug-investigate"]) expect(result.stdout).toContain(name); expect(result.stdout).toContain("intégré"); expect(provider.requests).toHaveLength(0);
});
test("SPEC-PLA-004/CA-02 — a trusted project workflow masks a homonymous built-in", async () => {
  const ws = workspace(); workflow(ws, { ...definition, name: "review-multi", description: "PROJECT_OVERRIDE_47" }, true);
  ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`, JSON.stringify({ trustedProjects: [ws.project] }));
  const result = await cli(["--non-interactive", "/workflows"], ws, { provider: new ScriptedProvider([]) });
  expect(result.code).toBe(0); expect(result.stdout.match(/review-multi/g)).toHaveLength(1); expect(result.stdout).toContain("PROJECT_OVERRIDE_47");
});
test("SPEC-CMD-077/CA-01 — the listing shows a trusted project workflow and its required parameter", async () => {
  const ws = workspace(); workflow(ws, definition, true); ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`, JSON.stringify({ trustedProjects: [ws.project] }));
  const result = await cli(["--non-interactive", "/workflows"], ws, { provider: new ScriptedProvider([]) });
  expect(result.code).toBe(0); expect(result.stdout).toContain("parallel"); expect(result.stdout).toContain("target"); expect(result.stdout).toContain("string");
});
test("SPEC-PLA-003/CA-02 — cyclic workflows are rejected before approval and any child request", async () => {
  const ws = workspace(); workflow(ws, { ...definition, steps: [{ id: "one", type: "agent", prompt: "First", needs: ["two"] }, { id: "two", type: "agent", prompt: "Second", needs: ["one"] }] });
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_workflow", input: { workflow: "parallel", inputs: { target: "code" } } }] }, { text: "Refusal handled." }]);
  const result = await cli(["--non-interactive", "--allow-rule", "run_workflow", "Inspect the code."], ws, { provider });
  expect(result.code).toBe(0); expect(result.stderr).toContain("cycle"); expect(JSON.stringify(provider.requests[1]!.history)).toContain("invalid workflow"); expect(provider.requests.filter(request => request.purpose === "subagent")).toHaveLength(0);
});
test("SPEC-OUT-042/CA-01 — an approved three-step workflow runs concurrently and notifies its complete aggregate", async () => {
  const ws = workspace(); workflow(ws, definition); let approvals = 0;
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_workflow", input: { workflow: "parallel", inputs: { target: "code" } } }] }, { text: "Parent remains available." }, { text: "Aggregate received." }], [1, 2, 3].map(n => ({ text: `REPORT_${n}`, delayMs: 350 })));
  let active = 0, max = 0; const stream = provider.stream.bind(provider);
  provider.stream = async function* (request, signal) { const child = request.purpose === "subagent"; if (child) { active++; max = Math.max(max, active); } try { yield* stream(request, signal); } finally { if (child) active--; } };
  const host = new Host(ws, { provider, init: { decisionAuthority: true }, answers: { approval_request: params => { approvals++; expect(JSON.stringify(params)).toContain("one"); expect(JSON.stringify(params)).toContain("three"); return { decision: "allow" }; } } });
  host.user("Run the workflow."); await host.waitFor(message => JSON.stringify(message).includes("Parent remains available."));
  await new Promise(resolve => setTimeout(resolve, 600)); host.user("Collect the report."); await host.waitFor(message => JSON.stringify(message).includes("Aggregate received.")); host.feed.end(); await host.run;
  expect(approvals).toBe(1); expect(max).toBe(3); const children = provider.requests.filter(request => request.purpose === "subagent"); expect(children).toHaveLength(3);
  const history = JSON.stringify(provider.requests.filter(request => request.purpose !== "subagent").at(-1)!.history); for (const n of [1, 2, 3]) expect(history).toContain(`REPORT_${n}`);
}, 15_000);

test("SPEC-PLA-003/CA-01 — two independent steps overlap and their dependent third step receives both outputs", async () => {
  const ws = workspace(); workflow(ws, { ...definition, steps: [{ id: "one", type: "agent", prompt: "Inspect first" }, { id: "two", type: "agent", prompt: "Inspect second" }, { id: "three", type: "agent", needs: ["one", "two"], prompt: "Combine {%steps.one%} and {%steps.two%}" }] });
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_workflow", input: { workflow: "parallel", inputs: { target: "code" } } }] }, { text: "Parent ready." }, { text: "Report received." }], [{ text: "FIRST_REPORT_47", delayMs: 80 }, { text: "SECOND_REPORT_47", delayMs: 80 }, request => { expect(JSON.stringify(request.history)).toContain("FIRST_REPORT_47"); expect(JSON.stringify(request.history)).toContain("SECOND_REPORT_47"); return { text: "COMBINED_REPORT_47" }; }]);
  let active = 0, max = 0, finished = 0; const stream = provider.stream.bind(provider);
  provider.stream = async function* (request, signal) { const child = request.purpose === "subagent"; if (child) { if (finished < 2) { active++; max = Math.max(max, active); } else expect(finished).toBe(2); } try { yield* stream(request, signal); } finally { if (child) { active--; finished++; } } };
  const host = new Host(ws, { provider, argv: ["--allow-rule", "run_workflow(parallel)"] }); host.user("Run it."); await host.waitFor(message => JSON.stringify(message).includes("Parent ready.")); await new Promise(resolve => setTimeout(resolve, 250)); host.user("Collect it."); await host.waitFor(message => JSON.stringify(message).includes("Report received.")); host.feed.end(); await host.run;
  expect(max).toBe(2); expect(finished).toBe(3); expect(JSON.stringify(provider.requests.filter(request => request.purpose !== "subagent").at(-1)!.history)).toContain("COMBINED_REPORT_47");
}, 15_000);

test("SPEC-OUT-042/CA-02 — stopping a live workflow aborts every active child", async () => {
  const ws = workspace(); workflow(ws, definition); let starts = 0, cancelled = 0, allStarted!: () => void; const ready = new Promise<void>(resolve => { allStarted = resolve; });
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_workflow", input: { workflow: "parallel", inputs: { target: "code" } } }] }, { text: "Parent ready." }, request => { const id = /Workflow started as task (\w+)/.exec(JSON.stringify(request.history))?.[1]; if (!id) throw new Error("Missing workflow id"); return { toolCalls: [{ name: "background_stop", input: { task_id: id } }] }; }, { text: "Workflow stopped." }], [1, 2, 3].map(() => ({ hang: true })));
  const stream = provider.stream.bind(provider); provider.stream = async function* (request, signal) { if (request.purpose === "subagent") { signal.addEventListener("abort", () => { cancelled++; }, { once: true }); if (++starts === 3) allStarted(); } yield* stream(request, signal); };
  const host = new Host(ws, { provider, argv: ["--allow-rule", "run_workflow(parallel)"] }); host.user("Run it."); await ready; await host.waitFor(message => JSON.stringify(message).includes("Parent ready.")); host.user("Stop it."); await host.waitFor(message => JSON.stringify(message).includes("Workflow stopped.")); host.feed.end(); await host.run;
  expect(starts).toBe(3); expect(cancelled).toBe(3);
}, 15_000);
