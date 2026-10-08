// Implements: SPEC-CMD-039 (§ 5.1, § 5.3 steps 1 and 3, EF-01, § 10, CA-01)
// Supports: SPEC-IHM-014 (§ 5.4 a configuration file of the bindings), gap E-116
// The file of the key bindings: a commented model created on demand, read over the bindings of the user settings.

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import { readSettingsFile } from "../config/settings";
import { ACTIONS, comboLabel, parseCombo } from "./keymap";

/** EF-01: a valid file whose comments list every action, its context and its default combinations. */
export function keybindingsTemplate(product: string): string {
  const width = Math.max(...ACTIONS.map((a) => a.id.length));
  const rows = ACTIONS.map((a) => `//   ${a.id.padEnd(width)}  ${(a.defaults.map((d) => comboLabel(parseCombo(d) ?? d)).join(", ") || "—").padEnd(14)}  ${a.label}${a.essential ? " (essentielle)" : ""}`);
  return [
    `// Raccourcis clavier de ${product}.`,
    "// Associez un identifiant d'action à une combinaison (\"ctrl+k\") ou à une liste ([\"ctrl+k\", \"f2\"]).",
    "// Une chaîne vide désactive l'action ; les actions essentielles ne peuvent pas l'être.",
    "// Ces associations s'ajoutent à celles des paramètres (ui.keybindings.bindings) et l'emportent sur elles.",
    "// Le fichier est rechargé à chaque enregistrement ; /shortcuts reset rétablit les associations par défaut.",
    "//",
    "// Actions (identifiant, défaut, description) :",
    ...rows,
    "{",
    '  "bindings": {',
    '    // "input.submit": "enter"',
    "  }",
    "}",
    "",
  ].join("\n");
}

/** The bindings of the file, or why they cannot be read (step 3: the errors are reported). */
export function readKeybindingsFile(path: string): { readonly bindings: Record<string, unknown>; readonly error?: string } {
  const text = readSettingsFile(path);
  if (text === undefined) return { bindings: {} };
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true }) as unknown;
  if (errors.length > 0) {
    const line = text.slice(0, errors[0]!.offset).split("\n").length;
    return { bindings: {}, error: `Fichier de raccourcis invalide (${printParseErrorCode(errors[0]!.error)}, ligne ${line}) : ${path}.` };
  }
  const bindings = value && typeof value === "object" ? (value as Record<string, unknown>)["bindings"] : undefined;
  if (bindings !== undefined && (typeof bindings !== "object" || bindings === null || Array.isArray(bindings))) return { bindings: {}, error: `« bindings » doit être un objet : ${path}.` };
  return { bindings: (bindings ?? {}) as Record<string, unknown> };
}
