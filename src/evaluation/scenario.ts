// Implements: SPEC-MOT-045 (§ 3 evaluation set, EF-04, EF-07), gap E-014 (scenario format: id, clauses, starting repository, instruction, checks)
// Supports: gap E-248 (verification requires a returned tool result after the final completed change).
// Supports: gap E-252 (verification starts after all completed writes, including notebook changes).

import { Type, type Static } from "@sinclair/typebox";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { compileSchema } from "../shared/schema";

const Check = Type.Union([
  Type.Object({ type: Type.Literal("file_exists"), path: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("file_absent"), path: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("file_unchanged"), path: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("file_contains"), path: Type.String(), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("file_not_contains"), path: Type.String(), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("no_new_files") }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("result_matches"), pattern: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("result_not_contains"), text: Type.String() }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("tool_called"), names: Type.Array(Type.String(), { minItems: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("command_run"), pattern: Type.String(), afterChange: Type.Optional(Type.Boolean()) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("no_repeated_call"), max: Type.Integer({ minimum: 1 }) }, { additionalProperties: false }),
  Type.Object({ type: Type.Literal("halt_reason"), value: Type.String() }, { additionalProperties: false }),
]);
export type ScenarioCheck = Static<typeof Check>;

export const ScenarioSchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z0-9-]+$" }),
    clauses: Type.Array(Type.String({ pattern: "^C-\\d{2}$" }), { minItems: 1 }),
    description: Type.String(),
    /** Starting repository, relative to the scenario folder. */
    repository: Type.String(),
    /** Instruction given to the agent (the request of the run). */
    instruction: Type.String({ minLength: 1 }),
    options: Type.Optional(
      Type.Object(
        {
          approvalMode: Type.Optional(Type.String()),
          allowRules: Type.Optional(Type.Array(Type.String())),
          maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
        },
        { additionalProperties: false },
      ),
    ),
    checks: Type.Array(Check, { minItems: 1 }),
  },
  { additionalProperties: false },
);
export type Scenario = Static<typeof ScenarioSchema>;

export const SuiteSchema = Type.Object(
  {
    schemaVersion: Type.Literal(1),
    /** Version of the suite: rates are compared only on the same version (EF-07). */
    suiteVersion: Type.String({ minLength: 1 }),
    scenarios: Type.Array(Type.String(), { minItems: 1 }),
  },
  { additionalProperties: false },
);

const validateScenario = compileSchema<Scenario>(ScenarioSchema);
const validateSuite = compileSchema<Static<typeof SuiteSchema>>(SuiteSchema);

export interface LoadedScenario extends Scenario {
  readonly folder: string;
}

export interface LoadedSuite {
  readonly suiteVersion: string;
  readonly scenarios: readonly LoadedScenario[];
  readonly declaredScenarioIds?: readonly string[];
}

export class SuiteError extends Error {}

/** Loads and validates a suite and its scenarios. */
export function loadSuite(suiteFile: string): LoadedSuite {
  const base = join(suiteFile, "..");
  const suite = validateSuite(JSON.parse(readFileSync(suiteFile, "utf8")) as unknown);
  if (!suite.ok) throw new SuiteError(`Invalid suite ${suiteFile}: ${suite.errors.join("; ")}`);
  const scenarios = suite.value.scenarios.map((dir): LoadedScenario => {
    const folder = join(base, dir);
    const parsed = validateScenario(JSON.parse(readFileSync(join(folder, "scenario.json"), "utf8")) as unknown);
    if (!parsed.ok) throw new SuiteError(`Invalid scenario ${dir}: ${parsed.errors.join("; ")}`);
    const data = parsed.value;
    if (!existsSync(join(folder, data.repository))) throw new SuiteError(`Scenario ${data.id}: starting repository ${data.repository} not found.`);
    return { ...data, folder };
  });
  const ids = new Set<string>();
  for (const s of scenarios) {
    if (ids.has(s.id)) throw new SuiteError(`Duplicate scenario id ${s.id}.`);
    ids.add(s.id);
  }
  return { suiteVersion: suite.value.suiteVersion, scenarios, declaredScenarioIds: [...ids] };
}

/** Files of a folder, relative, with forward slashes. */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out.push(relative(root, path).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

/** Observed facts of one run, from the `jsonl` events and the workspace. */
export interface RunObservation {
  readonly workspace: string;
  readonly original: string;
  readonly result: string;
  readonly haltReason: string;
  /** Event positions preserve completion order even when tools overlap. */
  readonly toolCalls: ReadonlyArray<{ readonly toolId: string; readonly input: unknown; readonly errored?: boolean; readonly startedAt?: number; readonly completedAt?: number }>;
}

/** Evaluates one check; returns the failure message, or undefined when it holds. */
export function evaluateCheck(check: ScenarioCheck, run: RunObservation): string | undefined {
  const file = (p: string) => join(run.workspace, p);
  const read = (p: string) => (existsSync(file(p)) ? readFileSync(file(p), "utf8") : undefined);
  switch (check.type) {
    case "file_exists":
      return existsSync(file(check.path)) ? undefined : `${check.path} should exist`;
    case "file_absent":
      return existsSync(file(check.path)) ? `${check.path} should not exist` : undefined;
    case "file_unchanged": {
      const before = existsSync(join(run.original, check.path)) ? readFileSync(join(run.original, check.path), "utf8") : undefined;
      return read(check.path) === before ? undefined : `${check.path} was modified`;
    }
    case "file_contains":
      return read(check.path)?.includes(check.text) ? undefined : `${check.path} should contain ${JSON.stringify(check.text)}`;
    case "file_not_contains":
      return read(check.path)?.includes(check.text) ? `${check.path} should not contain ${JSON.stringify(check.text)}` : undefined;
    case "no_new_files": {
      const before = new Set(listFiles(run.original));
      const added = listFiles(run.workspace).filter((f) => !before.has(f));
      return added.length === 0 ? undefined : `unexpected new files: ${added.join(", ")}`;
    }
    case "result_matches":
      return new RegExp(check.pattern, "i").test(run.result) ? undefined : `the answer should match /${check.pattern}/i`;
    case "result_not_contains":
      return run.result.includes(check.text) ? `the answer should not contain ${JSON.stringify(check.text)}` : undefined;
    case "tool_called":
      return run.toolCalls.some((c) => check.names.includes(c.toolId)) ? undefined : `one of ${check.names.join(", ")} should be called`;
    case "command_run": {
      const re = new RegExp(check.pattern, "i");
      const changes = check.afterChange ? run.toolCalls.filter(call => ["write_file", "edit_file", "update_notebook_cell"].includes(call.toolId) && call.errored === false) : [];
      if (check.afterChange && changes.length === 0) return "no completed file change was observed before verification";
      if (changes.some(call => call.completedAt === undefined)) return "file change completion order was not observed";
      const lastChange = Math.max(-1, ...changes.map(call => call.completedAt!));
      const commands = run.toolCalls.filter((c) => (c.toolId === "run_shell" || c.toolId === "run_powershell") && c.errored === false && (!check.afterChange || (c.startedAt !== undefined && c.startedAt > lastChange))).map((c) => String((c.input as { command?: unknown })?.command ?? ""));
      return commands.some((c) => re.test(c)) ? undefined : `a command matching /${check.pattern}/i should be run`;
    }
    case "no_repeated_call": {
      const counts = new Map<string, number>();
      for (const c of run.toolCalls) {
        const key = `${c.toolId}:${JSON.stringify(c.input)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
      const worst = Math.max(0, ...counts.values());
      return worst <= check.max ? undefined : `an identical call was repeated ${worst} times`;
    }
    case "halt_reason":
      return run.haltReason === check.value ? undefined : `halt reason ${run.haltReason}, expected ${check.value}`;
  }
}
