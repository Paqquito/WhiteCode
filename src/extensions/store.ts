// Implements: SPEC-EXT-002 (§ 5.3 steps 1, 3 and 5, FA-01, EF-02, EF-03, ERR-01, ERR-03), SPEC-EXT-008 (§ 5.3, EF-01, EF-02, ERR-02)
// Installed copies: `<configuration>/extensions/<catalogue>/<name>/<version>/`, one per version, shared by the scopes;
// fetched into a temporary folder, validated, then moved in one step (no partial trace).

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { compareVersions, satisfies } from "../platform/semver";
import { cloneGit, fetchSource, type Catalog, type CatalogEntry, type GitRunner } from "./catalog";
import { describeExtension, type Extension } from "./extension";
import { validateExtension, type ValidationReport } from "./validate";

export const installedRoot = (configDir: string) => join(configDir, "extensions");
export const installedDir = (configDir: string, catalog: string, name: string, version: string) => join(installedRoot(configDir), catalog, name, version);
export const dataDir = (configDir: string, name: string) => join(configDir, "extension-data", name);

const list = (dir: string) => {
  try {
    return readdirSync(dir).filter((e) => !e.startsWith("."));
  } catch {
    return [];
  }
};

/** Installed versions of `name@catalog`, the highest first (semantic order, EF-01 of SPEC-EXT-008). */
export function installedVersions(configDir: string, catalog: string, name: string): string[] {
  return list(join(installedRoot(configDir), catalog, name)).sort((a, b) => compareVersions(b, a));
}

export interface InstalledRef {
  readonly name: string;
  readonly catalog: string;
  readonly versions: readonly string[];
}

export function listInstalled(configDir: string): InstalledRef[] {
  const out: InstalledRef[] = [];
  for (const catalog of list(installedRoot(configDir)))
    for (const name of list(join(installedRoot(configDir), catalog))) {
      const versions = installedVersions(configDir, catalog, name);
      if (versions.length > 0) out.push({ name, catalog, versions });
    }
  return out;
}

/** EF-02 of SPEC-EXT-008: an extension whose `engine` excludes this version of the product is not activated (ERR-02). */
export function engineProblem(ext: Extension, productVersion: string, product: string): string | undefined {
  const engine = ext.manifest?.["engine"];
  if (typeof engine !== "string" || satisfies(productVersion, engine)) return undefined;
  return `Cette extension nécessite une autre version de ${product} (${engine} ; version actuelle ${productVersion}).`;
}

export interface Fetched {
  readonly temp: string;
  readonly extension: Extension;
  readonly report: ValidationReport;
}

/** Step 3: the extension of `entry` in a temporary folder, validated (SPEC-EXT-012 EF-01: the same checks as the command). */
export function fetchExtension(configDir: string, catalog: Catalog, entry: CatalogEntry, runner: GitRunner): { fetched?: Fetched; error?: string } {
  const temp = join(installedRoot(configDir), `.tmp-${randomUUID()}`);
  mkdirSync(installedRoot(configDir), { recursive: true });
  let failed: string | undefined;
  if (typeof entry.source === "string") failed = fetchSource({ kind: "folder", path: resolve(configDir, "catalogs", catalog.name, entry.source) }, temp, {}, runner);
  else if (entry.source.path) {
    const clone = `${temp}-clone`;
    failed = cloneGit(entry.source.git, clone, { ref: entry.source.ref }, runner);
    if (!failed) cpSync(join(clone, entry.source.path), temp, { recursive: true });
    rmSync(clone, { recursive: true, force: true });
  } else failed = cloneGit(entry.source.git, temp, { ref: entry.source.ref }, runner);
  const discard = (error: string) => {
    rmSync(temp, { recursive: true, force: true }); // FA-01: no partial trace
    return { error };
  };
  if (failed) return discard(failed.startsWith("Git est nécessaire") ? "Git est nécessaire pour installer cette extension." : failed); // ERR-03
  rmSync(join(temp, ".git"), { recursive: true, force: true });
  const report = validateExtension(temp)!;
  const errors = report.problems.filter((p) => p.level === "error");
  if (errors.length > 0) return discard(`Extension ${entry.name} invalide : ${errors.map((e) => e.message).join(" ; ")}`);
  const extension = describeExtension(temp, false);
  if (extension.name !== entry.name) return discard(`Le manifeste de ${entry.name} porte le nom ${extension.name}.`);
  return { fetched: { temp, extension, report } };
}

/** Step 5: moved into place in one rename (EF-02); an installed copy of the same version is replaced. */
export function commitInstall(configDir: string, catalog: string, fetched: Fetched): string {
  const final = installedDir(configDir, catalog, fetched.extension.name, fetched.extension.version);
  mkdirSync(join(final, ".."), { recursive: true });
  if (existsSync(final)) rmSync(final, { recursive: true, force: true });
  renameSync(fetched.temp, final);
  return final;
}

/** Removes every installed version, and the data unless kept (FA-03). */
export function uninstall(configDir: string, catalog: string, name: string, preserveData: boolean): void {
  rmSync(join(installedRoot(configDir), catalog, name), { recursive: true, force: true });
  if (!preserveData) rmSync(dataDir(configDir, name), { recursive: true, force: true });
}
