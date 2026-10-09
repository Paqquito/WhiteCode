// Implements: SPEC-CFG-005 (§ 5.3 steps 1 to 5, FA-02, FA-03, EF-01 to EF-04, ERR-01, CA-01 to CA-03)
// Detection of changes in the settings files during a session: checked before each request (a periodic check, which
// also covers the file systems without change notification, ERR-01); an invalid file keeps its last valid version.
// Supports: SPEC-CFG-003 (CA-02, CA-08, CA-13, CA-14, FA-02, profile and offline cache reload), gaps E-121 to E-127: unauthorised managed bytes never enter the reloaded configuration.

import { statSync } from "node:fs";
import { parse, type ParseError } from "jsonc-parser";
import { readSettingsFile, Settings, type LoadOptions, type ScopeSource } from "./settings";
import { SETTINGS } from "./settings-schema";
import { readManagedPolicy, type PolicyCapability } from "./managed-policy";
import type { PolicyAnchor } from "../identity/resolver";
import type { ManagedSystemPolicy } from "./managed-system-policy";
import type { PolicyFileProtectionReader } from "../platform/policy-file";
import type { PolicyCacheSource } from "./policy-cache";

export interface ReloadResult {
  readonly settings: Settings;
  /** Keys whose effective value changed (step 3). */
  readonly changed: readonly string[];
  /** Scopes whose file changed. */
  readonly scopes: readonly string[];
}

const stamp = (path: string): string => {
  try {
    const s = statSync(path);
    return `${s.mtimeMs}:${s.size}`;
  } catch {
    return "absent";
  }
};

const valid = (text: string): boolean => {
  const errors: ParseError[] = [];
  parse(text, errors, { allowTrailingComma: true });
  return errors.length === 0;
};

export class SettingsReloader {
  readonly #base: Omit<LoadOptions, "sources">;
  readonly #fixed: readonly ScopeSource[];
  readonly #files: ScopeSource[];
  readonly #stamps = new Map<string, string>();
  readonly #warn: (message: string) => void;
  readonly #policyAnchor?: PolicyAnchor;
  readonly #policyCapability: PolicyCapability;
  readonly #policyFileProtection?: PolicyFileProtectionReader;
  #current: Settings;
  readonly #systemPolicy?: ManagedSystemPolicy;
  #systemPolicyText?: string;
  readonly #cachePolicy?: PolicyCacheSource;
  #cachePolicyText?: string;

  /** `files`: the sources read from disk (managed, user, project, local); `fixed`: the others (`--config-source`). */
  constructor(o: { files: readonly ScopeSource[]; fixed: readonly ScopeSource[]; base: Omit<LoadOptions, "sources">; current: Settings; warn: (message: string) => void; policyAnchor?: PolicyAnchor; policyCapability?: PolicyCapability; policyFileProtection?: PolicyFileProtectionReader; systemPolicy?: ManagedSystemPolicy; systemPolicyText?: string; cachePolicy?: PolicyCacheSource; cachePolicyText?: string }) {
    this.#cachePolicy = o.cachePolicy;
    this.#cachePolicyText = o.cachePolicyText;
    this.#systemPolicy = o.systemPolicy;
    this.#systemPolicyText = o.systemPolicyText;
    this.#files = o.files.map((f) => ({ ...f }));
    this.#fixed = o.fixed;
    this.#base = o.base;
    this.#current = o.current;
    this.#warn = o.warn;
    this.#policyAnchor = o.policyAnchor ? Object.freeze({ ...o.policyAnchor }) : undefined;
    this.#policyCapability = o.policyCapability ?? "local";
    this.#policyFileProtection = o.policyFileProtection;
    for (const f of this.#files) this.#stamps.set(f.name, stamp(f.name));
  }

  get current(): Settings {
    return this.#current;
  }

  /** Steps 1 to 3: reloads the changed files and recomputes the effective settings; undefined when nothing changed. */
  check(): ReloadResult | undefined {
    let touched = false;
    const scopes: string[] = [];
    const cache = this.#cachePolicy?.read(this.#policyCapability);
    for (const issue of cache?.issues ?? []) this.#warn(issue.message);
    if (cache && !cache.issues.some((issue) => issue.severity === "error") && cache.settingsText !== this.#cachePolicyText) {
      this.#cachePolicyText = cache.settingsText;
      touched = true;
      scopes.push("managed");
    }
    const systemPolicy = this.#systemPolicy?.read();
    if (systemPolicy?.issues.some((issue) => issue.severity === "error")) {
      for (const issue of systemPolicy.issues) this.#warn(issue.message);
    } else if (systemPolicy && systemPolicy.settingsText !== this.#systemPolicyText) {
      for (const issue of systemPolicy.issues) this.#warn(issue.message);
      this.#systemPolicyText = systemPolicy.settingsText;
      touched = true;
      scopes.push("managed");
    }
    for (let i = 0; i < this.#files.length; i++) {
      const f = this.#files[i]!;
      const now = stamp(f.name);
      if (f.scope !== "managed" && now === this.#stamps.get(f.name)) continue;
      this.#stamps.set(f.name, now);
      let text: string | undefined;
      if (f.scope === "managed") {
        const policy = readManagedPolicy(f.name, this.#policyAnchor, this.#policyCapability, this.#policyFileProtection);
        for (const issue of policy.issues) this.#warn(issue.message);
        if (policy.issues.some((issue) => issue.severity === "error")) continue;
        text = policy.settingsText;
      } else text = readSettingsFile(f.name);
      if (text !== undefined && !valid(text)) {
        // FA-02, EF-04, CA-03: the previous valid version of this scope stays applied.
        this.#warn(`Paramètres invalides dans ${f.name} : la configuration précédente reste appliquée.`);
        continue;
      }
      if (text === f.text) continue;
      this.#files[i] = { ...f, text };
      touched = true;
      scopes.push(f.scope);
    }
    if (!touched) return undefined;
    const next = Settings.load({ ...this.#base, sources: [...this.#files, ...this.#fixed, ...(this.#systemPolicy ? [{ scope: "managed" as const, name: this.#systemPolicy.name, text: this.#systemPolicyText }] : []), ...(this.#cachePolicy ? [{ scope: "managed" as const, name: this.#cachePolicy.name, text: this.#cachePolicyText }] : [])] });
    const changed = SETTINGS.map((d) => d.key).filter((k) => JSON.stringify(next.get(k)) !== JSON.stringify(this.#current.get(k)));
    this.#current = next;
    return { settings: next, changed, scopes };
  }
}

/** Keys applied during the session (EF-02); the others take effect at the next session (EF-03). */
export function isHotKey(key: string): boolean {
  return SETTINGS.find((d) => d.key === key)?.hot === true;
}
