// Implements: SPEC-CFG-005 (§ 5.3 steps 1 to 5, FA-02, FA-03, EF-01 to EF-04, ERR-01, CA-01 to CA-03)
// Detection of changes in the settings files during a session: checked before each request (a periodic check, which
// also covers the file systems without change notification, ERR-01); an invalid file keeps its last valid version.

import { statSync } from "node:fs";
import { parse, type ParseError } from "jsonc-parser";
import { readSettingsFile, Settings, type LoadOptions, type ScopeSource } from "./settings";
import { SETTINGS } from "./settings-schema";

export interface ReloadResult {
  readonly settings: Settings;
  /** Keys whose effective value changed (step 3). */
  readonly changed: readonly string[];
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
  #current: Settings;

  /** `files`: the sources read from disk (managed, user, project, local); `fixed`: the others (`--config-source`). */
  constructor(o: { files: readonly ScopeSource[]; fixed: readonly ScopeSource[]; base: Omit<LoadOptions, "sources">; current: Settings; warn: (message: string) => void }) {
    this.#files = o.files.map((f) => ({ ...f }));
    this.#fixed = o.fixed;
    this.#base = o.base;
    this.#current = o.current;
    this.#warn = o.warn;
    for (const f of this.#files) this.#stamps.set(f.name, stamp(f.name));
  }

  get current(): Settings {
    return this.#current;
  }

  /** Steps 1 to 3: reloads the changed files and recomputes the effective settings; undefined when nothing changed. */
  check(): ReloadResult | undefined {
    let touched = false;
    for (let i = 0; i < this.#files.length; i++) {
      const f = this.#files[i]!;
      const now = stamp(f.name);
      if (now === this.#stamps.get(f.name)) continue;
      this.#stamps.set(f.name, now);
      const text = readSettingsFile(f.name);
      if (text !== undefined && !valid(text)) {
        // FA-02, EF-04, CA-03: the previous valid version of this scope stays applied.
        this.#warn(`Paramètres invalides dans ${f.name} : la configuration précédente reste appliquée.`);
        continue;
      }
      if (text === f.text) continue;
      this.#files[i] = { ...f, text };
      touched = true;
    }
    if (!touched) return undefined;
    const next = Settings.load({ ...this.#base, sources: [...this.#files, ...this.#fixed] });
    const changed = SETTINGS.map((d) => d.key).filter((k) => JSON.stringify(next.get(k)) !== JSON.stringify(this.#current.get(k)));
    this.#current = next;
    return { settings: next, changed };
  }
}

/** Keys applied during the session (EF-02); the others take effect at the next session (EF-03). */
export function isHotKey(key: string): boolean {
  return SETTINGS.find((d) => d.key === key)?.hot === true;
}
