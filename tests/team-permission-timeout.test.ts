import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { TeamPermissionQueue } from "../src/agents/permission-relay";
import { bench } from "./helpers/engine";
import { runTurn } from "../src/engine/loop";
import { writeFileTool } from "../src/tools/write-file";
import type { HumanAnswer } from "../src/permissions/resolver";
import { resolveAsk } from "../src/permissions/resolver";
import type { Rule } from "../src/permissions/rules";
const request = { callId: "relay", toolName: "write_file", summary: "Write", reason: "Ask", origin: "default" as const, suggestions: [] };
const decision = { kind: "ask" as const, origin: "default" as const, step: 4, reason: "Ask", suggestions: [] };
test("TECH — a teammate deadline covers all approval authorities together", async () => {
  const queue = new TeamPermissionQueue(() => 40);
  const result = await queue.run(new AbortController().signal, signal => resolveAsk(decision, request, "ask", { habilitatedHook: { decide: async () => { await Bun.sleep(30); return undefined; } }, human: { request: async () => { await Bun.sleep(30); return { answer: "yes" }; } } }, signal));
  expect(result).toBeUndefined();
});
test("TECH — teammate permission requests use one FIFO authority queue", async () => {
  let active = 0, max = 0;
  const queue = new TeamPermissionQueue(() => 100);
  await Promise.all(["first", "second"].map(callId => queue.run(new AbortController().signal, signal => resolveAsk(decision, { ...request, callId }, "ask", { human: { request: async () => { max = Math.max(max, ++active); await Bun.sleep(15); active--; return { answer: "yes" }; } } }, signal))));
  expect(max).toBe(1);
});
test("TECH — a queued teammate call rechecks a newly persisted session allowance", async () => {
  const queue = new TeamPermissionQueue(() => 1000), sessionAllows: Rule[] = []; let approvals = 0;
  const authorities = { human: { request: async (): Promise<HumanAnswer> => { approvals++; await Bun.sleep(30); return { answer: "yes_always", scope: "session", rule: "write_file" }; } } };
  const inputs = [1, 2].map(n => ({ path: "", content: `GRANT_${n}` }));
  const benches = inputs.map(input => bench([{ toolCalls: [{ name: "write_file", input }] }, { text: "Done" }], { mode: "ask", tools: [writeFileTool as never], authorities }));
  await Promise.all(benches.map(async (b, n) => { inputs[n]!.path = join(b.ws.project, "granted.txt"); const base = b.deps.executor.permissionContext; const executor = { ...b.deps.executor, permissionQueue: queue, permissionContext: () => ({ ...base(), sessionAllows }), persistRule: () => { sessionAllows.push({ raw: "write_file", tool: "write_file", decision: "allow", scope: "session", anchor: b.ws.project }); } }; await runTurn({ ...b.deps, executor }, "Write", new AbortController().signal); expect(existsSync(inputs[n]!.path)).toBe(true); }));
  expect(approvals).toBe(1);
});
test("TECH — a nonresponsive leader cannot hold a teammate permission forever or authorise a late write", async () => {
  let late!: (answer: HumanAnswer) => void, activeSignal: AbortSignal | undefined;
  const authorities = { human: { request: async (_request: unknown, signal: AbortSignal): Promise<HumanAnswer> => { activeSignal = signal; return new Promise(resolve => { late = resolve; }); } } };
  const input = { path: "", content: "LATE_GRANT_MUST_NOT_WRITE" };
  const b = bench([{ toolCalls: [{ name: "write_file", input }] }, { text: "Stopped" }], { mode: "ask", tools: [writeFileTool as never], authorities });
  const target = join(b.ws.project, "late.txt"); input.path = target;
  const deps = { ...b.deps, executor: { ...b.deps.executor, permissionQueue: new TeamPermissionQueue(() => 25) } };
  const result = await runTurn(deps, "Write the file", new AbortController().signal); expect(result.stopCause).toBe("completed"); expect(activeSignal?.aborted).toBe(true); expect(JSON.stringify(b.toolResults())).toContain("deadline");
  late({ answer: "yes" }); await Bun.sleep(30); expect(existsSync(target)).toBe(false); expect(existsSync(join(b.ws.project, "placeholder"))).toBe(false);
});
test("TECH — a synchronous authority cannot accept a teammate permission after its absolute deadline", async () => {
  let persisted = 0;
  const input = { path: "", content: "EXPIRED_SYNCHRONOUS_APPROVAL" };
  const b = bench([{ toolCalls: [{ name: "write_file", input }] }, { text: "Done" }], { mode: "ask", tools: [writeFileTool as never], authorities: { human: { request: async () => { const until = Date.now() + 25; while (Date.now() < until) { /* Simulate a synchronous authority blocking timer delivery. */ } return { answer: "yes_always", scope: "session", rule: "write_file" }; } } }, executor: { permissionQueue: new TeamPermissionQueue(() => 1), persistRule: () => { persisted++; } } });
  input.path = join(b.ws.project, "expired.txt"); await runTurn(b.deps, "Write", new AbortController().signal); expect(existsSync(input.path)).toBe(false); expect(persisted).toBe(0);
});
