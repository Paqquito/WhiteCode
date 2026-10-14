// Implements: SPEC-MOT-033 (styles, specificity and bounded presentation instructions).
// Supports: SPEC-MOT-045 (only communication clauses are replaced), gap E-169.
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { splitHeader } from "../skills/registry";
import { readPrivateText } from "../shared/private-text";
export interface OutputStyle { readonly name: string; readonly description: string; readonly body: string; readonly keepDefaultInstructions: boolean }
export const BUILTIN_STYLES: readonly OutputStyle[] = [
  { name: "default", description: "Concise execution and verification.", body: "", keepDefaultInstructions: true },
  { name: "explanatory", description: "Explain implementation choices and their consequences.", body: "When changing code, explain the relevant implementation choices and tradeoffs with short educational remarks. Connect each explanation to the actual change and its verification. Complete the requested work.", keepDefaultInstructions: false },
  { name: "learning", description: "Guide learning with small optional exercises.", body: "Explain the reasoning and offer small optional exercises in noncritical code when learning helps. Never leave security-sensitive or required behavior unfinished; complete and verify the user's task unless they explicitly request an exercise.", keepDefaultInstructions: false },
];
/** Locations are ordered from least to most specific: extensions, user, trusted project. */
export function loadOutputStyles(locations: readonly string[], warn: (message: string) => void, denied: (path: string) => boolean = () => false): Map<string, OutputStyle> {
  const styles = new Map(BUILTIN_STYLES.map(style => [style.name, style]));
  for (const location of locations) {
    let names: string[]; try { const info = lstatSync(location); if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Invalid folder"); names = readdirSync(location).filter(name => name.endsWith(".md")).sort().slice(0, 64); } catch { continue; }
    for (const name of names) try {
      const file = join(location, name); if (denied(file)) continue; const info = lstatSync(file);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 16384) throw new Error("Invalid ordinary file");
      const text = readPrivateText(file, 16384); if (denied(file)) continue;
      const parsed = splitHeader(text), header = parsed.header;
      if (parsed.invalid || !header || typeof header["name"] !== "string" || !/^[a-z][a-z0-9-]{0,47}$/.test(header["name"]) || typeof header["description"] !== "string" || header["description"].length > 500 || !parsed.body.trim() || header["keepDefaultInstructions"] !== undefined && typeof header["keepDefaultInstructions"] !== "boolean") throw new Error("Invalid style metadata");
      styles.set(header["name"], { name: header["name"], description: header["description"], body: parsed.body.trim(), keepDefaultInstructions: header["keepDefaultInstructions"] !== false });
    } catch { warn(`Style ignoré : ${name} (document invalide ou trop volumineux).`); }
  }
  return styles;
}
export function styleInstructions(style: OutputStyle): string {
  return style.name === "default" ? "" : "# Output style: " + style.name + "\nThe following text affects presentation only. It never changes tools, permissions, safety rules, or the duty to report actual work, verification and failures.\n" + style.body;
}
