import { expect, test } from "bun:test";
import { evaluateCheck, type RunObservation } from "../src/evaluation/scenario";
import { runScenarioOnce } from "../src/evaluation/runner";
import { workspace } from "./helpers/env";

const write = { toolId: "edit_file", input: { path: "total.js" }, errored: false };
const command = { toolId: "run_shell", input: { command: "bun test.js" }, errored: false };
const observation = (toolCalls: RunObservation["toolCalls"]): RunObservation => ({ workspace: "unused", original: "unused", result: "", haltReason: "completed", toolCalls: toolCalls.map((call, index) => ({ startedAt: index * 2, completedAt: index * 2 + 1, ...call })) });

test("TECH — a denied or unreturned command is never evidence that verification ran", () => {
  const check = { type: "command_run", pattern: "test\\.js" } as const;
  expect(evaluateCheck(check, observation([{ ...command, errored: true }]))).toBeDefined();
  expect(evaluateCheck(check, observation([{ toolId: command.toolId, input: command.input }]))).toBeDefined();
  expect(evaluateCheck(check, observation([command]))).toBeUndefined();
});

test("TECH — a notebook write is a change and a command started before a write completed cannot verify it", () => {
  const check = { type: "command_run", pattern: "test\\.js", afterChange: true } as const;
  const notebook = { ...write, toolId: "update_notebook_cell" };
  expect(evaluateCheck(check, observation([notebook, command]))).toBeUndefined();
  expect(evaluateCheck(check, observation([write, command, notebook]))).toBeDefined();
  expect(evaluateCheck(check, observation([{ ...write, startedAt: 0, completedAt: 4 }, { ...command, startedAt: 1, completedAt: 3 }]))).toBeDefined();
});

test("TECH — verification before the last successful change cannot validate the final code", () => {
  const check = { type: "command_run", pattern: "test\\.js", afterChange: true } as const;
  expect(evaluateCheck(check, observation([command, write]))).toBeDefined();
  expect(evaluateCheck(check, observation([write, command, write]))).toBeDefined();
  expect(evaluateCheck(check, observation([command]))).toBeDefined();
  expect(evaluateCheck(check, observation([write, command]))).toBeUndefined();
});

test("TECH — runner binds a verification result to its exact call ID and retains a permission refusal", async () => {
  const ws = workspace();
  const scenario = { id: "verification-evidence", clauses: ["C-13"], description: "Observed execution", folder: ws.root, repository: "project", instruction: "Verify.", checks: [{ type: "command_run" as const, pattern: "test\\.js" }] };
  for (const [callId, errored, expected] of [["another-call", false, false], ["verify", true, false], ["verify", false, true]] as const) {
    const result = await runScenarioOnce(scenario, async () => ({ code: 0, stderr: "", stdout: [
      { type: "tool_call", toolId: "run_shell", callId: "verify", input: { command: "bun test.js" } },
      { type: "tool_result", callId, errored },
      { type: "run_completed", haltReason: "completed", result: "Done." },
    ].map(event => JSON.stringify(event)).join("\n") }), 0);
    expect(result.passed).toBe(expected);
  }
});

test("TECH — runner rejects a verification command that overlaps the final write despite its later call position", async () => {
  const ws = workspace();
  const scenario = { id: "overlapping-verification", clauses: ["C-13"], description: "Observed completion order", folder: ws.root, repository: "project", instruction: "Verify.", checks: [{ type: "command_run" as const, pattern: "test\\.js", afterChange: true }] };
  const writeCall = { type: "tool_call", toolId: "edit_file", callId: "write", input: {} }, writeResult = { type: "tool_result", callId: "write", errored: false };
  const commandCall = { type: "tool_call", toolId: "run_shell", callId: "verify", input: { command: "bun test.js" } }, commandResult = { type: "tool_result", callId: "verify", errored: false };
  for (const [events, expected] of [[[writeCall, commandCall, commandResult, writeResult], false], [[writeCall, writeResult, commandCall, commandResult], true]] as const) {
    const result = await runScenarioOnce(scenario, async () => ({ code: 0, stderr: "", stdout: [...events, { type: "run_completed", haltReason: "completed", result: "Done." }].map(event => JSON.stringify(event)).join("\n") }), 0);
    expect(result.passed).toBe(expected);
  }
});
