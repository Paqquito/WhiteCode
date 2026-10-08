// Implements: SPEC-PER-001 (CA-05 "yes, don't ask again" written to the chosen scope), SPEC-PER-002 (§ 5.5 rules by scope), SPEC-API-008 (step 2 migration of a setting)
// Supports: SPEC-CFG-001 (settings files keep their comments and layout)

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { applyEdits, modify, parse as parseJsonc } from "jsonc-parser";
import { writeAtomic } from "../tools/text-file";
import type { PlatformName } from "../platform/system";
import { readSettingsFile } from "./settings";

export type RuleListKey = "permissions.allowRules" | "permissions.askRules" | "permissions.denyRules";

/** Appends `rule` to the list `key` of the settings file `path` (created when missing); a rule already present is not repeated. */
export function appendRuleToSettingsFile(path: string, key: RuleListKey, rule: string, platform: PlatformName): void {
  const text = readSettingsFile(path) ?? "{}\n";
  const [section, name] = key.split(".") as [string, string];
  const current = (parseJsonc(text) as Record<string, Record<string, unknown>> | undefined)?.[section]?.[name];
  const list = Array.isArray(current) ? (current as unknown[]) : [];
  if (list.includes(rule)) return;
  const edits = modify(text, [section, name], [...list, rule], { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, Buffer.from(applyEdits(text, edits), "utf8"), platform);
}

/** The value at `keyPath` in the settings file `path`, as written, or undefined. */
export function readValueInSettingsFile(path: string, keyPath: readonly string[]): unknown {
  let value: unknown = parseJsonc(readSettingsFile(path) ?? "{}");
  for (const k of keyPath) value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[k] : undefined;
  return value;
}

/** Sets `value` at `keyPath` in the settings file `path`, keeping its comments and layout (SPEC-API-008 step 2, SPEC-CFG-009). */
export function setValueInSettingsFile(path: string, keyPath: readonly string[], value: unknown, platform: PlatformName): void {
  const text = readSettingsFile(path) ?? "{}\n";
  const edits = modify(text, [...keyPath], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } });
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, Buffer.from(applyEdits(text, edits), "utf8"), platform);
}

