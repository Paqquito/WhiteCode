import { expect, test } from "bun:test";
import { parseWorkflow, workflowInputs, type Workflow } from "../src/workflows/definitions";
import { WorkflowRunner } from "../src/workflows/runtime";
import { builtinWorkflows } from "../src/workflows/builtin";
const definition = (steps: unknown[]) => parseWorkflow(JSON.stringify({ name: "check", description: "Run checks.", maxParallel: 2, steps }));
test("TECH — all built-in workflows validate as public definitions", () => { expect(builtinWorkflows().map(workflow => workflow.name)).toEqual(["review-multi", "batch-migrate", "bug-investigate"]); });
test("TECH — workflow definitions reject unknown substitutions before any execution", () => {
  expect(() => definition([{ id: "one", type: "shell", command: "echo {%unknown%}" }])).toThrow();
});
test("TECH — workflow iterations execute concurrently within the local parallelism limit", async () => {
  const workflow: Workflow = { ...parseWorkflow(JSON.stringify({ name: "check", description: "Run checks.", maxParallel: 2, parameters: { items: { type: "array", required: true } }, steps: [{ id: "one", type: "agent", prompt: "Inspect {%item%}", forEach: "inputs.items" }] })), source: "user" };
  let active = 0, max = 0;
  const result = await new WorkflowRunner(4).run(workflow, workflowInputs(workflow, { items: ["a", "b", "c"] }), new AbortController().signal, async (_step, task) => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 20)); active--; return { text: task, isError: false }; }, () => {}, () => {});
  expect(max).toBe(2); expect(result.isError).toBe(false); expect(result.text).toContain("Inspect c");
});
test("TECH — cancellation waits for every active workflow child and starts no queued child", async () => {
  const workflow: Workflow = { ...definition(["one", "two", "three"].map(id => ({ id, type: "agent", prompt: id }))), source: "user" }, controller = new AbortController();
  let started = 0, ended = 0; const run = new WorkflowRunner(2).run(workflow, {}, controller.signal, async (_step, _task, signal) => { started++; await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); if (signal.aborted) resolve(undefined); }); ended++; return { text: "Cancelled", isError: true }; }, () => {}, () => {});
  await new Promise(resolve => setTimeout(resolve, 5)); controller.abort(); expect((await run).isError).toBe(true); expect(started).toBe(2); expect(ended).toBe(2);
});

test("TECH — a rejected workflow iteration stops its queued siblings and retains the failure aggregate", async () => {
  const workflow: Workflow = { ...parseWorkflow(JSON.stringify({ name: "check", description: "Run checks.", maxParallel: 1, parameters: { items: { type: "array", required: true } }, steps: [{ id: "one", type: "agent", prompt: "Inspect {%item%}", forEach: "inputs.items" }, { id: "synthesis", type: "agent", prompt: "Report {%steps.one%}", needs: ["one"] }], output: "{%steps.synthesis%}" })), source: "user" };
  let started = 0;
  const result = await new WorkflowRunner(4).run(workflow, { items: ["a", "b", "c"] }, new AbortController().signal, async () => { started++; throw new Error("FAILURE_EVIDENCE_47"); }, () => {}, () => {});
  expect(started).toBe(1); expect(result.isError).toBe(true); expect(result.text).toContain("FAILURE_EVIDENCE_47"); expect(result.text).toContain("Not executed");
});

test("TECH — typed workflow parameters reject null instead of silently substituting a default", () => {
  const workflow = parseWorkflow(JSON.stringify({ name: "check", description: "Run checks.", parameters: { target: { type: "string", default: "." } }, steps: [{ id: "one", type: "agent", prompt: "Inspect {%inputs.target%}" }] }));
  expect(() => workflowInputs(workflow, { target: null })).toThrow();
});

test("TECH — workflow conditions and loops require present parameters of their declared type", () => {
  expect(() => parseWorkflow(JSON.stringify({ name: "check", description: "Run checks.", parameters: { "invalid name": { type: "string" } }, steps: [{ id: "one", type: "agent", prompt: "Check" }] }))).toThrow();
  expect(() => parseWorkflow(JSON.stringify({ name: "check", description: "Run checks.", parameters: { enabled: { type: "string" } }, steps: [{ id: "one", type: "agent", prompt: "Check", when: "inputs.enabled" }] }))).toThrow();
  const workflow = parseWorkflow(JSON.stringify({ name: "check", description: "Run checks.", parameters: { enabled: { type: "boolean" } }, steps: [{ id: "one", type: "agent", prompt: "Check", when: "inputs.enabled" }] }));
  expect(() => workflowInputs(workflow, {})).toThrow();
});

test("TECH — separate workflows share the global execution ceiling", async () => {
  const workflow: Workflow = { ...definition(["one", "two", "three"].map(id => ({ id, type: "agent", prompt: id }))), source: "user" }, runner = new WorkflowRunner(2);
  let active = 0, max = 0, completed = 0;
  const execute = async () => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 10)); active--; completed++; return { text: "Done", isError: false }; };
  await Promise.all([runner.run(workflow, {}, new AbortController().signal, execute, () => {}, () => {}), runner.run(workflow, {}, new AbortController().signal, execute, () => {}, () => {})]);
  expect(max).toBe(2); expect(completed).toBe(6);
});

test("TECH — a journal failure aborts and joins all workflow children promptly", async () => {
  const workflow: Workflow = { ...definition(["one", "two"].map(id => ({ id, type: "agent", prompt: id }))), source: "user" }; let ended = 0, broken = false; const started = Date.now();
  const result = new WorkflowRunner(2).run(workflow, {}, AbortSignal.timeout(300), async (step, _task, signal) => { if (step.id === "one") await new Promise(resolve => setTimeout(resolve, 5)); else await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); ended++; return { text: "Done", isError: false }; }, () => {}, text => { if (text.includes("one: succeeded")) broken = true; if (broken) throw new Error("ENOSPC"); });
  await expect(result).rejects.toThrow("ENOSPC"); expect(ended).toBe(2); expect(Date.now() - started).toBeLessThan(200);
});

test("TECH — public step output substitutions are validated and expanded with their dependencies", async () => {
  const workflow: Workflow = { ...definition([{ id: "one", type: "agent", prompt: "First" }, { id: "two", type: "agent", prompt: "Use ${steps.one.output}", needs: ["one"] }]), output: "${steps.two.output}", source: "user" };
  const result = await new WorkflowRunner(2).run(workflow, {}, new AbortController().signal, async (_step, task) => ({ text: task, isError: false }), () => {}, () => {});
  expect(result.text).toBe("Use First"); expect(() => definition([{ id: "two", type: "agent", prompt: "Use ${steps.one.output}" }])).toThrow();
});
