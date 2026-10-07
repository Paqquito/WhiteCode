// Implements: SPEC-IHM-003 (§ 5.1 elements, § 5.2 progressive rendering, § 5.3 tables, FA-01 to FA-05, EF-01 to EF-07, ERR-01 to ERR-03, RG-01 to RG-03, ENF-02, CA-01 to CA-05), SPEC-IHM-002 (FA-02, EF-07 wide tables and code scroll instead of being deformed)
// Rendering of the light rich text of the answers: headings, paragraphs, emphasis, lists, task lists, quotes, inline code,
// code blocks (coloured), tables, links, separators, images. A content still being produced is rendered by its probable
// intention; finished blocks are cached, so a new fragment only parses the end of the text. A syntax not understood stays
// visible as plain text; no external content becomes interactive.

import { highlight, detectLanguage, type HighlightOptions } from "./highlight";
import { box, layoutNode, text, type LayoutContext, type Laid, type Node } from "./layout";
import type { Style, UnicodeLevel } from "./style";
import { blank, spansToLines, wrapLine, type Cell, type Span } from "./text";

export interface MarkdownOptions {
  readonly enabled: boolean;
  readonly maxRenderedChars: number;
  readonly maxNestingLevel: number;
  /** `ui.wrapTables`: wide tables wrap in their cells instead of scrolling. */
  readonly wrapTables: boolean;
  readonly highlight: HighlightOptions;
  readonly extraLanguages?: Readonly<Record<string, string>>;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)?.*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
const RULE = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
const QUOTE = /^ {0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

const MARKS: Readonly<Record<UnicodeLevel, { bullets: readonly string[]; quote: string; rule: string; done: string; todo: string; col: string; cross: string }>> = {
  full: { bullets: ["•", "◦", "▪"], quote: "│", rule: "─", done: "☑", todo: "☐", col: "│", cross: "┼" },
  restricted: { bullets: ["•", "-", "*"], quote: "|", rule: "-", done: "[x]", todo: "[ ]", col: "|", cross: "+" },
  ascii: { bullets: ["*", "-", "+"], quote: "|", rule: "-", done: "[x]", todo: "[ ]", col: "|", cross: "+" },
};

// ---- Inline -------------------------------------------------------------------------------------------------------------

/** § 5.1 inline elements; an unclosed mark is literal text (FA-02, EF-03). */
export function inline(source: string, base: Style = {}): Span[] {
  const out: Span[] = [];
  let plain = "";
  const flush = () => {
    if (plain) out.push({ text: plain, style: Object.keys(base).length ? base : undefined });
    plain = "";
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i]!;
    const rest = source.slice(i);
    if (c === "\\" && /^\\[\\`*_{}[\]()#+\-.!~|>]/.test(rest)) {
      plain += rest[1];
      i += 2;
      continue;
    }
    if (c === "`") {
      const ticks = /^`+/.exec(rest)![0];
      const end = source.indexOf(ticks, i + ticks.length);
      if (end !== -1) {
        flush();
        out.push({ text: source.slice(i + ticks.length, end), style: { ...base, inverse: true } });
        i = end + ticks.length;
        continue;
      }
    }
    const image = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (image) {
      // § 5.1, ERR-03: no image is loaded; its alternative text and its address stay.
      flush();
      out.push({ text: `[image : ${image[1] || "sans description"}]`, style: { ...base, italic: true } }, { text: ` ${image[2]}`, style: { ...base, dim: true } });
      i += image[0].length;
      continue;
    }
    const link = /^\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest);
    if (link) {
      // The text of the link is marked and its real address always shown (§ 12): nothing becomes interactive (EF-07).
      flush();
      out.push(...inline(link[1]!, { ...base, underline: true }));
      if (link[2] !== link[1]) out.push({ text: ` (${link[2]})`, style: { ...base, dim: true } });
      i += link[0].length;
      continue;
    }
    const auto = /^<((?:https?|mailto):[^>\s]+)>/.exec(rest);
    if (auto) {
      flush();
      out.push({ text: auto[1]!, style: { ...base, underline: true } });
      i += auto[0].length;
      continue;
    }
    const pair = (["**", "__", "~~", "*", "_"] as const).find((m) => rest.startsWith(m));
    if (pair) {
      // `_` only at the edge of a word, so that snake_case stays as it is.
      const wordBefore = /\w/.test(source[i - 1] ?? "");
      const end = rest.length > pair.length ? source.indexOf(pair, i + pair.length) : -1;
      const inner = end > i + pair.length ? source.slice(i + pair.length, end) : "";
      const ok = end !== -1 && inner.trim() === inner && inner !== "" && !(pair.startsWith("_") && (wordBefore || /\w/.test(source[end + pair.length] ?? "")));
      if (ok) {
        flush();
        const style: Style = pair === "**" || pair === "__" ? { ...base, bold: true } : pair === "~~" ? { ...base, strike: true } : { ...base, italic: true };
        out.push(...inline(inner, style));
        i = end + pair.length;
        continue;
      }
    }
    plain += c;
    i++;
  }
  flush();
  return out;
}

// ---- Blocks -------------------------------------------------------------------------------------------------------------

type Block =
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "paragraph"; readonly lines: readonly string[] }
  | { readonly kind: "code"; readonly lang?: string; readonly lines: readonly string[]; readonly closed: boolean; readonly fence: string }
  | { readonly kind: "rule" }
  | { readonly kind: "quote"; readonly lines: readonly string[] }
  | { readonly kind: "list"; readonly lines: readonly string[] }
  | { readonly kind: "table"; readonly lines: readonly string[] }
  | { readonly kind: "blank" };

/** Splits lines into blocks; returns also the index of the first line of the last block (still open while producing). */
function parseBlocks(lines: readonly string[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || ITEM.test(l);
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1]!;
      const body: string[] = [];
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        if (new RegExp(`^ {0,3}${mark[0] === "`" ? "`" : "~"}{${mark.length},}\\s*$`).test(lines[j]!)) {
          closed = true;
          j++;
          break;
        }
        body.push(lines[j]!);
      }
      blocks.push({ kind: "code", lang: fence[2] || undefined, lines: body, closed, fence: mark }); // § 5.2 point 3: an open block
      i = j;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2] ?? "" });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i]!.trim() !== "" && (QUOTE.test(lines[i]!) || !startsBlock(lines[i]!))) body.push(QUOTE.exec(lines[i]!)?.[1] ?? lines[i]!.trim()), i++;
      blocks.push({ kind: "quote", lines: body });
      continue;
    }
    if (ITEM.test(line)) {
      const body: string[] = [];
      while (i < lines.length && (lines[i]!.trim() === "" ? i + 1 < lines.length && (ITEM.test(lines[i + 1]!) || /^\s{2,}\S/.test(lines[i + 1]!)) : ITEM.test(lines[i]!) || /^\s+\S/.test(lines[i]!) || !startsBlock(lines[i]!))) {
        body.push(lines[i]!);
        i++;
      }
      blocks.push({ kind: "list", lines: body });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]!) && lines[i + 1]!.includes("-")) {
      const body = [line, lines[i + 1]!];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim() !== "") body.push(lines[i++]!);
      blocks.push({ kind: "table", lines: body });
      continue;
    }
    const body: string[] = [];
    while (i < lines.length && lines[i]!.trim() !== "" && (body.length === 0 || !startsBlock(lines[i]!))) {
      // A table that starts after a paragraph line.
      if (body.length > 0 && lines[i]!.includes("|") && TABLE_SEPARATOR.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) break;
      body.push(lines[i++]!);
    }
    blocks.push({ kind: "paragraph", lines: body });
  }
  return blocks;
}

function tableCells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

const lineOf = (spans: readonly Span[]): Cell[] => spansToLines(spans).flat();

/** § 5.3: columns sized by their content, aligned with double-width characters (EF-05), wrapped or scrolled when too wide. */
function tableNode(lines: readonly string[], o: MarkdownOptions): Node {
  return {
    kind: "render",
    render: (width: number, ctx: LayoutContext): Laid => {
      const m = MARKS[ctx.unicode];
      const header = tableCells(lines[0]!);
      const aligns = tableCells(lines[1]!).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
      const n = header.length;
      // ERR-02: rows with another number of cells are padded or cut, the alignment kept.
      const rows = lines.slice(2).map((l) => {
        const cells = tableCells(l);
        return Array.from({ length: n }, (_, k) => cells[k] ?? "");
      });
      const render = (cells: readonly string[], head: boolean) => cells.map((c) => lineOf(inline(c, head ? { bold: true } : {})));
      const all = [render(header, true), ...rows.map((r) => render(r, false))];
      const natural = Array.from({ length: n }, (_, k) => Math.max(1, ...all.map((r) => r[k]!.length)));
      const sep = 3;
      const total = natural.reduce((a, b) => a + b, 0) + sep * (n - 1);
      let widths = natural;
      if (total > width && o.wrapTables) {
        const free = Math.max(n, width - sep * (n - 1));
        const sum = natural.reduce((a, b) => a + b, 0);
        widths = natural.map((w) => Math.max(Math.min(w, 6), Math.floor((w * free) / sum)));
      }
      const out: Cell[][] = [];
      const colCell = lineOf([{ text: ` ${m.col} `, style: { dim: true } }]);
      const emit = (row: readonly Cell[][]) => {
        const wrapped = row.map((cell, k) => (cell.length > widths[k]! ? wrapLine(cell, widths[k]!) : [cell]));
        const height = Math.max(...wrapped.map((w) => w.length));
        for (let r = 0; r < height; r++) {
          const line: Cell[] = [];
          wrapped.forEach((w, k) => {
            const content = w[r] ?? [];
            const free = Math.max(0, widths[k]! - content.length);
            const left = aligns[k] === "right" ? free : aligns[k] === "center" ? Math.floor(free / 2) : 0;
            if (k > 0) line.push(...colCell);
            line.push(...Array.from({ length: left }, () => blank()), ...content, ...Array.from({ length: free - left }, () => blank()));
          });
          out.push(line);
        }
      };
      emit(all[0]!);
      out.push(lineOf([{ text: widths.map((w) => m.rule.repeat(w)).join(`${m.rule}${m.cross}${m.rule}`), style: { dim: true } }]));
      for (const r of all.slice(1)) emit(r);
      // FA-02, EF-07: a table wider than the screen is never deformed; its hidden part is marked (horizontal scroll).
      return { lines: out.map((l) => (l.length > width ? [...l.slice(0, width - 1), ...lineOf([{ text: ctx.unicode === "full" ? "▸" : ">", style: { dim: true } }])] : l)) };
    },
  };
}

function ruleNode(): Node {
  return { kind: "render", render: (width, ctx) => ({ lines: [lineOf([{ text: MARKS[ctx.unicode].rule.repeat(width), style: { dim: true } }])] }) };
}

/** A block with a mark column (list items, quotes). */
const marked = (mark: Span[], markWidth: number, body: Node): Node => box([box([text(mark)], { width: markWidth }), box([body], { width: "grow" })], { direction: "row" });

export class MarkdownRenderer {
  readonly #o: MarkdownOptions;
  readonly #unicode: UnicodeLevel;
  /** Rendered blocks by source, reused while the content grows (ENF-02). */
  #cache = new Map<string, Node>();
  /** Stable prefix: the lines before the last blank line outside a code block, and their blocks. */
  #stable: { text: string; nodes: Node[] } = { text: "", nodes: [] };

  constructor(o: MarkdownOptions, unicode: UnicodeLevel) {
    this.#o = o;
    this.#unicode = unicode;
  }

  /** The tree of a content, complete or still being produced (§ 5.2). */
  render(source: string): Node {
    if (!this.#o.enabled) return text(source);
    let content = source;
    const tail: Node[] = [];
    if (content.length > this.#o.maxRenderedChars) {
      content = content.slice(0, this.#o.maxRenderedChars);
      tail.push(text([{ text: "… Contenu tronqué à l'affichage.", style: { dim: true, italic: true } }])); // ERR-01
    }
    // ENF-02: the stable prefix of the previous fragment is not parsed again.
    let nodes: Node[] = [];
    let rest = content;
    if (this.#stable.text !== "" && content.startsWith(this.#stable.text)) {
      nodes = [...this.#stable.nodes];
      rest = content.slice(this.#stable.text.length);
    }
    const lines = rest.split("\n");
    const blocks = parseBlocks(lines);
    const rendered = blocks.map((b) => this.#cached(b));
    // The new stable prefix ends at the last blank line outside an open code block.
    const lastBlank = blocks.map((b) => b.kind).lastIndexOf("blank");
    const openCode = blocks.some((b, k) => k > lastBlank && b.kind === "code" && !b.closed);
    if (lastBlank > 0 && !openCode) {
      let consumed = 0;
      let seen = 0;
      // Lines covered by the blocks up to the blank line.
      const covered = countLines(blocks.slice(0, lastBlank + 1));
      for (const l of lines.slice(0, covered)) consumed += l.length + 1;
      seen = covered;
      if (seen > 0) this.#stable = { text: content.slice(0, content.length - rest.length) + rest.slice(0, consumed), nodes: [...nodes, ...rendered.slice(0, lastBlank + 1)] };
    }
    if (this.#cache.size > 2_000) this.#cache = new Map();
    return box([...nodes, ...rendered, ...tail].filter((n): n is Node => n !== undefined));
  }

  #cached(b: Block): Node {
    const key = JSON.stringify(b);
    let n = this.#cache.get(key);
    if (!n) {
      n = this.#block(b, 0);
      this.#cache.set(key, n);
    }
    return n;
  }

  #block(b: Block, depth: number): Node {
    const m = MARKS[this.#unicode];
    switch (b.kind) {
      case "blank":
        return text("");
      case "rule":
        return ruleNode();
      case "heading": {
        // The hierarchy shows by the style and the indentation, never by colour alone (§ 5.1, EF-04, CA-05).
        const style: Style = b.level === 1 ? { bold: true, underline: true } : b.level === 2 ? { bold: true } : b.level === 3 ? { bold: true, italic: true } : { italic: true };
        const indent = Math.max(0, b.level - 3) * 2;
        return box([text(inline(b.text, style))], { padding: { left: indent } });
      }
      case "paragraph":
        return text(inline(b.lines.map((l) => l.trim()).join(" ")));
      case "code": {
        // § 5.1: framed by its fences, its language shown, coloured (SPEC-IHM-004); never wrapped (EF-07 of SPEC-IHM-002).
        const code = b.lines.join("\n");
        const lang = detectLanguage({ mark: b.lang, content: code, extra: this.#o.extraLanguages });
        const spans = highlight(code, lang, this.#o.highlight);
        return box([
          text([{ text: `${b.fence}${b.lang ?? ""}`, style: { dim: true } }]),
          ...(code === "" ? [] : [text(spans, { overflow: "scroll" })]),
          ...(b.closed ? [text([{ text: b.fence, style: { dim: true } }])] : []),
        ]);
      }
      case "quote": {
        const inner = depth + 1 >= this.#o.maxNestingLevel ? text(b.lines.join("\n")) : this.#nested(b.lines, depth + 1);
        return marked([{ text: m.quote, style: { dim: true } }], 2, inner);
      }
      case "list":
        return this.#list(b.lines, depth);
      case "table":
        return tableNode(b.lines, this.#o);
    }
  }

  #nested(lines: readonly string[], depth: number): Node {
    return box(parseBlocks(lines).map((b) => this.#block(b, depth)));
  }

  /** § 5.1: aligned bullets, indentation by level (bounded, FA-04), continuous numbering, task boxes. */
  #list(lines: readonly string[], depth: number): Node {
    const m = MARKS[this.#unicode];
    const items: Array<{ marker: string; body: string[] }> = [];
    const base = /^\s*/.exec(lines[0]!)![0].length;
    for (const l of lines) {
      const it = ITEM.exec(l);
      if (it && it[1]!.length <= base + 1) items.push({ marker: it[2]!, body: [it[3] ?? ""] });
      else items.at(-1)?.body.push(l.slice(Math.min(/^\s*/.exec(l)![0].length, base + 2)));
    }
    let number = 0;
    const rows = items.map((it) => {
      const numbered = /^\d/.test(it.marker);
      if (numbered) number = number === 0 ? Number.parseInt(it.marker, 10) : number + 1;
      let first = it.body[0]!;
      let mark = numbered ? `${number}.` : m.bullets[Math.min(depth, m.bullets.length - 1)]!;
      const task = /^\[([ xX])\]\s+/.exec(first);
      if (task) {
        mark = task[1] === " " ? m.todo : m.done;
        first = first.slice(task[0].length);
      }
      const rest = it.body.slice(1);
      const nested = rest.length > 0 && depth + 1 < this.#o.maxNestingLevel ? [this.#nested(rest, depth + 1)] : rest.length > 0 ? [text(rest.join("\n"))] : [];
      const width = [...mark].length + 1;
      return marked([{ text: mark, style: task && task[1] !== " " ? { dim: true } : undefined }], width, box([text(inline(first, task && task[1] !== " " ? { strike: false } : {})), ...nested]));
    });
    return box(rows);
  }
}

/** Number of source lines a list of blocks covers (blank blocks are one line each). */
function countLines(blocks: readonly Block[]): number {
  let n = 0;
  for (const b of blocks) {
    if (b.kind === "blank" || b.kind === "heading" || b.kind === "rule") n += 1;
    else if (b.kind === "code") n += b.lines.length + 1 + (b.closed ? 1 : 0);
    else n += b.lines.length;
  }
  return n;
}

/** The rich text as lines of cells at a width, for the tests and the views. */
export function renderMarkdown(source: string, width: number, o: MarkdownOptions, ctx: LayoutContext): Cell[][] {
  return layoutNode(new MarkdownRenderer(o, ctx.unicode).render(source), width, ctx).lines;
}
