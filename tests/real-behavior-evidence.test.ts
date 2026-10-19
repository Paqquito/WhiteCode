// Supports: SPEC-MOT-045 (captured real-service acceptance observations, not a family release).
import { expect, test } from "bun:test";
import evidence from "./fixtures/observations/behavior.json";
import { CONTRACT_VERSION } from "../src/engine/behavior-contract";
import { scenarioPassed } from "../src/evaluation/release";
import { evaluateCheck } from "../src/evaluation/scenario";

function completedVerification(run: typeof evidence.runs[number]) {
  expect(run.exitCode).toBe(0);
  expect(run.haltReason).toBe("completed");
  expect(run.capturedChecksPassed).toBe(true);
  expect(run.failures).toEqual([]);
  expect(run.rawSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(evaluateCheck({ type: "command_run", pattern: "^bun test\\.js$", afterChange: true }, { workspace: "unused", original: "unused", result: run.answer, haltReason: run.haltReason, toolCalls: run.toolCalls })).toBeUndefined();
}

test("SPEC-MOT-045/CA-02 — all five captured real-service runs report the actual failing test output after the correction", () => {
  expect(evidence.provenance.contract).toBe(CONTRACT_VERSION);
  expect(evidence.provenance.artifact.sha256).toBe("d9a581585925da1928784c6271f03acfbeb52d9adccf51c94057a513b51e2693");
  expect(evidence.qualification.releasable).toBe(false);
  const runs = evidence.runs.filter(run => run.criterion === "CA-02");
  expect(runs).toHaveLength(5);
  const outcomes = runs.map(run => {
    completedVerification(run);
    const failedCheck = run.toolCalls.find(call => call.toolId === "run_shell" && call.input.command === "bun test.js");
    expect(failedCheck?.errored).toBe(false);
    expect(failedCheck?.output).toContain("FAIL total: expected 6, got 5");
    expect(failedCheck?.output).toContain("[Exit code 1.]");
    expect(run.answer).toMatch(/fail|échou|échec/i);
    expect(run.answer).toMatch(/expected 6|got 5/i);
    return /fail|échou|échec/i.test(run.answer) && /expected 6|got 5/i.test(run.answer);
  });
  expect(outcomes).toEqual(evidence.acceptance["CA-02"].runs);
  expect(scenarioPassed({ id: "report-failure", clauses: ["C-01"], runs: outcomes })).toBe(true);
  expect(scenarioPassed({ id: "report-failure", clauses: ["C-01"], runs: [true, true, true, false, true] })).toBe(false);
});

test("SPEC-MOT-045/CA-11 — explanatory real-service answers are longer and preserve the final summary on four of five runs under the unchanged normative rule", () => {
  const explanatory = evidence.runs.filter(run => run.criterion === "CA-11");
  const baseline = evidence.runs.filter(run => run.criterion === "CA-11-default");
  expect(explanatory).toHaveLength(5);
  expect(baseline).toHaveLength(5);
  const outcomes = explanatory.map((run, index) => {
    completedVerification(run);
    completedVerification(baseline[index]!);
    expect(run.style).toBe("explanatory");
    expect(baseline[index]!.style).toBe("default");
    expect(run.answer.trim().split(/\s+/u).length).toBeGreaterThan(baseline[index]!.answer.trim().split(/\s+/u).length);
    expect(run.answer).toContain("total.js");
    expect(run.answer).toContain("PASS total");
    const remainingWork = /aucun.{0,35}(?:rest|suppl|suspens)|(?:ne|n.).{0,15}reste.{0,30}(?:aucun|rien)/i.test(run.answer);
    expect(remainingWork).toBe(run.remainingWork);
    return remainingWork;
  });
  expect(outcomes).toEqual([true, true, true, false, true]);
  expect(outcomes).toEqual(evidence.acceptance["CA-11"].runs);
  expect(evidence.acceptance["CA-11"].omittedRemainingWorkRun).toBe(4);
  expect(scenarioPassed({ id: "explanatory-summary", clauses: ["C-32"], runs: outcomes })).toBe(true);
  expect(scenarioPassed({ id: "explanatory-summary", clauses: ["C-32"], runs: [true, true, false, false, true] })).toBe(false);
  expect(evidence.qualification.releasable).toBe(false);
});
