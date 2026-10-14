// Implements: SPEC-EXT-009 (§ 5.1 blocking, EF-02, ERR-01), SPEC-EXT-010 (§ 5.1, § 5.3, FA-01, EF-01 to EF-03, ERR-01)
// What the organisation and the catalogues forbid: blocked extensions and catalogues, extensions flagged by their catalogue.

import type { Settings } from "../config/settings";
import { satisfies } from "../platform/semver";
import { cachedCatalog, type CatalogRegistration } from "./catalog";

/** ERR-01 of SPEC-EXT-009: blocked by name, by `<name>@<catalogue>` or through its catalogue (EF-02: installed ones too). */
export function blockedReason(settings: Settings, name: string, catalog: string): string | undefined {
  const blocked = settings.get<string[]>("extensions.blocked");
  if (blocked.includes(name) || blocked.includes(`${name}@${catalog}`)) return "Extension bloquée par votre organisation.";
  if (settings.get<string[]>("extensions.blockedCatalogs").includes(catalog)) return "Catalogue non autorisé par votre organisation.";
  return undefined;
}

export interface Flag {
  readonly severity: "critical" | "warning";
  readonly reason: string;
}

/**
 * The flag of `name@catalog` in `version`, read in the cached list of its own catalogue (EF-03, ERR-01: the last list
 * known). A critical flag allowed by the organisation (`extensions.allowFlagged`) is lowered to a warning (FA-01).
 */
export function flagOf(settings: Settings, configDir: string, name: string, catalog: string, version: string): Flag | undefined {
  const flag = cachedCatalog(configDir, catalog, settings.get<Record<string, CatalogRegistration>>("extensions.catalogs")[catalog])?.flagged.find((f) => f.name === name && (f.versions === undefined || satisfies(version, f.versions)));
  if (!flag) return undefined;
  const allowed = settings.get<string[]>("extensions.allowFlagged");
  if (flag.severity === "critical" && (allowed.includes(name) || allowed.includes(`${name}@${catalog}`))) return { severity: "warning", reason: flag.reason };
  return { severity: flag.severity, reason: flag.reason };
}
