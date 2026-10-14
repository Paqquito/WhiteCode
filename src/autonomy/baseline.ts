// Implements: SPEC-MOD-031 (CA-01/02, explicit settings take precedence).
// Supports: gap E-166.
import type { Settings } from "../config/settings";
/** Version 1 of the mechanisms disabled by the reference experiment. */
export const BASELINE_MECHANISMS = ["context.autoCompact.enabled", "context.microCompact.enabled", "context.reactiveCompact.enabled", "memory.automatic.enabled", "memory.autoExtraction.enabled", "memory.session.enabled", "tasks.enabled"] as const;
export function baselineSettings(settings: Settings, enabled: boolean): Settings {
  if (!enabled) return settings;
  return new Proxy(settings, { get(target, key) {
    if (key === "get") return (name: string) => (BASELINE_MECHANISMS as readonly string[]).includes(name) && target.origin(name) === "default" ? false : target.get(name);
    const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
