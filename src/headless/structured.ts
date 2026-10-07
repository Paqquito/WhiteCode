// Implements: SPEC-MOD-004 (§ 5.2 steps 1 to 6, FA-01 to FA-03, EF-01 to EF-04, ERR-01 to ERR-04, RG-01, RG-02, CA-01 to CA-04, CA-06)
// Structured output: a JSON Schema given at launch, checked before any request; an instruction derived from it; the
// result extracted from the final answer and validated locally, a correction asked a bounded number of times; nothing
// that does not conform is ever emitted.

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { compileRaw, describeErrors } from "../shared/schema";

export interface OutputSchema {
  readonly schema: Record<string, unknown>;
  /** Errors of a value, empty when it conforms. */
  readonly check: (value: unknown) => string[];
}

const MAX_SCHEMA_BYTES = 256 * 1024;

function depth(v: unknown): number {
  if (v === null || typeof v !== "object") return 0;
  const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
  return 1 + Math.max(0, ...children.map(depth));
}

/**
 * Step 1, EF-01: the schema from a file or given inline, read and compiled before any call to the model. An unreadable
 * or invalid schema (ERR-01), or one too deep or too large (ERR-04), stops the run.
 */
export function loadOutputSchema(value: string, cwd: string, maxDepth: number): OutputSchema | { readonly error: string } {
  let text = value.trim();
  if (!text.startsWith("{")) {
    const path = isAbsolute(value) ? value : resolve(cwd, value);
    if (!existsSync(path)) return { error: `Schéma de sortie invalide : fichier introuvable (${path}).` };
    try {
      text = readFileSync(path, "utf8");
    } catch (e) {
      return { error: `Schéma de sortie invalide : ${(e as Error).message}.` };
    }
  }
  if (Buffer.byteLength(text, "utf8") > MAX_SCHEMA_BYTES) return { error: "Schéma trop complexe pour être garanti." };
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (e) {
    return { error: `Schéma de sortie invalide : JSON illisible (${(e as Error).message}).` };
  }
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) return { error: "Schéma de sortie invalide : un objet JSON Schema est attendu." };
  if (depth(schema) > maxDepth * 2) return { error: "Schéma trop complexe pour être garanti." }; // ERR-04 (a level of the data is two levels of the schema)
  let validate: ReturnType<typeof compileRaw>;
  try {
    validate = compileRaw(schema);
  } catch (e) {
    return { error: `Schéma de sortie invalide : ${(e as Error).message}.` };
  }
  return { schema: schema as Record<string, unknown>, check: (v) => (validate(v) ? [] : describeErrors(validate.errors, "en")) };
}

/** Step 2, EF-05: the instruction for the model; the tools stay usable during the work. */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return [
    "This run must end with a structured result. Use the tools as usual while you work.",
    "When the work is done, your final answer must be a single JSON document that conforms to the JSON Schema below: include every required field, nothing the schema does not allow, and no text outside the JSON document.",
    "<output-schema>",
    JSON.stringify(schema, null, 2),
    "</output-schema>",
  ].join("\n");
}

export interface Extracted {
  readonly value?: unknown;
  /** Text around the structured block, kept as metadata (FA-03). */
  readonly surrounding?: string;
  readonly found: boolean;
}

/** The candidate JSON blocks of a text, in order: fenced blocks, then balanced objects and arrays. */
function candidates(text: string): Array<{ start: number; end: number; body: string }> {
  const out: Array<{ start: number; end: number; body: string }> = [];
  for (const m of text.matchAll(/```(?:json)?\s*\n([\s\S]*?)\n?```/g)) out.push({ start: m.index!, end: m.index! + m[0].length, body: m[1]! });
  for (let i = 0; i < text.length; i++) {
    const open = text[i];
    if (open !== "{" && open !== "[") continue;
    const close = open === "{" ? "}" : "]";
    let d = 0;
    let inString = false;
    for (let j = i; j < text.length; j++) {
      const c = text[j]!;
      if (inString) {
        if (c === "\\") j++;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === open) d++;
      else if (c === close && --d === 0) {
        out.push({ start: i, end: j + 1, body: text.slice(i, j + 1) });
        break;
      }
    }
  }
  return out;
}

/**
 * Step 4, FA-03: the first complete structured block of the answer that conforms, the surrounding text kept apart; in
 * strict extraction, only an answer that is the JSON document alone (EF-04: never an approximate result).
 */
export function extractStructured(text: string, strict: boolean, check: (v: unknown) => string[]): Extracted & { readonly errors: string[] } {
  const trimmed = text.trim();
  const whole = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed)?.[1] ?? trimmed;
  try {
    const value = JSON.parse(whole);
    return { value, found: true, errors: check(value) };
  } catch {
    if (strict) return { found: false, errors: ["the final answer is not a JSON document alone"] };
  }
  let firstErrors: string[] | undefined;
  for (const c of candidates(text)) {
    let value: unknown;
    try {
      value = JSON.parse(c.body);
    } catch {
      continue;
    }
    const errors = check(value);
    const surrounding = `${text.slice(0, c.start)}${text.slice(c.end)}`.trim();
    if (errors.length === 0) return { value, surrounding: surrounding || undefined, found: true, errors };
    firstErrors ??= errors;
  }
  return { found: false, errors: firstErrors ?? ["no JSON document was found in the final answer"] }; // ERR-02
}

/** FA-01: the extra turn that asks for a corrected result, with the errors of the validation. */
export function correctionMessage(errors: readonly string[]): string {
  return [
    "Your final answer does not conform to the required JSON Schema:",
    ...errors.slice(0, 20).map((e) => `- ${e}`),
    "Reply with only the corrected JSON document, conforming to the schema.",
  ].join("\n");
}
