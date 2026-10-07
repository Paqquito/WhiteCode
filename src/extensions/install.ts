// Implements: SPEC-EXT-002 (§ 5.3 steps 1 to 5, FA-01, EF-01, EF-02), SPEC-EXT-007 (§ 5.3 step 3), SPEC-EXT-010 (§ 5.3 step 3)
// Installing an extension of a catalogue with its dependencies: checks, plan, summary, confirmation, then every copy
// moved into place; nothing is left when any step fails.

import type { Settings } from "../config/settings";
import type { Catalog, CatalogEntry, GitRunner } from "./catalog";
import { describePlan, discardPlan, planInstall, type PlanStep } from "./dependencies";
import { blockedReason, flagOf } from "./policy";
import { commitInstall, engineProblem, fetchExtension } from "./store";

export interface InstallInputs {
  readonly configDir: string;
  readonly settings: Settings;
  readonly runner: GitRunner;
  readonly product: { readonly name: string; readonly version: string };
}

export type InstallOutcome =
  | { readonly ok: true; readonly steps: readonly PlanStep[]; readonly activate: readonly string[]; readonly inactive: ReadonlyArray<{ readonly key: string; readonly problem: string }> }
  | { readonly ok: false; readonly error: string; readonly consent?: boolean };

/** Keys activated in this project (any scope), whose constraints the plan must respect. */
export function activeKeys(settings: Settings): Set<string> {
  return new Set(Object.entries(settings.get<Record<string, unknown>>("extensions.enabled")).filter(([, v]) => v === true).map(([k]) => k));
}

/**
 * Steps 1 to 5. `confirm` receives the summary (EF-01: components, executable code, plan) and answers; `false` leaves
 * nothing behind (FA-01).
 */
export async function installExtension(inputs: InstallInputs, catalog: Catalog, entry: CatalogEntry, confirm: (summary: readonly string[]) => Promise<boolean>): Promise<InstallOutcome> {
  const key = `${entry.name}@${catalog.name}`;
  const blocked = blockedReason(inputs.settings, entry.name, catalog.name);
  if (blocked) return { ok: false, error: blocked }; // ERR-02
  const { fetched, error } = fetchExtension(inputs.configDir, catalog, entry, inputs.runner);
  if (!fetched) return { ok: false, error: error! };
  const flag = flagOf(inputs.settings, inputs.configDir, entry.name, catalog.name, fetched.extension.version);
  if (flag?.severity === "critical") {
    discardPlan(undefined, [fetched]);
    return { ok: false, error: `Extension ${key} ${fetched.extension.version} signalée critique par son catalogue : ${flag.reason}. Installation refusée.` }; // SPEC-EXT-010 step 3
  }
  const { plan, error: planError } = planInstall(inputs.configDir, { key, catalog, fetched }, { runner: inputs.runner, activeKeys: activeKeys(inputs.settings) });
  if (!plan) {
    discardPlan(undefined, [fetched]);
    return { ok: false, error: planError! };
  }
  const c = fetched.report.components;
  const executable = plan.steps.flatMap((s) => (s.fetched?.report.problems ?? []).filter((p) => p.level === "info" && p.message.startsWith("Code exécutable")).map((p) => `  ${s.key} : ${p.message.replace(/^Code exécutable : /, "")}`));
  const summary = [
    `Extension ${key} ${fetched.extension.version} — ${fetched.extension.description}`,
    `Compétences : ${c.skills.join(", ") || "aucune"} ; commandes : ${c.commands.join(", ") || "aucune"} ; crochets : ${c.hooks} ; connecteurs : ${c.connectors.join(", ") || "aucun"}.`,
    ...(executable.length > 0 ? ["Code exécutable :", ...executable] : ["Aucun code exécutable."]),
    ...(plan.steps.length > 1 ? ["Plan :", ...describePlan(plan).map((l) => `  ${l}`)] : []),
  ];
  if (!(await confirm(summary))) {
    discardPlan(plan);
    return { ok: false, error: "Installation non confirmée : relancez avec --force après avoir lu le récapitulatif.", consent: true };
  }
  const inactive: Array<{ key: string; problem: string }> = [];
  const activate: string[] = [];
  for (const s of plan.steps) {
    if (s.fetched) commitInstall(inputs.configDir, s.catalog, s.fetched);
    const problem = s.fetched ? engineProblem(s.fetched.extension, inputs.product.version, inputs.product.name) : undefined;
    if (problem) inactive.push({ key: s.key, problem });
    else activate.push(s.key);
  }
  return { ok: true, steps: plan.steps, activate, inactive };
}
