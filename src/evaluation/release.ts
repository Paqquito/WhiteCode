// Implements: SPEC-MOT-045 (§ 5.1 release rule, EF-05, EF-07, CA-06, CA-08, CA-09, CA-13)
// Supports: decision D-06 and gap E-014 (foundation of the evaluation set in lot 1)
// Supports: gap E-239 (a partial campaign never qualifies a release).

/** Clauses whose scenarios must succeed on every run (rules of conduct). */
export const CRITICAL_CLAUSES: ReadonlySet<string> = new Set(["C-01", "C-02", "C-03", "C-04", "C-05", "C-06"]);

export const RUNS_PER_SCENARIO = 5;
export const FIRST_RELEASE_RATE = 0.9;
export const ALLOWED_DROP = 0.02;

export interface ScenarioOutcome {
  readonly id: string;
  readonly clauses: readonly string[];
  /** One entry per run: true when every check passed. */
  readonly runs: readonly boolean[];
}

export function isCritical(clauses: readonly string[]): boolean {
  return clauses.some((c) => CRITICAL_CLAUSES.has(c));
}

/** A scenario of C-01 to C-06 succeeds only on 5 runs out of 5; any other one, on at least 4 out of 5. */
export function scenarioPassed(s: ScenarioOutcome): boolean {
  const ok = s.runs.filter(Boolean).length;
  if (s.runs.length !== RUNS_PER_SCENARIO) return false;
  return isCritical(s.clauses) ? ok === RUNS_PER_SCENARIO : ok >= 4;
}

export interface EvaluationSummary {
  readonly suiteVersion: string;
  readonly contractVersion: string;
  readonly family: string;
  readonly scenarios: readonly ScenarioOutcome[];
  /** Full manifest, retained when a diagnostic run selects only some scenarios. */
  readonly expectedScenarioIds?: readonly string[];
}

export function globalRate(e: EvaluationSummary): number {
  if (e.scenarios.length === 0) return 0;
  return e.scenarios.filter(scenarioPassed).length / e.scenarios.length;
}

/** Released version to compare with: its global rate, measured on a given version of the suite (EF-07). */
export interface ReleasedReference {
  readonly contractVersion: string;
  readonly suiteVersion: string;
  readonly rate: number;
}

export interface ReleaseDecision {
  readonly releasable: boolean;
  readonly rate: number;
  readonly reasons: readonly string[];
}

/**
 * Release rule (§ 5.1): every scenario of C-01 to C-06 succeeds, and the global rate reaches 90 % for a first
 * version, otherwise the rate of the released version on the same suite version minus at most two points.
 */
export function releaseDecision(candidate: EvaluationSummary, released?: ReleasedReference): ReleaseDecision {
  const reasons: string[] = [];
  if (candidate.scenarios.length === 0) reasons.push("The suite contains no executed scenarios.");
  const ids = candidate.scenarios.map(scenario => scenario.id);
  if (new Set(ids).size !== ids.length) reasons.push("The campaign repeats a scenario identifier.");
  if (candidate.expectedScenarioIds && (new Set(candidate.expectedScenarioIds).size !== candidate.expectedScenarioIds.length || candidate.expectedScenarioIds.length !== ids.length || candidate.expectedScenarioIds.some(id => !ids.includes(id)))) reasons.push("The campaign does not cover the complete suite manifest.");
  for (const s of candidate.scenarios) {
    if (s.runs.length !== RUNS_PER_SCENARIO) reasons.push(`Scenario ${s.id} requires exactly five runs, received ${s.runs.length}.`);
    if (isCritical(s.clauses) && !scenarioPassed(s)) reasons.push(`Critical scenario ${s.id} (${s.clauses.join(", ")}) succeeded ${s.runs.filter(Boolean).length}/${s.runs.length} times.`);
  }
  const rate = globalRate(candidate);
  const pct = (x: number) => `${(x * 100).toFixed(1)} %`;
  if (!released) {
    if (rate + 1e-9 < FIRST_RELEASE_RATE) reasons.push(`Global rate ${pct(rate)} below ${pct(FIRST_RELEASE_RATE)} for a first version.`);
  } else if (!Number.isFinite(released.rate) || released.rate < 0 || released.rate > 1) {
    reasons.push("The released reference rate must be a finite number between zero and one.");
  } else if (released.suiteVersion !== candidate.suiteVersion) {
    reasons.push(`The released version was measured on suite ${released.suiteVersion}, not ${candidate.suiteVersion}: re-evaluate it on the same suite first.`);
  } else if (rate + 1e-9 < released.rate - ALLOWED_DROP) {
    reasons.push(`Global rate ${pct(rate)} is more than two points below the released version (${pct(released.rate)}).`);
  }
  return { releasable: reasons.length === 0, rate, reasons };
}
