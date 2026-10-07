// Implements: SPEC-CFG-001 (EF-01 to EF-05, RG-01 to RG-08, FA-01 to FA-03), SPEC-CFG-002 (EF-03, ERR-01 to ERR-03, RG-02)
// Loads the settings scopes, validates each key, merges them by priority and records the origin of every value.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { compileRaw } from "../shared/schema";
import { suggest } from "../shared/suggest";
import { isKnownPrefix, SETTING_BY_KEY, type Origin, type Scope, type SettingDef } from "./settings-schema";
import { parseAmount, parseDuration, parseSize } from "./units";

export interface ConfigIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  /** Nature of the problem: `config validate` treats every kind but `unknown-key` and `untrusted` as an error of the file. */
  readonly kind?: "scope" | "type" | "range" | "restrictive" | "invalid-json" | "unknown-key" | "untrusted";
  readonly message: string;
  readonly scope?: Origin;
  readonly key?: string;
}

export interface ScopeSource {
  readonly scope: Scope;
  /** Display name (file path or option). */
  readonly name: string;
  /** Raw text, or undefined when the source does not exist (FA-01). */
  readonly text: string | undefined;
}

export interface LoadOptions {
  readonly sources: readonly ScopeSource[];
  /** Values from the environment (origin `env`), keyed by setting key. */
  readonly environment?: Readonly<Record<string, unknown>>;
  /** Values from command-line options (scope `cli`), keyed by setting key. */
  readonly cliValues?: Readonly<Record<string, unknown>>;
  /** Scopes restricted by `--config-scopes` (`managed` and `cli` are always loaded, EF-03). */
  readonly allowedScopes?: readonly Scope[];
  /** Project and local scopes are read only for a trusted project (SPEC-PER-016, decision D-05). */
  readonly projectTrusted: boolean;
}

const SCOPE_LABEL: Record<Origin, string> = {
  managed: "gérée",
  cli: "ligne de commande",
  env: "environnement",
  local: "locale",
  project: "projet",
  user: "utilisateur",
  default: "défaut",
};

/** Merge order, from the weakest to the strongest (E-002). */
const MERGE_ORDER: readonly Origin[] = ["default", "user", "project", "local", "env", "cli", "managed"];

const validators = new Map<string, ReturnType<typeof compileRaw>>();
function validatorFor(def: SettingDef) {
  let v = validators.get(def.key);
  if (!v) {
    v = compileRaw(def.schema);
    validators.set(def.key, v);
  }
  return v;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

/** Flattens a settings object into declared keys; unknown keys are reported (ERR-02 of SPEC-CFG-001). */
function flatten(obj: Record<string, unknown>, prefix: string, out: Map<string, unknown>, unknown: string[]): void {
  for (const [k, v] of Object.entries(obj)) {
    if (prefix === "" && k === "$schema") continue;
    const key = prefix ? `${prefix}.${k}` : k;
    if (SETTING_BY_KEY.has(key)) out.set(key, v);
    else if (isPlainObject(v) && isKnownPrefix(key)) flatten(v, key, out, unknown);
    else unknown.push(key);
  }
}

function typeName(def: SettingDef): string {
  const t = (def.schema as { type?: unknown; anyOf?: unknown[] }).type;
  if (def.kind === "duration") return "durée";
  if (def.kind === "size") return "taille";
  if (def.kind === "amount") return "montant";
  return typeof t === "string" ? t : "valeur énumérée";
}

function convert(def: SettingDef, value: unknown): unknown {
  switch (def.kind) {
    case "duration":
      return parseDuration(value);
    case "size":
      return parseSize(value);
    case "amount":
      return parseAmount(value);
    default:
      return value;
  }
}

export class Settings {
  readonly #values = new Map<string, unknown>();
  readonly #origins = new Map<string, Origin>();
  readonly #perScope = new Map<Origin, Map<string, unknown>>();
  /** Sources (file paths or options) that defined each key, by scope. */
  readonly #sources = new Map<Origin, Map<string, string[]>>();
  readonly issues: ConfigIssue[] = [];

  static load(options: LoadOptions): Settings {
    const s = new Settings();
    s.#load(options);
    return s;
  }

  get<T = unknown>(key: string): T {
    if (!SETTING_BY_KEY.has(key)) throw new Error(`Undeclared setting key: ${key}`);
    return this.#values.get(key) as T;
  }

  origin(key: string): Origin {
    return this.#origins.get(key) ?? "default";
  }

  /** Value defined by one scope, before merging (used for limits: the most restrictive wins, SPEC-MOD-005). */
  valuesByScope(key: string): Array<{ origin: Origin; value: unknown }> {
    const out: Array<{ origin: Origin; value: unknown }> = [];
    for (const origin of MERGE_ORDER) {
      const map = this.#perScope.get(origin);
      if (map?.has(key)) out.push({ origin, value: map.get(key) });
    }
    return out;
  }

  /** Files (or options) of `origin` that define `key`: the location of a declaration (SPEC-PER-001 § 5.3 point c). */
  sourcesOf(origin: Origin, key: string): readonly string[] {
    return this.#sources.get(origin)?.get(key) ?? [];
  }

  isManaged(key: string): boolean {
    return this.#perScope.get("managed")?.has(key) === true;
  }

  #layer(origin: Origin): Map<string, unknown> {
    let m = this.#perScope.get(origin);
    if (!m) {
      m = new Map();
      this.#perScope.set(origin, m);
    }
    return m;
  }

  #issue(issue: ConfigIssue): void {
    this.issues.push(issue);
  }

  /** Validates one value for one origin; returns the converted value or undefined when rejected. */
  #accept(origin: Origin, key: string, raw: unknown): unknown {
    const def = SETTING_BY_KEY.get(key)!;
    if (origin !== "env" && origin !== "default" && !def.scopes.includes(origin)) {
      const inProject = origin === "project" || origin === "local";
      const reason = inProject && def.widening ? " (clé élargissante)" : "";
      this.#issue({ code: "ERR-01", severity: "warning", kind: "scope", scope: origin, key, message: `\`${key}\` n'est pas autorisé dans les paramètres de portée ${SCOPE_LABEL[origin]}${reason} ; valeur ignorée.` });
      return undefined;
    }
    if (!validatorFor(def)(raw)) {
      this.#issue({ code: "ERR-03", severity: "warning", kind: "type", scope: origin, key, message: `\`${key}\` : type attendu ${typeName(def)} ; valeur ignorée.` });
      return undefined;
    }
    const value = convert(def, raw);
    if (value === undefined) {
      this.#issue({ code: "ERR-02", severity: "warning", kind: "range", scope: origin, key, message: `\`${key}\` : valeur hors limites ; valeur ignorée.` });
      return undefined;
    }
    if ((origin === "project" || origin === "local") && def.restrictiveValues && !def.restrictiveValues.includes(value)) {
      this.#issue({
        code: "RG-08",
        severity: "warning", kind: "restrictive",
        scope: origin,
        key,
        message: `\`${key}\` = ${JSON.stringify(value)} n'est pas accepté en portée ${SCOPE_LABEL[origin]} (valeurs admises : ${def.restrictiveValues.map((v) => JSON.stringify(v)).join(", ")}) ; valeur par défaut conservée.`,
      });
      return undefined;
    }
    return value;
  }

  #readSource(source: ScopeSource): void {
    if (source.text === undefined) return; // FA-01
    const errors: ParseError[] = [];
    const data = parseJsonc(source.text, errors, { allowTrailingComma: true, disallowComments: false });
    if (errors.length > 0 || !isPlainObject(data)) {
      const line = errors[0] ? lineOf(source.text, errors[0].offset) : 1;
      this.#issue({ code: "ERR-01", severity: "warning", kind: "invalid-json", scope: source.scope, message: `Paramètres ignorés dans ${source.name} : JSON invalide ligne ${line}.` });
      return;
    }
    const flat = new Map<string, unknown>();
    const unknown: string[] = [];
    flatten(data, "", flat, unknown);
    for (const key of unknown) {
      const near = suggest(key, SETTING_BY_KEY.keys(), 3);
      this.#issue({ code: "ERR-02", severity: "warning", kind: "unknown-key", scope: source.scope, key, message: `Clé inconnue \`${key}\`${near[0] ? ` — vouliez-vous dire \`${near[0]}\` ?` : "."}` });
    }
    const layer = this.#layer(source.scope);
    for (const [key, raw] of flat) {
      const value = this.#accept(source.scope, key, raw);
      if (value === undefined) continue;
      layer.set(key, mergeInto(SETTING_BY_KEY.get(key)!, layer.get(key), value));
      let names = this.#sources.get(source.scope);
      if (!names) this.#sources.set(source.scope, (names = new Map()));
      names.set(key, [...(names.get(key) ?? []), source.name]);
    }
  }

  #load(options: LoadOptions): void {
    const allowed = new Set<Scope>(options.allowedScopes ?? ["user", "project", "local"]);
    allowed.add("managed");
    allowed.add("cli");
    let untrustedReported = false;
    for (const source of options.sources) {
      if (!allowed.has(source.scope)) continue;
      if ((source.scope === "project" || source.scope === "local") && !options.projectTrusted) {
        if (source.text !== undefined && !untrustedReported) {
          untrustedReported = true;
          this.#issue({ code: "FA-03", severity: "warning", kind: "untrusted", scope: source.scope, message: "Paramètres du projet ignorés : projet non approuvé (option --allow-project-trust pour cette exécution)." });
        }
        continue;
      }
      this.#readSource(source);
    }
    for (const [origin, values] of [["env", options.environment ?? {}], ["cli", options.cliValues ?? {}]] as const) {
      const layer = this.#layer(origin);
      for (const [key, raw] of Object.entries(values)) {
        if (!SETTING_BY_KEY.has(key)) continue;
        const value = this.#accept(origin, key, raw);
        if (value !== undefined) layer.set(key, mergeInto(SETTING_BY_KEY.get(key)!, layer.get(key), value));
      }
    }
    // Defaults, then scopes from the weakest to the strongest.
    for (const def of SETTING_BY_KEY.values()) {
      if (def.default !== undefined) {
        this.#values.set(def.key, structuredClone(def.default));
        this.#origins.set(def.key, "default");
      }
    }
    for (const origin of MERGE_ORDER) {
      if (origin === "default") continue;
      const layer = this.#perScope.get(origin);
      if (!layer) continue;
      for (const [key, value] of layer) {
        const def = SETTING_BY_KEY.get(key)!;
        const current = this.#origins.get(key) === "default" ? undefined : this.#values.get(key);
        this.#values.set(key, mergeInto(def, current, value));
        this.#origins.set(key, origin);
      }
    }
  }
}

function mergeInto(def: SettingDef, current: unknown, incoming: unknown): unknown {
  if (current === undefined) return incoming;
  if (def.merge === "concat" && Array.isArray(current) && Array.isArray(incoming)) {
    const out = [...current];
    for (const item of incoming) if (!out.some((x) => JSON.stringify(x) === JSON.stringify(item))) out.push(item);
    return out;
  }
  if (isPlainObject(current) && isPlainObject(incoming)) {
    const out: Record<string, unknown> = { ...current };
    for (const [k, v] of Object.entries(incoming)) out[k] = v;
    return out;
  }
  return incoming;
}

/** Reads a settings file; undefined when absent. Unreadable files are reported as invalid by the loader. */
export function readSettingsFile(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "\u0000"; // forces an "invalid JSON" report (FA-02)
  }
}
