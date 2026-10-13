// Implements: SPEC-EXT-003 (§ 5.1 priority, § 5.3, FA-01, EF-01, EF-03, CA-01), SPEC-EXT-008 (EF-02, ERR-02 at activation),
//             SPEC-EXT-007 (FA-02), SPEC-EXT-009 (§ 5.3 steps 1 to 4, FA-01, EF-01 to EF-03, CA-01), SPEC-EXT-010 (§ 5.3 step 2, EF-01, EF-02, CA-01)
// The installed extensions active for a session: `extensions.enabled`, merged from the weakest scope to the strongest
// (user < project < local < managed), resolved to the highest installed version, then filtered by the policy, the flags
// of the catalogues and the dependencies.

import type { Settings } from "../config/settings";
import { setValueInSettingsFile } from "../config/settings-writer";
import type { PlatformName } from "../platform/system";
import { cachedCatalog, refreshCatalog, type CatalogRegistration, type GitRunner } from "./catalog";
import { withDependencies } from "./dependencies";
import { describeExtension } from "./extension";
import { installExtension } from "./install";
import type { ActiveExtension } from "./load";
import { blockedReason, flagOf } from "./policy";
import { parseRef } from "./ref";
import { engineProblem, installedDir, installedVersions } from "./store";

export { parseRef } from "./ref";

export interface Activations {
  readonly active: readonly ActiveExtension[];
  readonly report: readonly string[];
  /** Warnings that cannot be hidden (FA-01 of SPEC-EXT-009). */
  readonly imposedProblems: readonly string[];
}

export interface ActivationInputs {
  /** Read-only administration lists installed contributions without installing missing imposed extensions. */
  readonly installMissing?: boolean;
  readonly settings: Settings;
  readonly configDir: string;
  readonly product: { readonly name: string; readonly version: string; readonly cli: string };
  readonly runner: GitRunner;
  readonly cwd: string;
  /** Where the dependencies of an imposed extension are activated (the managed scope is never written). */
  readonly userSettingsFile: string;
  readonly platform: PlatformName;
}

/** Keys set to `true` by the managed scope: imposed extensions (SPEC-EXT-009 § 5.1). */
export function imposedKeys(settings: Settings): Set<string> {
  const managed = settings.valuesByScope("extensions.enabled").find((v) => v.origin === "managed")?.value as Record<string, unknown> | undefined;
  return new Set(Object.entries(managed ?? {}).filter(([, v]) => v === true).map(([k]) => k));
}

/** Step 1 of SPEC-EXT-009: an imposed extension missing is installed without confirmation, from the catalogues added by the organisation. */
async function installImposed(i: ActivationInputs, key: string): Promise<string | undefined> {
  const { name, catalog } = parseRef(key);
  const registration = i.settings.get<Record<string, CatalogRegistration>>("extensions.catalogs")[catalog!];
  if (!registration) return `catalogue ${catalog} non configuré`;
  const c = cachedCatalog(i.configDir, catalog!) ?? refreshCatalog(i.configDir, catalog!, registration, i.cwd, i.runner).catalog;
  const entry = c?.extensions.find((e) => e.name === name);
  if (!c || !entry) return `absente du catalogue ${catalog}`;
  const outcome = await installExtension({ configDir: i.configDir, settings: i.settings, runner: i.runner, product: i.product }, c, entry, async () => true);
  if (!outcome.ok) return outcome.error;
  for (const k of outcome.activate) if (k !== key) setValueInSettingsFile(i.userSettingsFile, ["extensions", "enabled", k], true, i.platform);
  return undefined;
}

/** § 5.3 for a session: the active installed extensions, and the report of those left out with the reason (§ 5.3 step 4 of SPEC-EXT-009). */
export async function activeInstalled(i: ActivationInputs): Promise<Activations> {
  const enabled = i.settings.get<Record<string, unknown>>("extensions.enabled");
  const imposed = imposedKeys(i.settings);
  const managedOnly = i.settings.get<boolean>("extensions.managedOnly");
  const report: string[] = [];
  const imposedProblems: string[] = [];
  const candidates = new Map<string, { root: string; version: string; manifest?: Record<string, unknown> }>();
  for (const [key, value] of Object.entries(enabled).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (value !== true) continue;
    const { name, catalog } = parseRef(key);
    if (!catalog) {
      report.push(`extensions.enabled : ${key} ignorée : forme attendue <nom>@<catalogue>.`);
      continue;
    }
    if (managedOnly && !imposed.has(key)) {
      report.push(`Extension ${key} ignorée : seules les extensions gérées sont admises (extensions.managedOnly).`); // EF-03
      continue;
    }
    let version = installedVersions(i.configDir, catalog, name)[0];
    if (!version && imposed.has(key) && i.installMissing !== false) {
      const problem = await installImposed(i, key);
      if (problem) imposedProblems.push(`Extension imposée ${key} indisponible : ${problem}.`); // FA-01
      version = installedVersions(i.configDir, catalog, name)[0];
    }
    if (!version) {
      // FA-01 of SPEC-EXT-003: in a run without interface, an extension activated but not installed is left out.
      if (!imposed.has(key)) report.push(`Extension ${key} activée mais non installée : installez-la avec « ${i.product.cli} extension add ${key} ».`);
      continue;
    }
    const blocked = blockedReason(i.settings, name, catalog);
    if (blocked) {
      report.push(`Extension ${key} non chargée : ${blocked}`); // EF-02 of SPEC-EXT-009
      continue;
    }
    const flag = flagOf(i.settings, i.configDir, name, catalog, version);
    if (flag?.severity === "critical") {
      report.push(`Extension ${key} désactivée : signalée critique par son catalogue : ${flag.reason}`); // SPEC-EXT-010 EF-01, EF-02
      continue;
    }
    if (flag) report.push(`Extension ${key} signalée par son catalogue : ${flag.reason}`);
    const root = installedDir(i.configDir, catalog, name, version);
    const ext = describeExtension(root, false);
    const problem = engineProblem(ext, i.product.version, i.product.name);
    if (problem) {
      report.push(`Extension ${key} non activée : ${problem}`); // ERR-02 of SPEC-EXT-008
      continue;
    }
    candidates.set(key, { root, version, manifest: ext.manifest });
  }
  // SPEC-EXT-007 FA-02: an extension whose dependency is not active is not active either.
  const { kept, warnings } = withDependencies(candidates);
  report.push(...warnings);
  const active = [...kept].sort().map((key) => ({ root: candidates.get(key)!.root, origin: "installed" as const, id: key }));
  return { active, report, imposedProblems };
}
