// Implements: SPEC-EXT-007 (§ 5.1, § 5.3 steps 1 to 4, FA-01, FA-02, EF-01 to EF-03, ERR-01, ERR-02, CA-01, CA-02)
// The installation plan of an extension and its dependencies: for each one, the highest version that satisfies every
// constraint (of the plan and of the installed extensions), conflicts and cycles explained.

import { rmSync } from "node:fs";
import { compareVersions, satisfies } from "../platform/semver";
import { parseRef } from "./ref";
import { cachedCatalog, type Catalog, type CatalogRegistration, type GitRunner } from "./catalog";
import { describeExtension } from "./extension";
import { fetchExtension, installedDir, installedVersions, listInstalled, type Fetched } from "./store";

export interface PlanStep {
  readonly key: string;
  readonly catalog: string;
  /** Fetched to install; absent when an installed version already fits. */
  readonly fetched?: Fetched;
  readonly version: string;
}

export interface Plan {
  readonly steps: readonly PlanStep[];
}

/** Dependencies of a manifest as `<name>@<catalogue>` → range; a bare name is in the catalogue of the dependent (§ 5.1). */
export function dependenciesOf(manifest: Record<string, unknown> | undefined, catalog: string): Array<{ key: string; range: string }> {
  const deps = (manifest?.["dependencies"] ?? {}) as Record<string, string>;
  return Object.entries(deps)
    .map(([ref, range]) => {
      const r = parseRef(ref);
      return { key: `${r.name}@${r.catalog ?? catalog}`, range };
    })
    .sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Manifest of the highest installed version of `key`. */
function installedManifest(configDir: string, key: string): Record<string, unknown> | undefined {
  const { name, catalog } = parseRef(key);
  const version = installedVersions(configDir, catalog!, name)[0];
  return version ? describeExtension(installedDir(configDir, catalog!, name, version), false).manifest : undefined;
}

/** Discards every fetched copy of a plan that is not applied (EF-02 of SPEC-EXT-002: no partial trace). */
export function discardPlan(plan: Plan | undefined, extra: readonly Fetched[] = []): void {
  for (const f of [...(plan?.steps.map((s) => s.fetched) ?? []), ...extra]) if (f) rmSync(f.temp, { recursive: true, force: true });
}

/**
 * Steps 1 and 2 for `target` (already fetched): the plan, or the explanation of a refusal (missing dependency, conflict,
 * cycle). Deterministic (EF-01): dependencies are visited in name order.
 */
export function planInstall(
  configDir: string,
  target: { readonly key: string; readonly catalog: Catalog; readonly fetched: Fetched },
  o: { readonly runner: GitRunner; readonly activeKeys: ReadonlySet<string>; readonly registrations?: Readonly<Record<string, CatalogRegistration>> },
): { plan?: Plan; error?: string } {
  const steps = new Map<string, PlanStep>([[target.key, { key: target.key, catalog: target.catalog.name, fetched: target.fetched, version: target.fetched.extension.version }]]);
  const manifests = new Map<string, Record<string, unknown> | undefined>([[target.key, target.fetched.extension.manifest]]);
  const manifestOf = (key: string) => (manifests.has(key) ? manifests.get(key) : installedManifest(configDir, key));
  const fail = (error: string) => {
    discardPlan({ steps: [...steps.values()].filter((s) => s.key !== target.key) });
    return { error };
  };
  /** Every constraint on `key`: from the plan, and from the installed extensions active in this project. */
  const constraints = (key: string) => {
    const by = new Set([...steps.keys(), ...[...o.activeKeys].filter((k) => !steps.has(k))]);
    const out: Array<{ by: string; range: string }> = [];
    for (const k of [...by].sort()) {
      const catalog = parseRef(k).catalog!;
      for (const d of dependenciesOf(manifestOf(k), catalog)) if (d.key === key) out.push({ by: k, range: d.range });
    }
    return out;
  };
  const queue = [target.key];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const catalog = parseRef(current).catalog!;
    for (const dep of dependenciesOf(manifestOf(current), catalog)) {
      if (steps.has(dep.key)) continue;
      const { name, catalog: depCatalog } = parseRef(dep.key);
      const wanted = constraints(dep.key);
      const fits = (v: string) => wanted.every((c) => satisfies(v, c.range));
      const installed = installedVersions(configDir, depCatalog!, name);
      const usable = installed.find(fits);
      if (usable) {
        steps.set(dep.key, { key: dep.key, catalog: depCatalog!, version: usable });
        queue.push(dep.key);
        continue;
      }
      const c = cachedCatalog(configDir, depCatalog!, o.registrations?.[depCatalog!]);
      const entry = c?.extensions.find((e) => e.name === name);
      if (!c || !entry) return fail(`Dépendance introuvable : ${dep.key} (exigée par ${current}).`); // ERR-01
      const { fetched, error } = fetchExtension(configDir, c, entry, o.runner);
      if (!fetched) return fail(`Dépendance ${dep.key} indisponible : ${error}`);
      if (!fits(fetched.extension.version)) {
        rmSync(fetched.temp, { recursive: true, force: true });
        const available = [...installed.map((v) => `${v} (installée)`), `${fetched.extension.version} (catalogue ${depCatalog})`];
        // FA-01, EF-03: who requires what.
        return fail(`Conflit de dépendances sur ${dep.key} : ${wanted.map((w) => `${w.by} exige ${w.range}`).join(", ")} ; versions disponibles : ${available.join(", ")}.`);
      }
      steps.set(dep.key, { key: dep.key, catalog: depCatalog!, fetched, version: fetched.extension.version });
      manifests.set(dep.key, fetched.extension.manifest);
      queue.push(dep.key);
    }
  }
  // EF-02, ERR-02: a cycle among the dependencies is refused.
  const visiting: string[] = [];
  const done = new Set<string>();
  const cycle = (key: string): string[] | undefined => {
    if (visiting.includes(key)) return [...visiting.slice(visiting.indexOf(key)), key];
    if (done.has(key)) return undefined;
    visiting.push(key);
    for (const d of dependenciesOf(manifestOf(key), parseRef(key).catalog!)) {
      const found = cycle(d.key);
      if (found) return found;
    }
    visiting.pop();
    done.add(key);
    return undefined;
  };
  const loop = cycle(target.key);
  if (loop) return fail(`Dépendances circulaires : ${loop.map((k) => parseRef(k).name).join(" → ")}.`);
  // Dependencies first, then the target (the order of installation).
  const ordered = [...steps.values()].reverse();
  return { plan: { steps: ordered } };
}

/** FA-02: active extensions whose dependencies are inactive or in a version out of range are left out, with a warning. */
export function withDependencies(active: ReadonlyMap<string, { readonly version: string; readonly manifest?: Record<string, unknown> }>): { kept: Set<string>; warnings: string[] } {
  const kept = new Set(active.keys());
  const warnings: string[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (const key of [...kept].sort()) {
      const catalog = parseRef(key).catalog!;
      const broken = dependenciesOf(active.get(key)!.manifest, catalog).find((d) => !kept.has(d.key) || !satisfies(active.get(d.key)!.version, d.range));
      if (!broken) continue;
      kept.delete(key);
      changed = true;
      warnings.push(`Extension ${key} désactivée : sa dépendance ${broken.key} ${broken.range} n'est pas active${kept.has(broken.key) || active.has(broken.key) ? " dans une version compatible" : ""}.`);
    }
  }
  return { kept, warnings };
}

/** The highest version of the plan steps already installed, for display. */
export function describePlan(plan: Plan): string[] {
  return plan.steps.map((s) => `${s.key} ${s.version}${s.fetched ? " (à installer)" : " (déjà installée)"}`);
}

/** Every installed extension, for the constraints of the update. */
export function installedKeys(configDir: string): string[] {
  return listInstalled(configDir).map((i) => `${i.name}@${i.catalog}`);
}

export const highest = (versions: readonly string[]) => [...versions].sort((a, b) => compareVersions(b, a))[0];
