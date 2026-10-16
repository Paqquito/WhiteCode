// Implements: SPEC-MOT-045 (CA-10, CA-14: evaluate the published artifact after model or suite changes).
// Supports: gap E-240 (explicit provider revision and immutable published reference).
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Type } from "@sinclair/typebox";
import { compileSchema } from "../shared/schema";
import { globalRate, releaseDecision, type EvaluationSummary } from "./release";
import { evaluateSuite, type EvaluationReport, type ProductExecutor } from "./runner";
import type { LoadedSuite } from "./scenario";

const ReferenceSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  modelRevision: Type.String({ minLength: 1, maxLength: 512, pattern: "^[^\\u0000-\\u001f\\u007f]+$" }),
  artifact: Type.Object({ path: Type.String({ minLength: 1 }), sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }) }, { additionalProperties: false }),
  evaluation: Type.Object({
    family: Type.String({ minLength: 1 }), contractVersion: Type.String({ minLength: 1 }), suiteVersion: Type.String({ minLength: 1 }),
    expectedScenarioIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true }),
    scenarios: Type.Array(Type.Object({ id: Type.String({ minLength: 1 }), clauses: Type.Array(Type.String({ pattern: "^C-[0-9]{2}$" }), { minItems: 1 }), runs: Type.Array(Type.Boolean(), { minItems: 5, maxItems: 5 }) }, { additionalProperties: false }), { minItems: 1 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export interface PublishedReference {
  readonly schemaVersion: 1;
  readonly modelRevision: string;
  readonly artifact: { readonly path: string; readonly sha256: string };
  readonly evaluation: EvaluationSummary;
}
const validateReference = compileSchema<PublishedReference>(ReferenceSchema);

function digest(path: string): string {
  if (!isAbsolute(path)) throw new Error("The published artifact path must be absolute.");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("The published artifact must be an ordinary single-link file.");
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
export function publishedReference(evaluation: EvaluationSummary, path: string, modelRevision: string): PublishedReference {
  const reference = { schemaVersion: 1, artifact: { path, sha256: digest(path) }, modelRevision, evaluation: { family: evaluation.family, contractVersion: evaluation.contractVersion, suiteVersion: evaluation.suiteVersion, expectedScenarioIds: evaluation.expectedScenarioIds, scenarios: evaluation.scenarios.map(scenario => ({ id: scenario.id, clauses: scenario.clauses, runs: scenario.runs })) } };
  return parsePublishedReference(reference);
}
export function parsePublishedReference(value: unknown): PublishedReference {
  const result = validateReference(value);
  if (!result.ok) throw new Error("Invalid published evaluation reference: " + result.errors.join("; "));
  if (!releaseDecision(result.value.evaluation).releasable) throw new Error("An unqualified evaluation cannot become a published reference.");
  if (digest(result.value.artifact.path) !== result.value.artifact.sha256) throw new Error("The published artifact does not match its reference digest.");
  return result.value;
}
export interface RevalidationResult {
  readonly family: string;
  readonly status: "unchanged" | "qualified" | "reevaluation_required";
  readonly triggers: readonly ("model_changed" | "suite_changed")[];
  readonly modelRevision: string;
  readonly published: PublishedReference;
  readonly report?: EvaluationReport;
}

/** The caller executes this exact published artifact, never the current working-tree candidate. */
export async function revalidatePublished(options: { reference: PublishedReference; suite: LoadedSuite; modelRevision: string; execute: (artifact: string, run: Parameters<ProductExecutor>[0]) => ReturnType<ProductExecutor>; onRun?: (scenario: string, index: number, report: import("./runner").RunReport) => void }): Promise<RevalidationResult> {
  const reference = parsePublishedReference(options.reference);
  if (!options.modelRevision || options.modelRevision.length > 512 || /[\u0000-\u001f\u007f]/.test(options.modelRevision)) throw new Error("A non-empty observed provider revision is required.");
  const triggers: Array<"model_changed" | "suite_changed"> = [];
  if (reference.modelRevision !== options.modelRevision) triggers.push("model_changed");
  if (reference.evaluation.suiteVersion !== options.suite.suiteVersion) triggers.push("suite_changed");
  const base = { family: reference.evaluation.family, modelRevision: options.modelRevision, published: reference, triggers };
  if (!triggers.length) return { ...base, status: "unchanged" };
  const verify = () => { if (digest(reference.artifact.path) !== reference.artifact.sha256) throw new Error("The published artifact changed during revalidation."); };
  const measured = await evaluateSuite(options.suite, async run => {
    verify();
    const result = await options.execute(reference.artifact.path, run);
    verify();
    return result;
  }, { contractVersion: reference.evaluation.contractVersion, family: reference.evaluation.family, onRun: options.onRun, ...(reference.evaluation.suiteVersion === options.suite.suiteVersion ? { released: { contractVersion: reference.evaluation.contractVersion, suiteVersion: reference.evaluation.suiteVersion, rate: globalRate(reference.evaluation) } } : {}) });
  const report = { ...measured, artifact: reference.artifact };
  // The published reference and its instructions are retained even when the new observations fail.
  return { ...base, status: report.decision.releasable ? "qualified" : "reevaluation_required", report };
}
