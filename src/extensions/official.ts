// Implements: SPEC-EXT-005 (CA-01/02, identity registration and administrator exclusion).
// Supports: gap E-167 (the source uses the existing catalogue transports).
import type { Identity } from "../identity/identity";
import type { Settings } from "../config/settings";
import type { CatalogRegistration } from "./catalog";
import { catalogRefused } from "./admin";
export const officialName = (identity: Identity): string => identity.get("PRODUCT_SLUG") + "-official";
export function officialCatalog(identity: Identity): { name: string; source: string } | undefined {
  return identity.has("SERVICE_MARKETPLACE") ? { name: officialName(identity), source: identity.get("SERVICE_MARKETPLACE") } : undefined;
}
/** The reserved registration cannot be replaced by a lower-trust settings file, and is never written to disk. */
export function officialSettings(settings: Settings, identity: Identity): Settings {
  const official = officialCatalog(identity); if (!official) return settings;
  return new Proxy(settings, { get(target, key) {
    if (key === "get") return (name: string) => {
      if (name !== "extensions.catalogs") return target.get(name);
      const registrations = { ...target.get<Record<string, CatalogRegistration>>(name) }; delete registrations[official.name];
      if (!catalogRefused(target, official.name, official.source)) registrations[official.name] = { source: official.source, requireOrigin: true };
      return registrations;
    };
    const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
