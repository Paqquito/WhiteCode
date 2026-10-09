// Implements: SPEC-CFG-001 (CA-06), SPEC-CFG-003 (§ 5.7 points 2, 3, 5, 10, 11, CA-07, CA-13, CA-14, CA-16), SPEC-HOK-002 (CA-06)
// Supports: SPEC-MOD-010 (CA-07, CA-09), SPEC-PER-001 (CA-30), SPEC-CFG-003 (FA-02, protected file and native system channels), gaps E-120 to E-125. Dynamic version adoption remains separate.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import type { PolicyAnchor } from "../identity/resolver";
import { parse, visit, type ParseError } from "jsonc-parser";
import { buildSnapshot, fingerprintOf } from "../hooks/config";
import { HOOK_EVENTS } from "../hooks/events";
import { isRule, parseRule, type RuleDecision } from "../permissions/rules";
import { fingerprint } from "../shared/fingerprint";
import { flattenSettings, validateSettingValue, type ConfigIssue } from "./settings";
import { SETTING_BY_KEY } from "./settings-schema";
import { parseDuration } from "./units";
import type { ManagedSystemPolicy } from "./managed-system-policy";
import { inspectPolicyFileProtection, type PolicyFileProtection, type PolicyFileProtectionReader } from "../platform/policy-file";

const RULES: Readonly<Record<string, RuleDecision>> = {
  "permissions.allowRules": "allow", "permissions.askRules": "ask", "permissions.denyRules": "deny",
};
const REQUIRED = [...Object.keys(RULES), "permissions.managedRulesOnly", "permissions.disableUnrestrictedMode", "permissions.disableAutoApproveMode"];
export type PolicyCapability = "local" | "remote";
const object = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export interface PolicyValidation {
  readonly required: boolean;
  readonly issues: readonly ConfigIssue[];
  readonly digest?: string;
  /** On a rejected version, only independently validated preferences may be loaded for local diagnosis. */
  readonly settingsText: string | undefined;
  /** Authorised preferences outside the mandatory perimeter, without its controls. */
  readonly preferencesText?: string;
}

const outsidePerimeter = (anchor: PolicyAnchor | undefined, capability: PolicyCapability | undefined) => anchor?.perimeter === "remote" && capability === "local";

/** The file carries policy bytes; the distribution, not this file, supplies the authority. */
function readPolicySource(file: string, anchor?: PolicyAnchor, protection: PolicyFileProtectionReader = inspectPolicyFileProtection): { text?: string; issue?: ConfigIssue; protection?: PolicyFileProtection } {
  const rejected = (reason: string): ConfigIssue => ({ code: "ERR-03", severity: "error", kind: "policy", scope: "managed",
    message: `${anchor ? `Politique obligatoire de l'organisation ${anchor.organizationId}` : `Source de politique gérée ${file}`} : ${reason}. ${anchor?.perimeter === "remote" ? "Périmètre distant ; sessions distantes bloquées." : "Périmètre inconnu ; fonctions d'agent bloquées."}` });
  let fd: number | undefined;
  let detected = false;
  try {
    const first = lstatSync(file);
    detected = true;
    if (!first.isFile() || first.isSymbolicLink()) return { issue: rejected("fichier ordinaire sans lien symbolique attendu") };
    const before = protection(file);
    if (before.error !== undefined || typeof before.writable !== "boolean") return { issue: rejected(`protection invérifiable (${before.error ?? "unavailable"})`) };
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd);
    const stamp = (stat: typeof first) => `${stat.dev}:${stat.ino}:${stat.mode}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (!opened.isFile() || opened.size > 1024 * 1024 || stamp(first) !== stamp(opened)) return { issue: rejected("source non ordinaire, trop volumineuse ou remplacée pendant la lecture") };
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (count === 0) break;
      length += count;
    }
    if (length > 1024 * 1024) return { issue: rejected("source trop volumineuse") };
    const bytes = buffer.subarray(0, length);
    const after = protection(file);
    if (after.error !== undefined || typeof after.writable !== "boolean" || stamp(opened) !== stamp(fstatSync(fd)) || stamp(opened) !== stamp(lstatSync(file))) return { issue: rejected("source ou protection modifiée pendant la lecture") };
    if (anchor && createHash("sha256").update(bytes).digest("hex") !== anchor.policySha256) return { issue: rejected("empreinte non autorisée par la distribution") };
    return { text: bytes.toString("utf8"), protection: { writable: before.writable || after.writable } };
  } catch (error) {
    if (!anchor && !detected && (error as NodeJS.ErrnoException).code === "ENOENT") return {};
    return { issue: rejected("source absente ou illisible") };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export function readManagedPolicy(file: string, anchor?: PolicyAnchor, capability?: PolicyCapability, protection?: PolicyFileProtectionReader): PolicyValidation {
  const source = readPolicySource(file, anchor, protection);
  let policy: PolicyValidation = source.issue ? { required: true, issues: [source.issue], settingsText: undefined } : validateManagedPolicy(source.text);
  if (source.protection?.writable) {
    const required = policy.required || anchor !== undefined;
    const issue: ConfigIssue = { code: "ERR-03", severity: required ? "error" : "warning", kind: "policy", scope: "managed", message: `Fichier géré modifiable sans autorité administrateur : ${file}.${required ? " Politique obligatoire invalide ; capacités encadrées bloquées." : " Faites protéger le fichier et ses parents par votre administrateur."}` };
    policy = { ...policy, required, settingsText: required ? undefined : policy.settingsText, preferencesText: required ? undefined : policy.preferencesText, issues: [...policy.issues, issue] };
  }
  if (!outsidePerimeter(anchor, capability)) return policy;
  return { required: false, issues: policy.issues.map((issue) => ({ ...issue, severity: "warning", message: `${issue.message} Sessions distantes indisponibles ; fonctions locales conservées.` })), settingsText: policy.preferencesText };
}

/** No action is run here. Incomplete JSON cannot establish that the source contains preferences only. */
export function validateManagedPolicy(text: string | undefined): PolicyValidation {
  if (text === undefined) return { required: false, issues: [], settingsText: undefined };
  const issues: ConfigIssue[] = [];
  const reject = (key: string, reason: string) => issues.push({ code: "ERR-03", severity: "error", kind: "policy", scope: "managed", key, message: `Politique obligatoire invalide : ${key} — ${reason}.` });
  const errors: ParseError[] = [];
  const data: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0 || !object(data)) {
    reject("policy", "JSON invalide ou objet attendu");
    return { required: true, issues, settingsText: undefined };
  }
  const stack: Set<string>[] = [];
  let duplicate = false;
  visit(text, {
    onObjectBegin: () => { stack.push(new Set()); },
    onObjectProperty: (property) => { const keys = stack.at(-1)!; if (keys.has(property) || property === "__proto__") duplicate = true; keys.add(property); },
    onObjectEnd: () => { stack.pop(); },
  }, { allowTrailingComma: true });
  const values = new Map<string, unknown>();
  const duplicates: string[] = [];
  flattenSettings(data, "", values, [], duplicates);
  const required = new Set(REQUIRED.filter((key) => values.has(key)));
  if (duplicate || duplicates.length > 0) reject("policy", "déclarations en double ambiguës");
  // An invalid container could hide restrictions that the ordinary per-key loader would discard.
  for (const prefix of ["permissions", "policy"]) if (prefix in data && !object(data[prefix])) reject(prefix, "objet attendu");
  if (values.has("policy.requiredKeys")) {
    required.add("policy.requiredKeys");
    const keys = values.get("policy.requiredKeys");
    if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string")) reject("policy.requiredKeys", "liste de clés attendue");
    else for (const key of keys as string[]) {
      required.add(key);
      if (!SETTING_BY_KEY.get(key)?.scopes.includes("managed")) reject("policy.requiredKeys", "clé inconnue ou non admise en portée gérée");
      else if (!values.has(key)) reject(key, "valeur obligatoire absente");
    }
  }
  for (const key of required) {
    if (!values.has(key)) continue;
    const value = values.get(key);
    const reason = validateSettingValue(key, value);
    if (reason) { reject(key, reason); continue; }
    const decision = RULES[key];
    if (decision && (value as string[]).some((rule) => !isRule(parseRule(rule, decision, "managed", ".")))) reject(key, "règle malformée ou outil inconnu");
  }
  const mandatoryHooks: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
  const rawHooks = values.get("hooks");
  const allHooksRequired = required.has("hooks");
  if (allHooksRequired && !object(rawHooks)) reject("hooks", "objet attendu");
  if (object(rawHooks)) {
    const ids = new Map<string, string>();
    const conflictingIds = new Set<string>();
    for (const [event, list] of Object.entries(rawHooks)) {
      if (!Array.isArray(list)) continue;
      for (const declaration of list) if (object(declaration) && typeof declaration["id"] === "string") {
        const id = declaration["id"];
        const digest = fingerprintOf(event, declaration);
        if (ids.has(id) && ids.get(id) !== digest) conflictingIds.add(id);
        ids.set(id, digest);
      }
    }
    for (const [event, list] of Object.entries(rawHooks)) {
      if (!Array.isArray(list)) {
        if (allHooksRequired || (object(list) && list["mandatory"] !== undefined)) reject("hooks", "liste de déclarations attendue");
        continue;
      }
      for (const declaration of list) {
        if (!object(declaration)) { if (allHooksRequired) reject("hooks", "déclaration invalide"); continue; }
        if (declaration["mandatory"] !== undefined && typeof declaration["mandatory"] !== "boolean") { reject("hooks", "mandatory doit être un booléen"); continue; }
        if (!allHooksRequired && declaration["mandatory"] !== true) continue;
        (mandatoryHooks[event] ??= []).push(declaration);
        if (Object.keys(declaration).some((key) => !["id", "mandatory", "match", "actions", "timeout", "async"].includes(key))) reject("hooks", "champ de déclaration inconnu");
        if (declaration["mandatory"] === true && HOOK_EVENTS[event]?.synchronous === false) reject("hooks", "événement non bloquant pour un contrôle obligatoire");
        const id = declaration["id"];
        if (declaration["mandatory"] === true && (typeof id !== "string" || id.trim() === "")) reject("hooks", "identifiant obligatoire absent");
        if (id !== undefined && typeof id !== "string") reject("hooks", "identifiant invalide");
        if (typeof id === "string") {
          if (conflictingIds.has(id)) reject("hooks", "identifiant dupliqué avec des déclarations différentes");
        }
        if (declaration["match"] !== undefined && typeof declaration["match"] !== "string") reject("hooks", "filtre non textuel");
        if (declaration["async"] !== undefined && declaration["async"] !== false) reject("hooks", "un contrôle obligatoire doit être synchrone");
        if (declaration["timeout"] !== undefined && parseDuration(declaration["timeout"]) === undefined) reject("hooks", "délai invalide");
        const actions = declaration["actions"];
        if (!Array.isArray(actions) || actions.some((a) => !object(a))) reject("hooks", "liste d'actions attendue");
        else for (const action of actions as Record<string, unknown>[]) {
          const fields = action["type"] === "http" ? ["type", "url", "headers", "timeout"] : ["type", "command", "shell", "timeout"];
          if (Object.keys(action).some((key) => !fields.includes(key))) reject("hooks", "champ d'action inconnu");
          if (action["shell"] !== undefined && typeof action["shell"] !== "string") reject("hooks", "shell non textuel");
          if (action["type"] === "http" && typeof action["url"] !== "string") reject("hooks", "URL non textuelle");
        }
      }
    }
  }
  if (Object.keys(mandatoryHooks).length > 0) {
    const snapshot = buildSnapshot([{ origin: "managed", value: mandatoryHooks }], { managedOnly: false, noHooks: false, maxTimeoutMs: 600_000 });
    if (snapshot.ignored.length > 0 || snapshot.warnings.length > 0) reject("hooks", "filtre, événement ou action invalide");
  }
  const isRequired = required.size > 0 || Object.keys(mandatoryHooks).length > 0 || issues.length > 0;
  const projection = [...required].sort().map((key) => [key, values.get(key)]);
  const preferences = [...values].filter(([key]) => !required.has(key) && key !== "hooks");
  let optionalHooks: unknown = rawHooks;
  if (allHooksRequired) optionalHooks = undefined;
  else if (object(rawHooks)) optionalHooks = Object.fromEntries(Object.entries(rawHooks).map(([event, list]) => [event,
    Array.isArray(list) ? list.filter((declaration) => !object(declaration) || declaration["mandatory"] !== true) : list,
  ]));
  return {
    required: isRequired, issues,
    digest: isRequired ? fingerprint({ projection, mandatoryHooks }) : undefined,
    settingsText: issues.length > 0 ? JSON.stringify(Object.fromEntries(preferences)) : text,
    preferencesText: JSON.stringify({ ...Object.fromEntries(preferences), ...(issues.length === 0 && optionalHooks !== undefined ? { hooks: optionalHooks } : {}) }),
  };
}

/** Fresh raw source checks avoid the ordinary configuration reloader's fallback to the previous valid JSON. */
export class ManagedPolicyGuard {
  readonly #file: string;
  readonly #anchor?: PolicyAnchor;
  readonly #protection?: PolicyFileProtectionReader;
  #observedDigest?: string;
  #changed = false;
  readonly #systemPolicy?: ManagedSystemPolicy;
  readonly #systemPolicyDigest?: string;
  #systemPolicyChanged = false;
  constructor(file: string, anchor?: PolicyAnchor, systemPolicy?: ManagedSystemPolicy, protection?: PolicyFileProtectionReader) {
    this.#systemPolicy = systemPolicy;
    this.#systemPolicyDigest = systemPolicy?.read().digest;
    this.#file = file;
    this.#anchor = anchor ? Object.freeze({ ...anchor }) : undefined;
    this.#protection = protection;
    const policy = readManagedPolicy(file, this.#anchor, undefined, protection);
    if (!policy.issues.some((issue) => issue.severity === "error")) this.#observedDigest = policy.digest;
  }
  check(capability?: PolicyCapability): readonly ConfigIssue[] {
    const issues = this.#check();
    const systemPolicy = this.#systemPolicy?.read();
    if (systemPolicy?.digest !== this.#systemPolicyDigest) this.#systemPolicyChanged = true;
    const systemIssues = systemPolicy?.issues.filter((issue) => issue.severity === "error") ?? [];
    if (this.#systemPolicyChanged && systemIssues.length === 0) systemIssues.push({ code: "ERR-03", severity: "error", kind: "policy", scope: "managed", message: `La politique obligatoire ${this.#systemPolicy?.kind === "registry" ? "du registre" : "du profil macOS"} a changé ou disparu ; session suspendue. Faites vérifier la source par votre administrateur, puis redémarrez.` });
    return [...(outsidePerimeter(this.#anchor, capability) ? [] : issues), ...systemIssues];
  }
  #check(): readonly ConfigIssue[] {
    const policy = readManagedPolicy(this.#file, this.#anchor, undefined, this.#protection);
    const errors = policy.issues.filter((issue) => issue.severity === "error");
    if (errors.length > 0) return errors;
    if (this.#observedDigest !== undefined && this.#observedDigest !== policy.digest) this.#changed = true;
    // Newly introduced restrictions also require restarting before they are adopted by the composed session.
    if (this.#observedDigest === undefined && policy.required) this.#changed = true;
    if (this.#changed) return [{ code: "ERR-03", severity: "error", kind: "policy", scope: "managed", message: "La politique obligatoire a changé ou disparu ; session suspendue. Faites vérifier la source par votre administrateur, puis redémarrez." }];
    return [];
  }
}
