// Implements: SPEC-OUT-004 (§ 5.3 matching cascade steps 1 to 4 and re-indentation rules, FA-02, FA-03, EF-01, EF-02, EF-07, RG-01 to RG-03, ERR-01, ERR-02, ERR-07)
// Supports: decision D-04 (step 5, block anchor, not implemented: the cascade stops at step 4)
// Pure functions on texts with LF line endings.

export type MatchStep = 1 | 2 | 3 | 4;

export const STEP_NAMES: Readonly<Record<MatchStep, string>> = {
  1: "exact match",
  2: "normalised quotes",
  3: "shifted indentation",
  4: "lines compared without edge whitespace",
};

export interface EditPlan {
  readonly kind: "planned";
  readonly content: string;
  readonly step: MatchStep;
  readonly count: number;
  /** First and last lines of the first replacement in the new content (1-based). */
  readonly firstLine: number;
  readonly lastLine: number;
  /** Original passage replaced (first occurrence). */
  readonly replaced: string;
}

export type EditFailure =
  | { readonly kind: "not_found"; readonly hint?: string }
  | { readonly kind: "not_unique"; readonly count: number }
  | { readonly kind: "ambiguous_approximate" };

const SINGLE_QUOTES = /[‘’‚‛]/g;
const DOUBLE_QUOTES = /[“”„‟]/g;

/** One-to-one character normalisation: indexes are preserved. */
function normaliseQuotes(text: string): string {
  return text.replace(SINGLE_QUOTES, "'").replace(DOUBLE_QUOTES, '"');
}

/** FA-03: straight quotes of the new text take the typographic style used by the original passage. */
export function adoptQuoteStyle(newText: string, passage: string): string {
  const curlyDouble = /[“”]/.test(passage);
  const curlySingle = /[‘’]/.test(passage);
  if (!curlyDouble && !curlySingle) return newText;
  let out = "";
  for (let i = 0; i < newText.length; i++) {
    const c = newText[i]!;
    const before = i === 0 ? "" : newText[i - 1]!;
    const opening = before === "" || /[\s([{—-]/.test(before);
    if (c === '"' && curlyDouble) out += opening ? "“" : "”";
    else if (c === "'" && curlySingle) out += opening ? "‘" : "’";
    else out += c;
  }
  return out;
}

function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (needle === "") return found;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return found;
    found.push(at);
    from = at + needle.length;
  }
}

function lineOf(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function linesIn(text: string): number {
  return text === "" ? 1 : text.split("\n").length;
}

/** Replaces the passages at `positions` (length `length`) with `replacement(passage)`; returns the plan. */
function replaceAt(file: string, positions: readonly number[], length: number, replacement: (passage: string) => string, step: MatchStep): EditPlan {
  let content = "";
  let last = 0;
  let firstStart = 0;
  let firstReplacement = "";
  positions.forEach((at, index) => {
    const passage = file.slice(at, at + length);
    const r = replacement(passage);
    if (index === 0) {
      firstStart = content.length + (at - last);
      firstReplacement = r;
    }
    content += file.slice(last, at) + r;
    last = at + length;
  });
  content += file.slice(last);
  const firstLine = lineOf(content, firstStart);
  const at0 = positions[0]!;
  return {
    kind: "planned",
    content,
    step,
    count: positions.length,
    firstLine,
    lastLine: firstLine + linesIn(firstReplacement) - 1,
    replaced: file.slice(at0, at0 + length),
  };
}

const isBlank = (line: string) => line.trim() === "";
const indentOf = (line: string) => /^[ \t]*/.exec(line)![0];

function mixesTabsAndSpaces(lines: readonly string[]): boolean {
  const chars = new Set(lines.filter((l) => !isBlank(l)).flatMap((l) => [...indentOf(l)]));
  return chars.has("\t") && chars.has(" ");
}

function indentChars(lines: readonly string[]): Set<string> {
  return new Set(lines.filter((l) => !isBlank(l)).flatMap((l) => [...indentOf(l)]));
}

/** Common refusals of steps 3 and 4 (re-indentation rules). */
function indentationRefused(passage: readonly string[], newLines: readonly string[]): boolean {
  if (mixesTabsAndSpaces(passage) || mixesTabsAndSpaces(newLines)) return true;
  const a = indentChars(passage);
  const b = indentChars(newLines);
  return a.size > 0 && b.size > 0 && [...b].some((c) => !a.has(c));
}

/** Replaces the prefix `from` by `to` on each non-empty line; undefined when a line does not start with `from`. */
function reindent(lines: readonly string[], from: string, to: string): string[] | undefined {
  const out: string[] = [];
  for (const line of lines) {
    if (isBlank(line)) out.push("");
    else if (!line.startsWith(from)) return undefined;
    else out.push(to + line.slice(from.length));
  }
  return out;
}

interface LineWindow {
  readonly start: number;
  readonly prefix: string;
}

/** Step 3 candidates: each non-empty line equals the old line with its prefix O replaced by a common prefix P. */
function shiftedWindows(fileLines: readonly string[], oldLines: readonly string[]): LineWindow[] {
  const j0 = oldLines.findIndex((l) => !isBlank(l));
  const o = indentOf(oldLines[j0]!);
  if (oldLines.some((l) => !isBlank(l) && !l.startsWith(o))) return [];
  const rest0 = oldLines[j0]!.slice(o.length);
  const found: LineWindow[] = [];
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    const anchor = fileLines[i + j0]!;
    if (!anchor.endsWith(rest0)) continue;
    const p = anchor.slice(0, anchor.length - rest0.length);
    if (!/^[ \t]*$/.test(p)) continue;
    const ok = oldLines.every((l, j) => (isBlank(l) ? isBlank(fileLines[i + j]!) : fileLines[i + j] === p + l.slice(o.length)));
    if (ok) found.push({ start: i, prefix: p });
  }
  return found;
}

/** Step 4 candidates: lines equal once their edge whitespace is removed. */
function trimmedWindows(fileLines: readonly string[], oldLines: readonly string[]): LineWindow[] {
  const found: LineWindow[] = [];
  const trimmed = oldLines.map((l) => l.trim());
  for (let i = 0; i + oldLines.length <= fileLines.length; i++) {
    if (trimmed.every((t, j) => fileLines[i + j]!.trim() === t)) found.push({ start: i, prefix: "" });
  }
  return found;
}

/** Plans an edit following the cascade (EF-07). `lenient` false limits the cascade to steps 1 and 2. */
export function planEdit(file: string, oldText: string, newText: string, allOccurrences: boolean, lenient: boolean): EditPlan | EditFailure {
  // Step 1: exact match.
  const exact = occurrences(file, oldText);
  if (exact.length > 0) {
    if (exact.length > 1 && !allOccurrences) return { kind: "not_unique", count: exact.length }; // ERR-02, CA-11
    return replaceAt(file, allOccurrences ? exact : [exact[0]!], oldText.length, () => newText, 1);
  }

  // Step 2: typographic quotes (line endings are already normalised by the caller).
  const normalised = occurrences(normaliseQuotes(file), normaliseQuotes(oldText));
  if (normalised.length > 0) {
    if (normalised.length > 1 && !allOccurrences) return { kind: "not_unique", count: normalised.length };
    return replaceAt(file, allOccurrences ? normalised : [normalised[0]!], oldText.length, (passage) => adoptQuoteStyle(newText, passage), 2);
  }

  // Steps 3 and 4: never with `all_occurrences` (RG-03, CA-09), nor when lenient matching is off.
  const hint = lineNumberHint(oldText);
  if (allOccurrences || !lenient) return { kind: "not_found", hint };
  const oldTrailing = oldText.endsWith("\n");
  const newTrailing = newText.endsWith("\n");
  const oldLines = (oldTrailing ? oldText.slice(0, -1) : oldText).split("\n");
  const newLines = (newTrailing ? newText.slice(0, -1) : newText).split("\n");
  if (oldLines.every(isBlank)) return { kind: "not_found", hint };
  const fileLines = file.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;
  for (const l of fileLines) {
    lineStarts.push(offset);
    offset += l.length + 1;
  }

  const attempt = (step: 3 | 4, windows: LineWindow[]): EditPlan | EditFailure | undefined => {
    if (windows.length === 0) return undefined;
    if (windows.length > 1) return { kind: "ambiguous_approximate" }; // ERR-07, CA-08
    const w = windows[0]!;
    const passage = fileLines.slice(w.start, w.start + oldLines.length);
    if (indentationRefused(passage, newLines)) return undefined; // the step is refused: passage not found (CA-14, CA-16)
    let replacementLines: string[] | undefined;
    if (step === 3) {
      const o = indentOf(oldLines.find((l) => !isBlank(l))!);
      replacementLines = reindent(newLines, o, w.prefix);
    } else {
      const firstNew = newLines.find((l) => !isBlank(l));
      const firstPassage = passage.find((l) => !isBlank(l))!;
      replacementLines = firstNew === undefined ? newLines.map(() => "") : reindent(newLines, indentOf(firstNew), indentOf(firstPassage));
    }
    if (!replacementLines) return undefined;
    const start = lineStarts[w.start]!;
    const lastIndex = w.start + oldLines.length - 1;
    let end = lineStarts[lastIndex]! + fileLines[lastIndex]!.length;
    let replacement = replacementLines.join("\n");
    if (oldTrailing && !newTrailing && file[end] === "\n") end++; // the line break of the passage goes with it
    if (newTrailing && !oldTrailing) replacement += "\n";
    return replaceAt(file, [start], end - start, () => replacement, step);
  };

  const shifted = attempt(3, shiftedWindows(fileLines, oldLines));
  if (shifted) return shifted;
  const trimmed = attempt(4, trimmedWindows(fileLines, oldLines));
  if (trimmed) return trimmed;
  // Step 5 (block anchor) is not implemented in this version (decision D-04).
  return { kind: "not_found", hint };
}

/** Line numbers copied from `read_file` by mistake (edge case of § 8). */
function lineNumberHint(oldText: string): string | undefined {
  // D-4 (decision D-20): line breaks escaped twice in the JSON arrive as the two characters `\` and `n`.
  if (!oldText.includes("\n") && /\\n/.test(oldText)) {
    return "old_text contains the two characters \\n instead of real line breaks (the text was escaped twice): send real line breaks in old_text and new_text.";
  }
  const lines = oldText.split("\n").filter((l) => l.trim() !== "");
  return lines.length > 0 && lines.every((l) => /^\s*\d+\t/.test(l))
    ? "old_text seems to start with line numbers copied from read_file: remove the number and the tab that follows it on each line."
    : undefined;
}
