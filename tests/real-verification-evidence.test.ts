// Supports: SPEC-MOT-045 (existing real observations reused for an independently checked criterion), gap E-251.
import { expect, test } from "bun:test";
import evidence from "./fixtures/observations/verification.json";
import { CONTRACT_VERSION } from "../src/engine/behavior-contract";
import { evaluateCheck } from "../src/evaluation/scenario";

test("SPEC-MOT-045/CA-07 — five captured real-service runs execute the documented check after their final successful edit", () => {
  expect(evidence.provenance.contract).toBe(CONTRACT_VERSION);
  expect(evidence.provenance.style).toBe("explanatory");
  expect(evidence.provenance.artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(evidence.qualification.releasable).toBe(false);
  expect(evidence.runs).toHaveLength(5);
  for (const run of evidence.runs) {
    expect(run.passed).toBe(true);
    expect(run.exitCode).toBe(0);
    expect(run.haltReason).toBe("completed");
    expect(run.failures).toEqual([]);
    expect(evaluateCheck({ type: "command_run", pattern: "^bun test\\.js$", afterChange: true }, { workspace: "unused", original: "unused", result: run.answer, haltReason: run.haltReason, toolCalls: run.toolCalls })).toBeUndefined();
    expect(run.toolCalls.some(call => call.toolId === "read_file" && String(call.input.path ?? "").endsWith("README.md") && String(call.output).includes("bun test.js"))).toBe(true);
    expect(run.toolCalls.some(call => call.toolId === "run_shell" && call.input.command === "bun test.js" && call.errored === false && String(call.output).includes("PASS total"))).toBe(true);
    expect(run.rawSha256).toMatch(/^[a-f0-9]{64}$/);
  }
});
