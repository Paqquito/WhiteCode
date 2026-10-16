// Implements: SPEC-MOT-045 (§ 5.2 point 2 suite run in non-interactive mode with structured output, § 14 report by clause and family, EF-05)
// Supports: gap E-014 (five runs per scenario; real runs by hand or nightly, simulated provider in CI)
// Supports: gap E-248 (a requested shell call alone is not proof of execution).
// Supports: SPEC-MOT-045 (only a successful normal process can qualify), gap E-237.

import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { releaseDecision, RUNS_PER_SCENARIO, scenarioPassed, type EvaluationSummary, type ReleaseDecision, type ReleasedReference, type ScenarioOutcome } from "./release";
import { evaluateCheck, type LoadedScenario, type LoadedSuite, type RunObservation } from "./scenario";

/** Runs the product once: non-interactive, `jsonl` output, in `cwd`. Injected: a real process, or in-process with a simulated provider. */
export type ProductExecutor = (run: { readonly cwd: string; readonly argv: readonly string[]; readonly scenario: LoadedScenario; readonly index: number }) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

export interface RunReport {
  readonly passed: boolean;
  readonly exitCode: number;
  readonly failures: readonly string[];
  readonly haltReason: string;
  /** Measures of the run, from the closing event (report: cost and duration). */
  readonly elapsedMs: number;
  readonly iterations: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: number | null;
  /** Tools called, in order, for the commentary of failures. */
  readonly tools: readonly string[];
  /** Final answer of the agent, shortened. */
  readonly answer: string;
}

export interface ScenarioReport extends ScenarioOutcome {
  readonly passed: boolean;
  readonly details: readonly RunReport[];
}

export interface EvaluationReport extends EvaluationSummary {
  /** Present when an external autonomous artifact was measured and its bytes were verified. */
  readonly artifact?: { readonly path: string; readonly sha256: string };
  readonly scenarios: readonly ScenarioReport[];
  readonly byClause: Readonly<Record<string, { readonly passed: number; readonly total: number }>>;
  readonly decision: ReleaseDecision;
}

/** Arguments of a run: the instruction, non-interactive, `jsonl`, and the options of the scenario. */
export function productArguments(s: LoadedScenario): string[] {
  const argv = ["--non-interactive", "--result-format", "jsonl", "--approval-mode", s.options?.approvalMode ?? "no_prompt"];
  for (const rule of s.options?.allowRules ?? []) argv.push("--allow-rule", rule);
  if (s.options?.maxIterations !== undefined) argv.push("--max-iterations", String(s.options.maxIterations));
  argv.push(s.instruction);
  return argv;
}

function observe(stdout: string, workspace: string, original: string): RunObservation & { closing: Record<string, unknown> } {
  const events = stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
  const closing = events.find((e) => e["type"] === "run_completed") ?? {};
  return {
    workspace,
    original,
    result: String(closing["result"] ?? ""),
    haltReason: String(closing["haltReason"] ?? "missing"),
    toolCalls: events.filter((e) => e["type"] === "tool_call").map((e) => {
      const result = typeof e["callId"] === "string" ? events.find(candidate => candidate["type"] === "tool_result" && candidate["callId"] === e["callId"]) : undefined;
      return { toolId: String(e["toolId"]), input: e["input"], ...(typeof result?.["errored"] === "boolean" ? { errored: result["errored"] } : {}) };
    }),
    closing,
  };
}

/** One run of one scenario in a fresh copy of its starting repository. */
export async function runScenarioOnce(s: LoadedScenario, execute: ProductExecutor, index: number): Promise<RunReport> {
  const original = join(s.folder, s.repository);
  const workspace = mkdtempSync(join(tmpdir(), `eval-${s.id}-`));
  try {
    cpSync(original, workspace, { recursive: true });
    const r = await execute({ cwd: workspace, argv: productArguments(s), scenario: s, index });
    const run = observe(r.stdout, workspace, original);
    const failures = s.checks.map((c) => evaluateCheck(c, run)).filter((f): f is string => f !== undefined);
    if (r.code !== 0) failures.push(`Product exited with code ${r.code}.`);
    if (run.haltReason !== "completed") failures.push(`Product did not complete normally (${run.haltReason}).`);
    const usage = (run.closing["usage"] ?? {}) as { inputTokens?: number; outputTokens?: number };
    const cost = (run.closing["cost"] ?? {}) as { confirmed?: number | null };
    return {
      passed: failures.length === 0,
      exitCode: r.code,
      failures,
      haltReason: run.haltReason,
      elapsedMs: Number(run.closing["elapsedMs"] ?? 0),
      iterations: Number(run.closing["iterations"] ?? 0),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      cost: cost.confirmed ?? null,
      tools: run.toolCalls.map((c) => c.toolId),
      answer: run.result.slice(0, 600),
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

export interface EvaluationOptions {
  readonly runs?: number;
  readonly contractVersion: string;
  readonly family: string;
  readonly released?: ReleasedReference;
  readonly onRun?: (scenario: string, index: number, report: RunReport) => void;
}

/** Runs the whole suite (five runs per scenario by default) and applies the release rule. */
export async function evaluateSuite(suite: LoadedSuite, execute: ProductExecutor, options: EvaluationOptions): Promise<EvaluationReport> {
  const runs = options.runs ?? RUNS_PER_SCENARIO;
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error("The number of evaluation runs must be a positive integer.");
  const scenarios: ScenarioReport[] = [];
  for (const s of suite.scenarios) {
    const details: RunReport[] = [];
    for (let i = 0; i < runs; i++) {
      const report = await runScenarioOnce(s, execute, i);
      options.onRun?.(s.id, i, report);
      details.push(report);
    }
    const outcome: ScenarioOutcome = { id: s.id, clauses: s.clauses, runs: details.map((d) => d.passed) };
    scenarios.push({ ...outcome, passed: scenarioPassed(outcome), details });
  }
  const byClause: Record<string, { passed: number; total: number }> = {};
  for (const s of scenarios) {
    for (const c of s.clauses) {
      const entry = (byClause[c] ??= { passed: 0, total: 0 });
      entry.total++;
      if (s.passed) entry.passed++;
    }
  }
  const summary: EvaluationSummary = { suiteVersion: suite.suiteVersion, contractVersion: options.contractVersion, family: options.family, scenarios, expectedScenarioIds: suite.declaredScenarioIds ?? suite.scenarios.map(scenario => scenario.id) };
  return { ...summary, scenarios, byClause, decision: releaseDecision(summary, options.released) };
}
