// Implements: SPEC-CFG-003 (§ 5.7 points 4, 6 and 7, CA-08, CA-09, authorised offline cache rejection), gaps E-127, E-128.
// Supports: SPEC-CFG-003 (CA-03, offline interface preferences and permission restrictions); sensitive adoption remains separate.
import { dirname, join } from "node:path";
import { parse, visit } from "jsonc-parser";
import type { PolicyAnchor } from "../identity/resolver";
import type { PolicyFileProtectionReader } from "../platform/policy-file";
import { fingerprint } from "../shared/fingerprint";
import { readPolicyEnrollment } from "./policy-enrollment";
import { readPolicySource } from "./protected-policy-source";
import { validateManagedPolicy, type PolicyCapability, type PolicyValidation } from "./managed-policy";
import { flattenSettings, type ConfigIssue } from "./settings";

export interface PolicyCacheSource {
  readonly name: string;
  readonly authorizationFile: string;
  read(capability?: PolicyCapability): PolicyValidation;
}

/** Both envelopes are flat strict JSON; settings remain a separately validated JSON/JSONC string. */
function strictObject(text: string): Record<string, unknown> {
  const data: unknown = JSON.parse(text);
  const keys = new Set<string>();
  let duplicate = false;
  visit(text, { onObjectProperty: (key) => { if (keys.has(key)) duplicate = true; keys.add(key); } });
  if (duplicate || typeof data !== "object" || data === null || Array.isArray(data)) throw new Error("objet JSON strict sans clé dupliquée attendu");
  return data as Record<string, unknown>;
}
const only = (data: Record<string, unknown>, keys: readonly string[]) => Object.keys(data).every((key) => keys.includes(key)) && keys.every((key) => Object.hasOwn(data, key));
function instant(value: unknown): number {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return NaN;
  const result = Date.parse(value);
  return Number.isFinite(result) && new Date(result).toISOString() === value ? result : NaN;
}

/** Protected administrative authority is separate from the replaceable user-owned transport; no remote service is invented. */
export function policyCacheSource(policyFile: string, configDir: string, distribution?: PolicyAnchor, protection?: PolicyFileProtectionReader, now: () => number = Date.now): PolicyCacheSource {
  const name = join(configDir, "remote-policy-cache.json");
  const authorizationFile = join(dirname(policyFile), "cache-authorization.json");
  return { name, authorizationFile, read(capability) {
    let perimeter: "remote" | undefined;
    const reject = (reason: string): PolicyValidation => ({ required: true, perimeter, settingsText: undefined, issues: [{ code: "ERR-04", severity: "error", kind: "policy", scope: "managed",
      message: `Copie en cache de politique invalide : ${name} — ${reason}. ${perimeter === "remote" ? "Sessions distantes bloquées." : "Périmètre inconnu ; fonctions d'agent bloquées."}` }] });
    const read = (): PolicyValidation => {
      const source = readPolicySource(authorizationFile, undefined, protection);
      if (source.issue) return reject(source.issue.message);
      if (source.text === undefined) return { required: false, issues: [], settingsText: undefined };
      if (source.protection?.writable !== false) return reject("autorisation hors ligne modifiable sans autorité administrateur");
      try {
        const authorization = strictObject(source.text);
        if (!only(authorization, ["schemaVersion", "organizationId", "perimeter", "cacheSha256", "offlineAllowed", "validFrom", "validUntil", "revoked"]) || authorization["schemaVersion"] !== 1 ||
          typeof authorization["organizationId"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(authorization["organizationId"]) ||
          !["all", "remote"].includes(authorization["perimeter"] as string) || typeof authorization["cacheSha256"] !== "string" || !/^[a-f0-9]{64}$/.test(authorization["cacheSha256"]) ||
          typeof authorization["offlineAllowed"] !== "boolean" || typeof authorization["revoked"] !== "boolean") return reject("autorisation indépendante de version 1 invalide");
        const from = instant(authorization["validFrom"]);
        const until = instant(authorization["validUntil"]);
        if (!Number.isFinite(from) || !Number.isFinite(until) || from >= until) return reject("période de validité UTC invalide");
        const enrollment = readPolicyEnrollment(policyFile, distribution, protection);
        if (enrollment.issues.length > 0) return reject(enrollment.issues.map((issue) => issue.message).join("\n"));
        const organization = enrollment.anchor?.organizationId ?? distribution?.organizationId;
        if (organization && organization !== authorization["organizationId"]) return reject("organisation différente de l'inscription ou de la distribution");
        perimeter = authorization["perimeter"] === "remote" ? "remote" : undefined;
        if (authorization["revoked"]) return reject("révocation connue par l'autorité ; copie immédiatement rejetée");
        if (!authorization["offlineAllowed"]) return reject("fonctionnement hors ligne non autorisé explicitement");
        const time = now();
        if (!Number.isFinite(time) || time < from || time >= until) return reject("copie expirée, pas encore valide ou heure invérifiable");
        const anchor = { organizationId: authorization["organizationId"], policySha256: authorization["cacheSha256"], perimeter };
        const cached = readPolicySource(name, anchor, () => ({ writable: false }));
        // User ownership is permitted only for the transport; independent authority pins every byte.
        if (cached.issue) return reject(cached.issue.message);
        const envelope = strictObject(cached.text!);
        if (!only(envelope, ["schemaVersion", "organizationId", "perimeter", "settings"]) || envelope["schemaVersion"] !== 1 ||
          envelope["organizationId"] !== authorization["organizationId"] || envelope["perimeter"] !== authorization["perimeter"] || typeof envelope["settings"] !== "string") return reject("organisation, périmètre ou document en cache non conformes à l'autorisation");
        const validated = validateManagedPolicy(envelope["settings"]);
        if (validated.issues.some((issue) => issue.severity === "error")) return reject(validated.issues.map((issue) => issue.message).join("\n"));
        const values = new Map<string, unknown>();
        const unknown: string[] = [];
        flattenSettings(parse(envelope["settings"]) as Record<string, unknown>, "", values, unknown);
        // Sensitive adoption needs a human dialog; this slice accepts only interface preferences and permission controls.
        if ([...values.keys(), ...unknown].some((key) => !["ui.", "permissions.", "policy."].some((prefix) => key.startsWith(prefix)))) return reject("contenu nécessitant une adoption supplémentaire ; dialogue de sécurité non disponible pour cette version du cache");
        const after = readPolicySource(authorizationFile, undefined, protection);
        if (after.issue || after.protection?.writable !== false || after.text !== source.text) return reject("autorité modifiée ou devenue invérifiable pendant la lecture du cache");
        const checkedAt = now();
        if (!Number.isFinite(checkedAt) || checkedAt < from || checkedAt >= until) return reject("validité hors ligne perdue pendant la lecture du cache");
        const warning: ConfigIssue = { code: "FA-01", severity: "warning", kind: "policy", scope: "managed", message: `Politique en cache autorisée hors ligne jusqu'au ${authorization["validUntil"]}. Une révocation inconnue n'est pas détectable hors ligne.` };
        return { ...validated, required: true, perimeter, digest: fingerprint(authorization), issues: [...validated.issues, warning] };
      } catch { return reject("document JSON strict d'autorisation ou de cache invalide, ou lecture invérifiable"); }
    };
    const policy = read();
    if (policy.perimeter !== "remote" || capability !== "local") return policy;
    return { ...policy, required: false, settingsText: policy.preferencesText, issues: policy.issues.map((issue) => ({ ...issue, severity: "warning", message: `${issue.message} Fonctions locales conservées.` })) };
  } };
}
