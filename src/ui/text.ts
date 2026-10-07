// Implements: SPEC-IHM-001 (§ 5.3 character width, EF-04, RG-01 escaping of control sequences, ERR-04, CA-03, CA-06), SPEC-IHM-002 (§ 5.2 wrapping, EF-04)
// Text to cells: every external content is escaped before it can reach the terminal; widths are computed per grapheme
// (double width, zero width, composed sequences) and cached; wrapping follows word boundaries and never splits a cell.

import { graphemeWidth } from "../platform/text-width";
import { styleKey, type Style } from "./style";

/** One display position: a grapheme and its attributes. A double-width grapheme is followed by a continuation cell. */
export interface Cell {
  readonly ch: string;
  /** 1 or 2 for a grapheme; 0 for the continuation of a double-width grapheme. */
  readonly w: 0 | 1 | 2;
  readonly style?: Style;
  /** `styleKey(style)`, kept to compare cells quickly. */
  readonly key: string;
}

export type Line = readonly Cell[];

export interface Span {
  readonly text: string;
  readonly style?: Style;
}

const TAB_WIDTH = 4;
/** Bidirectional controls able to hide the real order of a text (SPEC-IHM-005 § 12): always shown. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/;

/**
 * Escapes the control characters of a content (RG-01, ERR-04): C0 controls and DEL in caret notation, C1 controls and
 * bidirectional controls by their code. Line breaks are kept when asked; a carriage return before a line break is dropped;
 * tabs become spaces.
 */
export function sanitize(text: string, keepNewlines = true): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0a && keepNewlines) out += "\n";
    else if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a && keepNewlines) continue;
    else if (c === 0x09) out += " ".repeat(TAB_WIDTH);
    else if (c < 0x20) out += `^${String.fromCharCode(c + 0x40)}`;
    else if (c === 0x7f) out += "^?";
    else if (c >= 0x80 && c <= 0x9f) out += `<U+${c.toString(16).toUpperCase().padStart(4, "0")}>`;
    else if (BIDI_CONTROLS.test(text[i]!)) out += `<U+${c.toString(16).toUpperCase().padStart(4, "0")}>`;
    else out += text[i];
  }
  return out;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const widthCache = new Map<string, number>();
const WIDTH_CACHE_LIMIT = 10_000;

/** Width of one grapheme, cached (§ 5.3). */
export function widthOf(grapheme: string): number {
  if (grapheme.length === 1) {
    const c = grapheme.charCodeAt(0);
    if (c >= 0x20 && c < 0x7f) return 1;
  }
  let w = widthCache.get(grapheme);
  if (w === undefined) {
    w = graphemeWidth(grapheme);
    if (widthCache.size >= WIDTH_CACHE_LIMIT) widthCache.clear();
    widthCache.set(grapheme, w);
  }
  return w;
}

export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const s of segmenter.segment(text)) out.push(s.segment);
  return out;
}

/** Display width of a text (escaped first). */
export function textWidth(text: string): number {
  let w = 0;
  for (const g of graphemes(sanitize(text, false))) w += widthOf(g);
  return w;
}

export function blank(style?: Style): Cell {
  return { ch: " ", w: 1, style, key: styleKey(style) };
}

/** Position of a source grapheme in the cells: its line and its first cell. */
export interface Mark {
  readonly line: number;
  readonly cell: number;
}

/**
 * Cells of styled spans, line by line (a line break starts a new line). Each source grapheme is escaped on its own, so
 * that `marks[i]` gives where the grapheme `i` of the concatenated text starts (a line break counts as one grapheme).
 * Zero-width graphemes join the previous cell; a double-width grapheme takes two cells.
 */
export function spansToCells(spans: readonly Span[]): { lines: Cell[][]; marks: Mark[] } {
  const lines: Cell[][] = [[]];
  const marks: Mark[] = [];
  for (const span of spans) {
    const key = styleKey(span.style);
    for (const source of graphemes(span.text)) {
      const line = lines[lines.length - 1]!;
      marks.push({ line: lines.length - 1, cell: line.length });
      if (source === "\n" || source === "\r\n") {
        lines.push([]);
        continue;
      }
      for (const g of graphemes(sanitize(source, false))) {
        const w = widthOf(g);
        if (w === 0) {
          const prev = line.length - 1;
          if (prev >= 0) {
            const p = line[prev]!.w === 0 && prev > 0 ? prev - 1 : prev;
            line[p] = { ...line[p]!, ch: line[p]!.ch + g };
          }
          continue;
        }
        line.push({ ch: g, w: w as 1 | 2, style: span.style, key });
        if (w === 2) line.push({ ch: "", w: 0, style: span.style, key });
      }
    }
  }
  marks.push({ line: lines.length - 1, cell: lines[lines.length - 1]!.length });
  return { lines, marks };
}

export function spansToLines(spans: readonly Span[]): Cell[][] {
  return spansToCells(spans).lines;
}

/** Width of a line in columns. */
export function lineWidth(line: Line): number {
  return line.length;
}

/**
 * Wraps one line of cells to `width` columns (§ 5.2, EF-04): at word boundaries; a word longer than the width is cut
 * between graphemes; a double-width grapheme is never cut; the spaces at a break are dropped.
 */
export function wrapLine(line: Line, width: number): Cell[][] {
  const w = Math.max(1, width);
  if (line.length <= w) return [line.slice()];
  const out: Cell[][] = [];
  let current: Cell[] = [];
  let i = 0;
  /** True right after a break caused by the width: the spaces that follow are dropped. */
  let atBreak = false;
  const flush = () => {
    while (current.length > 0 && current[current.length - 1]!.ch === " ") current.pop();
    out.push(current);
    current = [];
    atBreak = true;
  };
  while (i < line.length) {
    if (line[i]!.ch === " ") {
      // Spaces: kept inside a line, dropped at a break.
      if (!atBreak) {
        if (current.length < w) current.push(line[i]!);
        else flush();
      }
      i++;
      continue;
    }
    atBreak = false;
    let end = i;
    while (end < line.length && line[end]!.ch !== " ") end++;
    const word = line.slice(i, end);
    if (current.length + word.length <= w) {
      current.push(...word);
    } else if (word.length <= w && current.length > 0) {
      flush();
      current.push(...word);
    } else {
      // A word longer than the width: cut between graphemes, a double-width grapheme moving whole to the next line.
      for (let k = 0; k < word.length; k++) {
        const cell = word[k]!;
        const span = cell.w === 2 ? 2 : 1;
        if (cell.w === 0) continue;
        if (current.length + span > w) flush();
        current.push(cell);
        if (cell.w === 2) current.push(word[k + 1]!);
      }
    }
    atBreak = false;
    i = end;
  }
  if (current.length > 0 || out.length === 0) out.push(current);
  return out;
}

/** Plain text of a line, without its trailing spaces (what a copy gives). */
export function lineText(line: Line): string {
  return line.map((c) => c.ch).join("").replace(/\s+$/, "");
}
