// Implements: SPEC-EXT-003 (§ 5.1 priority, § 5.3, FA-01, EF-01, EF-03, CA-01), SPEC-EXT-008 (EF-02, ERR-02 at activation)
// The installed extensions active for a session: `extensions.enabled`, merged from the weakest scope to the strongest
// (user < project < local < managed), resolved to the highest installed version compatible with the product.

import type { Settings } from "../config/settings";
import { describeExtension } from "./extension";
import type { ActiveExtension } from "./load";
import { engineProblem, installedDir, installedVersions } from "./store";

/** `<name>@<catalogue>`. */
export function parseRef(ref: string): { name: string; catalog?: string } {
  const at = ref.lastIndexOf("@");
  return at > 0 ? { name: ref.slice(0, at), catalog: ref.slice(at + 1) } : { name: ref };
}

export interface Activations {
  readonly active: readonly ActiveExtension[];
  readonly report: readonly string[];
}

/** § 5.3 for a session: activated and installed extensions; those activated but not installed are reported (FA-01). */
export function activeInstalled(settings: Settings, configDir: string, product: { readonly name: string; readonly version: string; readonly cli: string }): Activations {
  const enabled = settings.get<Record<string, unknown>>("extensions.enabled");
  const active: ActiveExtension[] = [];
  const report: string[] = [];
  for (const [key, value] of Object.entries(enabled).sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (value !== true) continue;
    const { name, catalog } = parseRef(key);
    if (!catalog) {
      report.push(`extensions.enabled : ${key} ignorée : forme attendue <nom>@<catalogue>.`);
      continue;
    }
    const version = installedVersions(configDir, catalog, name)[0];
    if (!version) {
      // FA-01: in a run without interface, an extension activated but not installed is left out, with a warning.
      report.push(`Extension ${key} activée mais non installée : installez-la avec « ${product.cli} extension add ${key} ».`);
      continue;
    }
    const root = installedDir(configDir, catalog, name, version);
    const problem = engineProblem(describeExtension(root, false), product.version, product.name);
    if (problem) {
      report.push(`Extension ${key} non activée : ${problem}`); // ERR-02 of SPEC-EXT-008
      continue;
    }
    active.push({ root, origin: "installed", id: key });
  }
  return { active, report };
}
