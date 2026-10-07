// Implements: SPEC-CAD-002 (EF-40 to EF-42, FA-02, RG-01, RG-03, ERR-13, ERR-14)
// Read-only access to the resolved identity, with the runtime overrides allowed by RG-03.

import { isOverridable, isServiceUrl, MODEL_TIERS, OVERRIDABLE_VARIABLES, type ModelTier } from "./runtime-catalog";
import type { IdentityValue, ModelTierValue, ResolvedIdentity } from "./resolver";

export interface IdentityOverride {
  readonly name: string;
  readonly source: "environment" | "managed";
}

export interface IdentityWarning {
  readonly code: "ERR-13" | "ERR-14";
  readonly message: string;
}

export class Identity {
  readonly #resolved: ResolvedIdentity;
  readonly #overrides = new Map<string, { value: string; source: IdentityOverride["source"] }>();
  readonly warnings: IdentityWarning[] = [];

  constructor(resolved: ResolvedIdentity) {
    this.#resolved = resolved;
  }

  get hash(): string {
    return this.#resolved.hash;
  }

  get version(): string {
    return this.#resolved.version;
  }

  get defaultLanguage(): string {
    return this.#resolved.defaultLanguage;
  }

  get resolved(): ResolvedIdentity {
    return this.#resolved;
  }

  /** Value of a text variable, in the requested language (falls back to the default language). */
  get(name: string, language?: string): string {
    const override = this.#overrides.get(name);
    if (override) return override.value;
    const entry = this.#resolved.values[name];
    if (!entry) throw new Error(`Identity variable not defined: ${name}`);
    return pickLanguage(entry.value, language ?? this.#resolved.defaultLanguage, this.#resolved.defaultLanguage);
  }

  has(name: string): boolean {
    return this.#overrides.has(name) || this.#resolved.values[name] !== undefined;
  }

  modelTier(tier: ModelTier): ModelTierValue | undefined {
    return this.#resolved.models[tier];
  }

  tierLabel(tier: ModelTier, language?: string): string | undefined {
    const t = this.#resolved.models[tier];
    return t ? pickLanguage(t.label, language ?? this.#resolved.defaultLanguage, this.#resolved.defaultLanguage) : undefined;
  }

  get modelDefault(): ModelTier {
    return (this.#overrides.get("MODEL_DEFAULT")?.value as ModelTier | undefined) ?? this.#resolved.modelDefault;
  }

  get modelBackground(): ModelTier {
    return (this.#overrides.get("MODEL_BACKGROUND")?.value as ModelTier | undefined) ?? this.#resolved.modelBackground;
  }

  /** Names that may appear as runtime overrides (known variables, for ERR-13, and overridable ones). */
  get overridableCandidates(): string[] {
    return [...new Set([...Object.keys(this.#resolved.values), ...OVERRIDABLE_VARIABLES])];
  }

  get overrides(): IdentityOverride[] {
    return [...this.#overrides.entries()].map(([name, o]) => ({ name, source: o.source }));
  }

  /**
   * Applies runtime overrides (FA-02). Environment first, then managed settings, which win (EF-42).
   * `environment` maps variable names (without prefix) to raw values.
   */
  applyOverrides(environment: Readonly<Record<string, string>>, managed: Readonly<Record<string, string>> = {}, allowEnvironment = true): void {
    const apply = (source: IdentityOverride["source"], entries: Readonly<Record<string, string>>) => {
      for (const [name, value] of Object.entries(entries)) {
        if (!this.#resolved.values[name] && !OVERRIDABLE_VARIABLES.has(name)) continue;
        if (!isOverridable(name)) {
          this.warnings.push({ code: "ERR-13", message: `\`${name}\` ne peut pas être modifié à l'exécution.` });
          continue;
        }
        if (name === "MODEL_DEFAULT" || name === "MODEL_BACKGROUND") {
          if (!(MODEL_TIERS as readonly string[]).includes(value) || !this.#resolved.models[value as ModelTier]) {
            this.warnings.push({ code: "ERR-13", message: `\`${name}\` doit référencer une gamme définie.` });
            continue;
          }
        } else if (isServiceUrl(name) && !isSecureUrl(value)) {
          this.warnings.push({ code: "ERR-14", message: `URL non sécurisée refusée pour \`${name}\`.` });
          continue;
        }
        this.#overrides.set(name, { value, source });
      }
    };
    if (allowEnvironment) apply("environment", environment);
    apply("managed", managed);
  }
}

export function pickLanguage(value: IdentityValue, language: string, defaultLanguage: string): string {
  if (typeof value === "string") return value;
  return value[language] ?? value[language.split("-")[0] ?? ""] ?? value[defaultLanguage] ?? Object.values(value)[0] ?? "";
}

function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  } catch {
    return false;
  }
}
