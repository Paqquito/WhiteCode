// Implements: SPEC-MCP-015 (CA-01/02, presentation separate from the model's original content).
// Supports: SPEC-IHM-003, gap E-164.
import { sanitize, textWidth } from "../ui/text";
import { maskSecrets } from "../shared/secrets";
import { redact as redactFields } from "../shared/debug-log";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const flat = (value: unknown): value is Record<string, unknown> => object(value) && Object.values(value).every(item => item === null || ["string", "number", "boolean"].includes(typeof item));
function cell(value: unknown): string { return sanitize(String(value ?? "null"), false).slice(0, 120); }
const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
function fit(value: string, width: number): string { let text = "", used = 0; for (const part of segmenter.segment(value)) { const size = textWidth(part.segment); if (used + size > width) break; text += part.segment; used += size; } return text + " ".repeat(width - used); }
/** Redact actual scalar values and property names before JSON escaping or any display truncation. */
export function connectorDisplayRaw(value: unknown, redact: (text: string) => string = maskSecrets): string {
  const safe = (item: unknown): unknown => typeof item === "string" ? maskSecrets(redact(item)) : Array.isArray(item) ? item.map(safe) : object(item) ? Object.fromEntries(Object.entries(item).map(([key, value]) => [maskSecrets(redact(key)), safe(value)])) : item;
  return JSON.stringify(safe(redactFields(value)), null, 2);
}
/** Bounded optional presentation. This function never modifies the MCP result itself. */
export function connectorDisplay(value: unknown, maxLines = 40, redact: (text: string) => string = maskSecrets): string | undefined {
  if (value === undefined) return undefined;
  value = redactFields(value);
  const limit = Math.max(3, Math.min(200, maxLines));
  let headers: string[], rows: unknown[][];
  if (flat(value)) { headers = ["Clé", "Valeur"]; rows = Object.entries(value).slice(0, limit - 3).map(([key, value]) => [key, value]); }
  else if (Array.isArray(value) && value.length && value.length <= 10000 && value.every(flat)) {
    headers = Object.keys(value[0]!);
    if (headers.length && headers.length <= 12 && value.every(row => Object.keys(row).length === headers.length && headers.every(key => Object.hasOwn(row, key)))) rows = value.slice(0, limit - 3).map(row => headers.map(key => row[key]));
    else return fallback(value, limit, redact);
  } else return fallback(value, limit, redact);
  const safeCell = (value: unknown) => cell(maskSecrets(redact(String(value ?? "null"))));
  const cells = rows.map(row => row.map(safeCell)), heads = headers.map(safeCell), widths = heads.map((head, index) => Math.min(32, Math.max(textWidth(head), ...cells.map(row => textWidth(row[index]!)))));
  const line = (row: string[]) => row.map((value, index) => fit(value, widths[index]!)).join(" | ");
  const rendered = [line(heads), widths.map(width => "-".repeat(width)).join("-+-"), ...cells.map(line)].slice(0, limit - 1);
  const total = Array.isArray(value) ? value.length : Object.keys(value as object).length;
  if (total > cells.length) rendered.push(`[${total - cells.length} lignes supplémentaires ; sortie brute dans le détail.]`);
  return rendered.join("\n");
}
function fallback(value: unknown, maxLines: number, redact: (text: string) => string): string {
  const safe = (item: unknown, depth = 0): unknown => depth > 8 ? "[Nested content omitted]" : typeof item === "string" ? maskSecrets(redact(item)) : Array.isArray(item) ? item.slice(0, 1000).map(value => safe(value, depth + 1)) : object(item) ? Object.fromEntries(Object.entries(item).slice(0, 1000).map(([key, value]) => [maskSecrets(redact(key)), safe(value, depth + 1)])) : item;
  const lines = JSON.stringify(safe(value), null, 2).slice(0, 32000).split("\n");
  return lines.slice(0, maxLines - 1).map(cell).join("\n") + (lines.length >= maxLines ? "\n[Sortie repliée ; contenu brut dans le détail.]" : "");
}
