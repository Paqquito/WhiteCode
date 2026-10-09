// Implements: SPEC-CFG-003 (§ 5.7 independent protected enrolment, CA-05, CA-06), gap E-126.
import { dirname, join } from "node:path";
import { visit } from "jsonc-parser";
import type { PolicyAnchor } from "../identity/resolver";
import type { PolicyFileProtectionReader } from "../platform/policy-file";
import type { ConfigIssue } from "./settings";
import { readPolicySource } from "./protected-policy-source";
import { fingerprint } from "../shared/fingerprint";

export interface PolicyEnrollment {
  readonly name: string;
  readonly anchor?: PolicyAnchor;
  readonly digest?: string;
  readonly issues: readonly ConfigIssue[];
}

/** Administrative enrolment lives beside policy.json, independently of user configuration and account logout. */
export function readPolicyEnrollment(policyFile: string, distribution?: PolicyAnchor, protection?: PolicyFileProtectionReader): PolicyEnrollment {
  const name = join(dirname(policyFile), "enrollment.json");
  const reject = (reason: string): PolicyEnrollment => ({ name, issues: [{ code: "ERR-03", severity: "error", kind: "policy", scope: "managed", message: `Inscription d'organisation invalide : ${name} — ${reason}. Périmètre inconnu ; fonctions d'agent bloquées.` }] });
  const source = readPolicySource(name, undefined, protection);
  if (source.issue) return reject(source.issue.message);
  if (source.text === undefined) return { name, issues: [] };
  if (source.protection?.writable !== false) return reject("source modifiable sans autorité administrateur");
  try {
    const data: unknown = JSON.parse(source.text);
    const keys = new Set<string>();
    let depth = 0;
    let duplicate = false;
    visit(source.text, { onObjectBegin: () => { depth++; }, onObjectEnd: () => { depth--; }, onObjectProperty: (key) => { if (depth === 1) { if (keys.has(key)) duplicate = true; keys.add(key); } } });
    if (duplicate || typeof data !== "object" || data === null || Array.isArray(data)) return reject("objet JSON strict sans clé dupliquée attendu");
    const record = data as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["schemaVersion", "organizationId", "policySha256"].includes(key)) || record["schemaVersion"] !== 1 ||
      typeof record["organizationId"] !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(record["organizationId"]) ||
      typeof record["policySha256"] !== "string" || !/^[a-f0-9]{64}$/.test(record["policySha256"])) return reject("version 1, organisation et empreinte SHA-256 autorisée attendues, sans autre champ");
    const anchor: PolicyAnchor = Object.freeze({ organizationId: record["organizationId"], policySha256: record["policySha256"] });
    if (distribution && (distribution.organizationId !== anchor.organizationId || distribution.policySha256 !== anchor.policySha256 || distribution.perimeter !== undefined)) return reject("conflit avec l'ancrage de distribution ; aucune autorité ne peut être remplacée");
    return { name, anchor, digest: fingerprint(anchor), issues: [] };
  } catch { return reject("document JSON strict invalide"); }
}
