// Implements: SPEC-PER-021 (EF-01, EF-02, FA-01), SPEC-CFG-003 (CA-03, CA-10), gap E-129.
// Consent records contain only qualified fingerprints, never command text, environment values or credentials.
import { fingerprint } from "../shared/fingerprint";
import { policyPrincipal } from "../platform/policy-principal";
import { SETTING_BY_KEY } from "./settings-schema";
import { flattenSettings, validateSettingValue } from "./settings";
import { parse } from "jsonc-parser";
import type { PolicyCacheSource } from "./policy-cache";

export interface PolicyConsentProposal {
  readonly organizationId: string;
  readonly perimeter: "all" | "remote";
  readonly authorityDigest: string;
  readonly fingerprints: Readonly<Record<string, string>>;
  readonly changes: readonly { readonly key: string; readonly value?: unknown; readonly removed?: true }[];
}

/** Native principal, independent of model-controlled environment and configuration paths. */
export function policyConsentPrincipal(): string {
  return fingerprint(policyPrincipal()).slice(7);
}

export function policyConsentFileName(principal: string, organizationId: string, perimeter: string): string {
  return `cache-consent.${fingerprint([principal, organizationId, perimeter]).slice(7)}.json`;
}

const EXECUTION_CONTROLS = new Set(["hooks", "hooksConfig.disabled", "hooksConfig.managedOnly", "hooksConfig.http.allowedUrls", "hooksConfig.http.allowedEnvVars",
  "extensions.enabled", "extensions.options", "extensions.catalogs", "extensions.managedOnly", "extensions.blocked", "extensions.blockedCatalogs", "extensions.strictCatalogs", "extensions.allowFlagged", "extensions.allowPrerelease",
  "mcp.allowList", "mcp.denyList", "mcp.managedServersOnly", "permissions.decisionHooks", "permissions.trustedDirectories", "permissions.initialMode",
  "api.provider", "api.baseUrl"]);

export function policyConsentProposal(settings: string, organizationId: string, perimeter: "all" | "remote", authorityDigest: string, approved?: Readonly<Record<string, string>>): PolicyConsentProposal | undefined {
  const values = new Map<string, unknown>();
  flattenSettings(parse(settings) as Record<string, unknown>, "", values, []);
  const isSensitive = (key: string) => {
    const def = SETTING_BY_KEY.get(key);
    return def?.scopes.includes("managed") && (def.widening === true || EXECUTION_CONTROLS.has(key));
  };
  const sensitive = [...values].filter(([key, value]) => isSensitive(key) && validateSettingValue(key, value) === undefined);
  const fingerprints = Object.fromEntries(sensitive.map(([key, value]) => [key, fingerprint({ present: true, value })]));
  const changes: PolicyConsentProposal["changes"][number][] = sensitive.filter(([key]) => !approved || !Object.hasOwn(approved, key) || approved[key] !== fingerprints[key]).map(([key, value]) => ({ key, value }));
  // Removal can enable lower-scope/default execution controls; it is a change, too.
  for (const key of Object.keys(approved ?? {})) if (isSensitive(key) && !Object.hasOwn(fingerprints, key)) {
    fingerprints[key] = fingerprint({ present: false });
    if (approved![key] !== fingerprints[key]) changes.push({ key, removed: true });
  }
  return changes.length === 0 ? undefined : { organizationId, perimeter, authorityDigest, fingerprints, changes };
}

/** Recheck the exact proposal after the human answer; an intervening change never inherits it. */
export function acceptPolicyConsent(source: PolicyCacheSource, proposal: PolicyConsentProposal): void {
  source.accept(proposal);
}

export function policyConsentText(proposal: PolicyConsentProposal): string {
  return ["Paramètres sensibles de votre organisation", `Organisation : ${proposal.organizationId}`, `Périmètre : ${proposal.perimeter === "remote" ? "sessions distantes" : "toutes les capacités d'agent"}`,
    "Les ajouts ou modifications suivants peuvent exécuter du code ou modifier l'environnement. Leur contenu doit être accepté avant application :",
    "Une clé supprimée (removed: true) laisse reprendre les valeurs des autres portées ou les valeurs par défaut.",
    JSON.stringify(proposal.changes, null, 2)].join("\n");
}
