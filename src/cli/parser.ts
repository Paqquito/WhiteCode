// Implements: SPEC-MOD-011 (§ 5.4, FA-01, FA-03, FA-05, FA-06, EF-01, EF-02, ERR-01 to ERR-06, ENF-02), SPEC-MOD-012 (§ 5.1 structure)
// Parses the command line against the declarative catalogue. Every error is a usage error (exit code 2).

import { suggest } from "../shared/suggest";
import { CONFLICTS, FAMILIES, OPTION_BY_NAME, REQUIRES, type OptionDef } from "./options";

export class CliUsageError extends Error {
  readonly exitCode = 2;
}

export type OptionValueMap = Map<string, string | true | string[]>;

export interface ParsedCommandLine {
  readonly options: OptionValueMap;
  /** Sub-command family and operation, when the first positional names a family (SPEC-MOD-012). */
  readonly subcommand?: { readonly family: string; readonly operation?: string; readonly args: readonly string[] };
  /** Initial request, when given as a positional argument. */
  readonly prompt?: string;
}

/** Splits a comma-separated list, ignoring commas inside parentheses (rules such as `run_shell(a,b)`). */
export function splitList(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of value) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === "," && depth === 0) {
      out.push(current.trim());
      current = "";
    } else current += ch;
  }
  if (current.trim() !== "" || out.length > 0) out.push(current.trim());
  return out.filter((s) => s !== "");
}

function checkValue(def: OptionDef, raw: string): void {
  const bad = (expected: string) => new CliUsageError(`Valeur invalide pour --${def.name} : attendu ${expected}.`);
  switch (def.type) {
    case "integer":
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw bad("un entier supérieur ou égal à 1");
      break;
    case "seconds":
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw bad("un nombre de secondes supérieur ou égal à 1");
      break;
    case "amount":
      if (!/^\d+(\.\d+)?$/.test(raw) || Number(raw) <= 0) throw bad("un montant positif à point décimal, sans devise (ex. 2.50)");
      break;
    case "enum":
      if (!def.enumValues?.includes(raw)) throw bad(`l'une des valeurs ${def.enumValues?.join(", ")}`);
      break;
    case "list":
      if (def.enumValues) for (const item of splitList(raw)) if (!def.enumValues.includes(item)) throw bad(`une liste parmi ${def.enumValues.join(", ")}`);
      break;
    default:
      break;
  }
}

export function parseCommandLine(argv: readonly string[]): ParsedCommandLine {
  const options: OptionValueMap = new Map();
  const positionals: string[] = [];
  let endOfOptions = false;

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (endOfOptions || !token.startsWith("--") || token === "--") {
      if (token === "--" && !endOfOptions) {
        endOfOptions = true; // FA-06
        continue;
      }
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    const inline = eq === -1 ? undefined : token.slice(eq + 1);
    const def = OPTION_BY_NAME.get(name);
    if (!def) {
      const near = suggest(name, [...OPTION_BY_NAME.keys()].filter((n) => !OPTION_BY_NAME.get(n)!.hidden));
      throw new CliUsageError(`Option inconnue : --${name}.${near[0] ? ` Vouliez-vous dire --${near[0]} ?` : ""}`);
    }
    let value: string | true;
    if (def.value === "none") {
      if (inline !== undefined) throw new CliUsageError(`L'option --${name} n'accepte pas de valeur.`);
      value = true;
    } else if (def.value === "optional") {
      // An optional value is only accepted in the `--name=value` form, so that a request is never taken as a value.
      value = inline ?? true;
    } else {
      if (inline !== undefined) value = inline;
      else {
        const next = argv[i + 1];
        if (next === undefined) throw new CliUsageError(`Valeur manquante pour --${name} : forme attendue --${name} <${def.type ?? "valeur"}>.`);
        value = next;
        i++;
      }
    }
    if (typeof value === "string") checkValue(def, value);
    if (def.repeatable) {
      const prev = options.get(name);
      const list = Array.isArray(prev) ? prev : [];
      list.push(...(typeof value === "string" ? (def.type === "rules" || def.type === "list" ? splitList(value) : [value]) : []));
      options.set(name, list);
    } else {
      options.set(name, value); // the last occurrence wins
    }
  }

  // Incompatibilities first (FA-03, ERR-03), before any availability check.
  if (options.has("dry-run") && !options.has("restore-files")) {
    throw new CliUsageError("La simulation n'est disponible que pour la restauration de fichiers (--restore-files).");
  }
  for (const [a, b] of CONFLICTS) {
    if (options.has(a) && options.has(b)) throw new CliUsageError(`--${a} et --${b} ne peuvent pas être utilisées ensemble.`);
  }
  for (const [a, b] of REQUIRES) {
    if (options.has(a) && !options.has(b)) throw new CliUsageError(`--${a} ne peut pas être utilisée sans --${b}.`);
  }

  // Positionals: a family name starts a sub-command; otherwise a single request (ERR-05).
  const first = positionals[0];
  if (first !== undefined && FAMILIES.includes(first)) {
    return { options, subcommand: { family: first, operation: positionals[1], args: positionals.slice(2) } };
  }
  if (positionals.length > 1) {
    // Several positionals can only be a sub-command: an unknown family gets a suggestion (gap E-031).
    const near = first !== undefined && /^[a-z][a-z-]*$/.test(first) ? suggest(first, FAMILIES) : [];
    if (near[0]) throw new CliUsageError(`Commande inconnue : ${first}. Vouliez-vous dire ${near[0]} ?`);
    throw new CliUsageError("Une seule demande initiale est acceptée (mettez-la entre guillemets).");
  }
  return { options, prompt: first };
}

/** Options given on the command line whose feature is not delivered in this version. */
export function undeliveredOptions(parsed: ParsedCommandLine): string[] {
  const out: string[] = [];
  for (const [name, value] of parsed.options) {
    const def = OPTION_BY_NAME.get(name)!;
    if (!def.delivered) out.push(`--${name}`);
    else if (def.deliveredValues && typeof value === "string" && !def.deliveredValues.includes(value)) out.push(`--${name} ${value}`);
  }
  return out;
}

export function dangerOptions(parsed: ParsedCommandLine): string[] {
  return [...parsed.options.keys()].filter((n) => OPTION_BY_NAME.get(n)?.danger).map((n) => `--${n}`);
}
