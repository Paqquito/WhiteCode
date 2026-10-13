// Implements: SPEC-CFG-009 (FA-02/03, safe cosmetic alias), gap E-153.
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
export const WELCOME_MIGRATION = "20261013-ui-compact-welcome";
export function convertDeprecated(text: string): { text: string; changed: boolean } {
  const errors: ParseError[] = [];
  const data = parse(text, errors, { allowTrailingComma: true }) as Record<string, unknown> | undefined;
  if (errors.length) return { text, changed: false };
  if (!data || typeof data !== "object" || Array.isArray(data)) return { text, changed: false };
  const ui = data["ui"] as Record<string, unknown> | undefined;
  const oldPath = Object.hasOwn(data, "ui.compactWelcome") ? ["ui.compactWelcome"] : ui && typeof ui === "object" && Object.hasOwn(ui, "compactWelcome") ? ["ui", "compactWelcome"] : undefined;
  if (!oldPath) return { text, changed: false };
  const value = oldPath.length === 1 ? data[oldPath[0]!] : ui!["compactWelcome"], welcome = ui?.["welcome"] as Record<string, unknown> | undefined;
  const options = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
  let next = text;
  if (!Object.hasOwn(data, "ui.welcome.compact") && !(welcome && typeof welcome === "object" && Object.hasOwn(welcome, "compact"))) next = applyEdits(next, modify(next, ["ui", "welcome", "compact"], value, options));
  next = applyEdits(next, modify(next, oldPath, undefined, options));
  return { text: next, changed: next !== text };
}
