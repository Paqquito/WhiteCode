// Implements: SPEC-CAD-002 (EF-01 to EF-15, RG-04, RG-05, ERR-02 to ERR-09, ERR-14, ERR-17, Q-05)
// Validates an identity file and computes the resolved identity (derivations, transforms, cycles).

import { createHash } from "node:crypto";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { MODEL_TIERS, VARIABLES, VARIABLE_BY_NAME, type ModelTier, type Section, type VariableDef } from "./catalog";
import { PROTECTED_COMMANDS } from "./protected-commands";
import { applyTransform, isTransform, parseTemplate } from "./template";
import { suggest } from "../shared/suggest";

export const SUPPORTED_SCHEMA_VERSIONS = [1] as const;

export type Localized = Readonly<Record<string, string>>;
export type IdentityValue = string | Localized;

export interface IdentityIssue {
  readonly code: string; // ERR-nn of SPEC-CAD-002
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly path?: string;
}

export interface ModelTierValue {
  readonly label: IdentityValue;
  readonly ids: Readonly<Record<string, string>>;
}

export interface ResolvedIdentity {
  readonly schemaVersion: number;
  readonly version: string;
  readonly defaultLanguage: string;
  readonly languages: readonly string[];
  readonly values: Readonly<Record<string, { readonly value: IdentityValue; readonly origin: "provided" | "derived" }>>;
  readonly models: Readonly<Partial<Record<ModelTier, ModelTierValue>>>;
  readonly modelDefault: ModelTier;
  readonly modelBackground: ModelTier;
  readonly compatibility: {
    readonly forbiddenTerms: readonly string[];
    readonly allowLegacyReads: boolean;
  };
  /** SHA-256 of the canonical form of everything above (EF-15, ENF-04). */
  readonly hash: string;
}

export interface ResolveResult {
  readonly identity?: ResolvedIdentity;
  readonly issues: readonly IdentityIssue[];
}

export interface ResolveOptions {
  readonly version: string;
  /** Strict mode turns warnings into errors (§ 6.1). */
  readonly strict?: boolean;
  /** Extra protected command names (Q-05, extensible by the distribution). */
  readonly extraProtectedCommands?: readonly string[];
}

const SECTIONS: readonly Section[] = ["identity", "locations", "identifiers", "profiles", "models", "services", "git", "visual", "texts"];
const TOP_LEVEL_KEYS = new Set(["$schema", "schemaVersion", "defaultLanguage", ...SECTIONS, "compatibility"]);
const SECRET_MARKERS = ["apikey", "secret", "token", "password", "passwd", "privatekey", "credential"];
/** RG-05: prefixes of public API providers and common system prefixes. */
const RESERVED_ENV_PREFIXES = ["ANTHROPIC_", "OPENAI_", "AWS_", "GOOGLE_", "AZURE_", "OTEL_", "XDG_", "LC_", "NODE_", "BUN_", "NPM_", "GIT_", "SSH_", "HTTP_", "HTTPS_", "NO_", "PATH_", "SYSTEM_", "WINDOWS_", "PS_"];

function lineCol(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else column++;
  }
  return { line, column };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function findSecretKeys(value: unknown, path: string, out: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => findSecretKeys(v, `${path}[${i}]`, out));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [k, v] of Object.entries(value)) {
    const normalized = k.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (SECRET_MARKERS.some((m) => normalized.includes(m))) out.push(`${path}.${k}`);
    findSecretKeys(v, `${path}.${k}`, out);
  }
}

/** Parses the text of an identity file, then validates and resolves it. */
export function resolveIdentityText(text: string, options: ResolveOptions): ResolveResult {
  const errors: ParseError[] = [];
  const data = parseJsonc(text, errors, { disallowComments: true, allowTrailingComma: false });
  if (errors.length > 0) {
    const first = errors[0]!;
    const { line, column } = lineCol(text, first.offset);
    return { issues: [{ code: "ERR-02", severity: "error", message: `Syntaxe invalide à la ligne ${line}, colonne ${column}.` }] };
  }
  return resolveIdentity(data, options);
}

export function resolveIdentity(data: unknown, options: ResolveOptions): ResolveResult {
  const issues: IdentityIssue[] = [];
  const error = (code: string, message: string, path?: string) => issues.push({ code, severity: "error", message, path });
  const warn = (code: string, message: string, path?: string) =>
    issues.push({ code, severity: options.strict ? "error" : "warning", message, path });

  if (!isPlainObject(data)) {
    error("ERR-02", "Le fichier d'identité doit contenir un objet JSON.");
    return { issues };
  }

  // ERR-17: no secret in the identity file.
  const secretKeys: string[] = [];
  findSecretKeys(data, "$", secretKeys);
  if (secretKeys.length > 0) {
    for (const k of secretKeys) error("ERR-17", `Le fichier d'identité ne doit contenir aucun secret : retirez \`${k.replace(/^\$\./, "")}\`.`, k);
    return { issues };
  }

  // EF-02 / ERR-03: schema version.
  const schemaVersion = data["schemaVersion"];
  if (typeof schemaVersion !== "number" || !(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)) {
    error("ERR-03", `Version de schéma ${String(schemaVersion)} non prise en charge (attendu : ${SUPPORTED_SCHEMA_VERSIONS.join(", ")}).`, "$.schemaVersion");
    return { issues };
  }
  const defaultLanguage = typeof data["defaultLanguage"] === "string" ? data["defaultLanguage"] : "";
  if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(defaultLanguage)) {
    error("ERR-05", "`defaultLanguage` doit être un code de langue BCP 47.", "$.defaultLanguage");
  }

  for (const key of Object.keys(data)) {
    if (!TOP_LEVEL_KEYS.has(key)) warn("ERR-06", `Section inconnue \`${key}\`.`, `$.${key}`);
  }

  // Collect provided values, checking that each variable sits in its own section.
  const provided = new Map<string, unknown>();
  for (const section of SECTIONS) {
    const content = data[section];
    if (content === undefined) continue;
    if (!isPlainObject(content)) {
      error("ERR-05", `La section \`${section}\` doit être un objet.`, `$.${section}`);
      continue;
    }
    for (const [name, value] of Object.entries(content)) {
      const def = VARIABLE_BY_NAME.get(name);
      if (!def) {
        const near = suggest(name, VARIABLE_BY_NAME.keys());
        warn("ERR-06", `Variable inconnue \`{{${name}}}\`${near[0] ? ` — vouliez-vous dire \`{{${near[0]}}}\` ?` : "."}`, `$.${section}.${name}`);
        continue;
      }
      if (def.section !== section) {
        error("ERR-05", `\`${name}\` doit être déclarée dans la section \`${def.section}\`.`, `$.${section}.${name}`);
        continue;
      }
      provided.set(name, value);
    }
  }

  // Shape checks of provided values.
  for (const [name, value] of provided) {
    const def = VARIABLE_BY_NAME.get(name)!;
    const path = `$.${def.section}.${name}`;
    if (def.type === "modelTier") {
      // Gap E-040 (decision D-10): `ids` is optional; a tier may be a neutral label mapped by `models.identifierMap`.
      if (!isPlainObject(value) || !isLocalizedOrString(value["label"]) || (value["ids"] !== undefined && !isPlainObject(value["ids"]))) {
        error("ERR-05", `\`${name}\` doit être un objet { label, ids? }.`, path);
        continue;
      }
      const label = value["label"];
      const labelText = typeof label === "string" ? label : Object.values(label as Localized)[0] ?? "";
      if (labelText.length < 1 || labelText.length > 32) error("ERR-05", `\`${name}.label\` doit compter de 1 à 32 caractères.`, `${path}.label`);
      const ids = Object.entries((value["ids"] as Record<string, unknown> | undefined) ?? {});
      if (ids.some(([, v]) => typeof v !== "string" || v.length === 0)) {
        error("ERR-05", `\`${name}.ids\` : chaque identifiant doit être une chaîne non vide.`, `${path}.ids`);
      }
    } else if (def.type === "tierRef") {
      if (typeof value !== "string" || !(MODEL_TIERS as readonly string[]).includes(value)) {
        error("ERR-05", `\`${name}\` doit référencer une gamme (${MODEL_TIERS.join(", ")}).`, path);
      }
    } else if (def.localizable ? !isLocalizedOrString(value) : typeof value !== "string") {
      error("ERR-05", `\`${name}\` doit être ${def.localizable ? "une chaîne ou une table par langue" : "une chaîne"}.`, path);
    }
  }

  // ERR-04: missing primary variables, listed together; at least one model tier.
  const missing = VARIABLES.filter((v) => v.kind === "primary" && !provided.has(v.name)).map((v) => v.name);
  if (!MODEL_TIERS.some((t) => provided.has(t))) missing.push("MODEL_LARGE | MODEL_MEDIUM | MODEL_SMALL");
  if (missing.length > 0) error("ERR-04", `Valeurs obligatoires manquantes : ${missing.join(", ")}.`);

  if (issues.some((i) => i.severity === "error")) return { issues };

  // Languages known to this identity.
  const languages = new Set<string>([defaultLanguage]);
  for (const v of provided.values()) collectLanguages(v, languages);
  for (const def of VARIABLES) if (def.derive && typeof def.derive !== "string") for (const l of Object.keys(def.derive)) languages.add(l);

  // Resolution with memoization per language and cycle detection.
  const memo = new Map<string, string | null>();
  const reportedFallback = new Set<string>();
  const stack: string[] = [];
  let cycleReported = false;

  const pickLanguage = (name: string, raw: unknown, lang: string): string | undefined => {
    if (typeof raw === "string") return raw;
    if (!isPlainObject(raw)) return undefined;
    const table = raw as Record<string, string>;
    if (table[lang] !== undefined) return table[lang];
    if (lang !== defaultLanguage && !reportedFallback.has(`${name}:${lang}`) && provided.has(name)) {
      reportedFallback.add(`${name}:${lang}`);
      warn("ERR-09", `Pas de valeur en \`${lang}\` pour \`${name}\`, utilisation de \`${defaultLanguage}\`.`);
    }
    return table[defaultLanguage] ?? Object.values(table)[0];
  };

  const rawTemplate = (def: VariableDef, lang: string): string | undefined => {
    if (provided.has(def.name)) return pickLanguage(def.name, provided.get(def.name), lang);
    if (def.name === "PRODUCT_BUNDLE_ID") {
      const domain = String(provided.get("SOCIETY_DOMAIN") ?? "").toLowerCase();
      return `${domain.split(".").reverse().join(".")}.{{PRODUCT_SLUG}}`;
    }
    if (def.derive === undefined) return undefined;
    return typeof def.derive === "string" ? def.derive : def.derive[lang] ?? def.derive[defaultLanguage] ?? def.derive["en"];
  };

  const resolve = (name: string, lang: string): string | undefined => {
    const key = `${name}@${lang}`;
    if (memo.has(key)) return memo.get(key) ?? undefined;
    const def = VARIABLE_BY_NAME.get(name);
    if (!def || def.type === "modelTier" || def.type === "tierRef") return undefined;
    if (stack.includes(name)) {
      if (!cycleReported) {
        cycleReported = true;
        const cycle = [...stack.slice(stack.indexOf(name)), name];
        error("ERR-08", `Cycle détecté : ${cycle.join(" → ")}.`);
      }
      return undefined;
    }
    const template = rawTemplate(def, def.localizable ? lang : defaultLanguage);
    if (template === undefined) {
      memo.set(key, null);
      return undefined;
    }
    stack.push(name);
    let out = "";
    for (const part of parseTemplate(template)) {
      if (part.kind === "literal") {
        out += part.text;
        continue;
      }
      if (!VARIABLE_BY_NAME.has(part.name)) {
        const near = suggest(part.name, VARIABLE_BY_NAME.keys());
        warn("ERR-06", `Variable inconnue \`{{${part.name}}}\`${near[0] ? ` — vouliez-vous dire \`{{${near[0]}}}\` ?` : "."}`, name);
        out += part.raw;
        continue;
      }
      let value = resolve(part.name, lang);
      if (value === undefined) {
        out += part.raw;
        continue;
      }
      for (const t of part.transforms) {
        if (isTransform(t)) value = applyTransform(value, t);
        else error("ERR-07", `Transformation \`${t}\` inconnue.`, name);
      }
      out += value;
    }
    stack.pop();
    if (name === "USER_AGENT") out = out.replace("<version>", options.version);
    memo.set(key, out);
    return out;
  };

  const values: Record<string, { value: IdentityValue; origin: "provided" | "derived" }> = {};
  const langList = [...languages].sort();
  for (const def of VARIABLES) {
    if (def.type === "modelTier" || def.type === "tierRef") continue;
    const origin = provided.has(def.name) ? "provided" : "derived";
    if (def.localizable) {
      const table: Record<string, string> = {};
      for (const lang of langList) {
        const v = resolve(def.name, lang);
        if (v !== undefined) table[lang] = v;
      }
      if (Object.keys(table).length > 0) values[def.name] = { value: table, origin };
    } else {
      const v = resolve(def.name, defaultLanguage);
      if (v !== undefined) values[def.name] = { value: v, origin };
    }
  }

  // Constraints (ERR-05) on resolved values.
  for (const def of VARIABLES) {
    const entry = values[def.name];
    if (!entry) continue;
    const texts = typeof entry.value === "string" ? [entry.value] : Object.values(entry.value);
    for (const text of texts) {
      if (/\{\{[A-Z][A-Z0-9_]*(\|[a-z]+)*\}\}/.test(text)) {
        // A variable left unresolved would leak into every deliverable (EF-30).
        if (!issues.some((i) => i.path === def.name && i.code === "ERR-06")) error("ERR-06", `Variable non résolue dans \`${def.name}\` : « ${text} ».`, def.name);
        continue;
      }
      if (def.minLength !== undefined && text.trim().length < def.minLength) error("ERR-05", `\`${def.name}\` ne doit pas être vide.`, def.name);
      if (def.maxLength !== undefined && text.length > def.maxLength) error("ERR-05", `\`${def.name}\` doit compter au plus ${def.maxLength} caractères.`, def.name);
      if (def.pattern && !def.pattern.test(text)) error("ERR-05", `\`${def.name}\` doit correspondre à ${def.constraint ?? def.pattern.source} (valeur : « ${text} »).`, def.name);
      if (def.type === "url") {
        let url: URL | undefined;
        try {
          url = new URL(text);
        } catch {
          error("ERR-05", `\`${def.name}\` doit être une URL valide.`, def.name);
        }
        if (url && url.protocol !== "https:" && !(url.protocol === "http:" && isLocalHost(url.hostname))) {
          error("ERR-14", `URL non sécurisée refusée pour \`${def.name}\`.`, def.name);
        }
      }
    }
  }

  // RG-05: ENV_PREFIX must not collide with a public provider or a system prefix.
  const envPrefix = values["ENV_PREFIX"]?.value;
  if (typeof envPrefix === "string" && RESERVED_ENV_PREFIXES.includes(envPrefix)) {
    error("ERR-05", `\`ENV_PREFIX\` ne peut pas valoir \`${envPrefix}\` : préfixe réservé à un fournisseur ou au système.`, "ENV_PREFIX");
  }

  // Q-05: PRODUCT_CLI must not collide with a common system command.
  const cli = values["PRODUCT_CLI"]?.value;
  const protectedNames = new Set([...PROTECTED_COMMANDS, ...(options.extraProtectedCommands ?? [])]);
  if (typeof cli === "string" && protectedNames.has(cli)) {
    error("ERR-05", `\`PRODUCT_CLI\` = \`${cli}\` entre en collision avec une commande système courante.`, "PRODUCT_CLI");
  }

  // Model tiers and tier references.
  const models: Partial<Record<ModelTier, ModelTierValue>> = {};
  for (const tier of MODEL_TIERS) {
    const raw = provided.get(tier);
    if (isPlainObject(raw)) models[tier] = { label: raw["label"] as IdentityValue, ids: { ...((raw["ids"] as Record<string, string> | undefined) ?? {}) } };
  }
  const definedTiers = MODEL_TIERS.filter((t) => models[t] !== undefined);
  const firstTier = definedTiers[0]!;
  const modelDefault = (provided.get("MODEL_DEFAULT") as ModelTier | undefined) ?? (models.MODEL_MEDIUM ? "MODEL_MEDIUM" : firstTier);
  const modelBackground = (provided.get("MODEL_BACKGROUND") as ModelTier | undefined) ?? (models.MODEL_SMALL ? "MODEL_SMALL" : modelDefault);
  for (const [name, ref] of [["MODEL_DEFAULT", modelDefault], ["MODEL_BACKGROUND", modelBackground]] as const) {
    if (!models[ref]) error("ERR-05", `\`${name}\` référence une gamme non définie (${ref}).`, name);
  }

  // Compatibility section.
  const compat = isPlainObject(data["compatibility"]) ? data["compatibility"] : {};
  const forbiddenTerms = Array.isArray(compat["forbiddenTerms"]) ? compat["forbiddenTerms"].filter((t): t is string => typeof t === "string") : [];
  const allowLegacyReads = compat["allowLegacyReads"] === true;

  if (issues.some((i) => i.severity === "error")) return { issues };

  const body = {
    schemaVersion,
    version: options.version,
    defaultLanguage,
    languages: langList,
    values,
    models,
    modelDefault,
    modelBackground,
    compatibility: { forbiddenTerms, allowLegacyReads },
  };
  const hash = createHash("sha256").update(canonicalJson(body)).digest("hex");
  return { identity: { ...body, hash }, issues };
}

function isLocalizedOrString(v: unknown): boolean {
  if (typeof v === "string") return true;
  return isPlainObject(v) && Object.keys(v).length > 0 && Object.values(v).every((x) => typeof x === "string");
}

function collectLanguages(v: unknown, into: Set<string>): void {
  if (!isPlainObject(v)) return;
  const keys = Object.keys(v);
  if (keys.length > 0 && keys.every((k) => /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(k)) && Object.values(v).every((x) => typeof x === "string")) {
    for (const k of keys) into.add(k);
    return;
  }
  for (const x of Object.values(v)) collectLanguages(x, into);
}

function isLocalHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
