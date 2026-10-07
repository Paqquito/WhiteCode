// Implements: SPEC-IHM-002 (§ 5.1 layout model, § 5.2 wrapping, FA-02, EF-04, EF-07, ERR-03), SPEC-IHM-001 (ERR-03 narrow terminal, EF-08 deterministic image)
// Layout of a display tree into lines of cells of an exact width: boxes stacked vertically or horizontally, fixed or
// proportional sizes, margins, padding, optional border, alignment, and overflow (wrap, clip, horizontal scroll).
// The layout is a single pass: there is no constraint to solve, so no layout loop can occur (ERR-03).

import { blank, spansToCells, wrapLine, type Cell, type Span } from "./text";
import type { Style, UnicodeLevel } from "./style";

export type Size = number | "grow" | { readonly grow: number };

export interface Sides {
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly left: number;
}

export interface TextNode {
  readonly kind: "text";
  readonly spans: readonly Span[];
  /** `wrap` (default), `clip`, or `scroll`: no wrapping, shifted by `scrollX`, with markers (EF-07). */
  readonly overflow?: "wrap" | "clip" | "scroll";
  readonly scrollX?: number;
  readonly align?: "left" | "center" | "right";
  /** Caret, as an index of grapheme in the concatenated text; its position is reported by the layout. */
  readonly caret?: number;
  /** Style of the blank cells of the lines. */
  readonly fill?: Style;
}

export interface BoxNode {
  readonly kind: "box";
  readonly direction?: "column" | "row";
  /** Width inside a row: fixed, or a share of the remaining space (default: one share). */
  readonly width?: Size;
  readonly height?: number;
  readonly maxHeight?: number;
  /** Lines kept when the height is exceeded: the first ones (default) or the last ones (bottom anchoring). */
  readonly keep?: "top" | "bottom";
  readonly padding?: number | Partial<Sides>;
  readonly margin?: number | Partial<Sides>;
  readonly border?: { readonly style?: Style; readonly title?: string };
  readonly children: readonly Node[];
}

export type Node = TextNode | BoxNode;

export interface LayoutContext {
  readonly unicode: UnicodeLevel;
  /** Terminal narrower than the minimum: one column, no border, no padding (ERR-03 of SPEC-IHM-001). */
  readonly narrow: boolean;
}

export interface Laid {
  /** Lines of exactly the width given to the layout. */
  readonly lines: Cell[][];
  readonly cursor?: { readonly row: number; readonly col: number };
}

export const text = (spans: string | Span | readonly Span[], options: Omit<TextNode, "kind" | "spans"> = {}): TextNode => ({
  kind: "text",
  spans: typeof spans === "string" ? [{ text: spans }] : Array.isArray(spans) ? (spans as readonly Span[]) : [spans as Span],
  ...options,
});

export const box = (children: readonly Node[], options: Omit<BoxNode, "kind" | "children"> = {}): BoxNode => ({ kind: "box", children, ...options });

const sides = (v: number | Partial<Sides> | undefined): Sides =>
  typeof v === "number" ? { top: v, right: v, bottom: v, left: v } : { top: v?.top ?? 0, right: v?.right ?? 0, bottom: v?.bottom ?? 0, left: v?.left ?? 0 };

const BORDERS: Readonly<Record<UnicodeLevel, { tl: string; tr: string; bl: string; br: string; h: string; v: string }>> = {
  full: { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" },
  restricted: { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│" },
  ascii: { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" },
};

const SCROLL_MARKS: Readonly<Record<UnicodeLevel, { left: string; right: string }>> = {
  full: { left: "◂", right: "▸" },
  restricted: { left: "<", right: ">" },
  ascii: { left: "<", right: ">" },
};

function pad(line: Cell[], width: number, fill?: Style): Cell[] {
  if (line.length > width) return clip(line, width, fill);
  const out = line.slice();
  while (out.length < width) out.push(blank(fill));
  return out;
}

/** The first `width` cells, without cutting a double-width grapheme. */
function clip(line: readonly Cell[], width: number, fill?: Style): Cell[] {
  const out = line.slice(0, width);
  if (out.length > 0 && out[out.length - 1]!.w === 2) out[out.length - 1] = blank(fill);
  while (out.length < width) out.push(blank(fill));
  return out;
}

const cellsOf = (s: string, style?: Style): Cell[] => spansToCells([{ text: s, style }]).lines[0] ?? [];

function layoutText(node: TextNode, width: number, ctx: LayoutContext): Laid {
  const { lines: source, marks } = spansToCells(node.spans);
  const caretMark = node.caret !== undefined ? marks[Math.max(0, Math.min(node.caret, marks.length - 1))] : undefined;
  const out: Cell[][] = [];
  let cursor: { row: number; col: number } | undefined;
  source.forEach((line, index) => {
    const first = out.length;
    let rows: Cell[][];
    if ((node.overflow ?? "wrap") === "wrap") rows = wrapLine(line, width);
    else if (node.overflow === "clip") rows = [clip(line, width, node.fill)];
    else {
      // Horizontal scroll (FA-02, EF-07): the content is shifted, never deformed; markers show what is hidden.
      const shift = Math.max(0, Math.min(node.scrollX ?? 0, Math.max(0, line.length - width)));
      let row = line.slice(shift);
      if (row.length > 0 && row[0]!.w === 0) row = [blank(node.fill), ...row.slice(1)];
      row = clip(row, width, node.fill);
      const marks = SCROLL_MARKS[ctx.unicode];
      if (shift > 0 && width > 0) row[0] = cellsOf(marks.left, { dim: true })[0]!;
      if (line.length - shift > width && width > 0) row[width - 1] = cellsOf(marks.right, { dim: true })[0]!;
      rows = [row];
    }
    for (const r of rows) {
      const used = r.length;
      const free = Math.max(0, width - used);
      const left = node.align === "right" ? free : node.align === "center" ? Math.floor(free / 2) : 0;
      out.push(pad([...Array.from({ length: left }, () => blank(node.fill)), ...r], width, node.fill));
    }
    if (caretMark && caretMark.line === index) {
      // The caret cell is found in the wrapped rows; at the end of the line, it follows the last cell.
      const target = line[caretMark.cell];
      for (let k = 0; k < rows.length && !cursor; k++) {
        const at = target ? rows[k]!.indexOf(target) : -1;
        if (at !== -1) cursor = { row: first + k, col: at };
      }
      if (!cursor) {
        const last = rows.length - 1;
        const col = Math.min(rows[last]!.length, Math.max(0, width - 1));
        cursor = { row: first + last, col };
      }
    }
  });
  return { lines: out, cursor };
}

function layoutBox(node: BoxNode, width: number, ctx: LayoutContext): Laid {
  const margin = sides(node.margin);
  const border = node.border && !ctx.narrow ? 1 : 0;
  const padding = ctx.narrow ? sides(0) : sides(node.padding);
  const innerWidth = Math.max(1, width - margin.left - margin.right - 2 * border - padding.left - padding.right);
  const direction = ctx.narrow ? "column" : (node.direction ?? "column");
  let content: Cell[][] = [];
  let cursor: { row: number; col: number } | undefined;

  if (direction === "column") {
    for (const child of node.children) {
      const laid = layoutNode(child, innerWidth, ctx);
      if (laid.cursor && !cursor) cursor = { row: content.length + laid.cursor.row, col: laid.cursor.col };
      content.push(...laid.lines);
    }
  } else {
    const widths = allocate(node.children, innerWidth);
    const laid = node.children.map((child, i) => layoutNode(child, widths[i]!, ctx));
    const height = Math.max(0, ...laid.map((l) => l.lines.length));
    let offset = 0;
    laid.forEach((l, i) => {
      if (l.cursor && !cursor) cursor = { row: l.cursor.row, col: offset + l.cursor.col };
      offset += widths[i]!;
    });
    for (let r = 0; r < height; r++) content.push(laid.flatMap((l, i) => l.lines[r] ?? pad([], widths[i]!)));
  }

  // Height: fixed or bounded, keeping the first or the last lines.
  const limit = node.height ?? node.maxHeight;
  if (limit !== undefined && content.length > limit) {
    const drop = content.length - limit;
    if (node.keep === "bottom") {
      content = content.slice(drop);
      if (cursor) cursor = cursor.row >= drop ? { row: cursor.row - drop, col: cursor.col } : undefined;
    } else {
      content = content.slice(0, limit);
      if (cursor && cursor.row >= limit) cursor = undefined;
    }
  }
  if (node.height !== undefined) while (content.length < node.height) content.push(pad([], innerWidth));

  const lines: Cell[][] = [];
  const outerWidth = innerWidth + 2 * border + padding.left + padding.right;
  const b = BORDERS[ctx.unicode];
  const bs = node.border?.style;
  const marginLeft = Array.from({ length: margin.left }, () => blank());
  const wrap = (row: Cell[]) => pad([...marginLeft, ...row], width);
  for (let i = 0; i < margin.top; i++) lines.push(pad([], width));
  if (border) {
    const title = node.border?.title ? cellsOf(` ${node.border.title} `, bs).slice(0, Math.max(0, outerWidth - 4)) : [];
    const top = [...cellsOf(b.tl, bs), ...cellsOf(b.h, bs), ...title];
    while (top.length < outerWidth - 1) top.push(cellsOf(b.h, bs)[0]!);
    top.push(cellsOf(b.tr, bs)[0]!);
    lines.push(wrap(top));
  }
  const side = border ? cellsOf(b.v, bs) : [];
  const padRow = (row: Cell[]) => [...side, ...Array.from({ length: padding.left }, () => blank()), ...pad(row, innerWidth), ...Array.from({ length: padding.right }, () => blank()), ...side];
  for (let i = 0; i < padding.top; i++) lines.push(wrap(padRow([])));
  const contentTop = lines.length;
  for (const row of content) lines.push(wrap(padRow(row)));
  for (let i = 0; i < padding.bottom; i++) lines.push(wrap(padRow([])));
  if (border) lines.push(wrap([...cellsOf(b.bl, bs), ...Array.from({ length: outerWidth - 2 }, () => cellsOf(b.h, bs)[0]!), ...cellsOf(b.br, bs)]));
  for (let i = 0; i < margin.bottom; i++) lines.push(pad([], width));
  return {
    lines,
    cursor: cursor ? { row: contentTop + cursor.row, col: margin.left + border + padding.left + cursor.col } : undefined,
  };
}

/** Widths of the children of a row: fixed sizes first, the rest shared in proportion to the shares. */
function allocate(children: readonly Node[], width: number): number[] {
  const sizes = children.map((c) => (c.kind === "box" ? (c.width ?? "grow") : "grow"));
  const fixed = sizes.reduce<number>((s, v) => s + (typeof v === "number" ? v : 0), 0);
  const shares = sizes.map((v) => (typeof v === "number" ? 0 : v === "grow" ? 1 : v.grow));
  const totalShares = shares.reduce((s, v) => s + v, 0);
  const free = Math.max(0, width - fixed);
  const out = sizes.map((v, i) => (typeof v === "number" ? Math.min(v, width) : totalShares > 0 ? Math.floor((free * shares[i]!) / totalShares) : 0));
  // The remainder of the division goes to the last proportional child.
  const last = shares.map((s, i) => (s > 0 ? i : -1)).filter((i) => i >= 0).pop();
  const used = out.reduce((s, v) => s + v, 0);
  if (last !== undefined && used < width) out[last]! += width - used;
  return out;
}

/** Lays `node` out in `width` columns; deterministic for a given tree, width and context (EF-08 of SPEC-IHM-001). */
export function layoutNode(node: Node, width: number, ctx: LayoutContext): Laid {
  const w = Math.max(1, width);
  return node.kind === "text" ? layoutText(node, w, ctx) : layoutBox(node, w, ctx);
}
