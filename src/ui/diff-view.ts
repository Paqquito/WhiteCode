// Implements: SPEC-IHM-005 (§ 5.1 content, § 5.2 stacked or side by side, § 5.3 highlighting and intraline, § 5.4 sections, § 5.5 special cases, FA-01 to FA-05, EF-01 to EF-07, ERR-01, ERR-02, RG-01 to RG-03, CA-01 to CA-04, CA-06)
// Presentation of a change of a file: the file, the counts of added and removed lines, the sections with their position,
// each line with its mark (readable without colour), its numbers in the real file and its content, coloured when the
// language is known, the changed parts of a line highlighted. Invisible changes are named; a long difference is cut
// with a clear account of what is not shown.

import { diffLines, hunksOf, type DiffOp, type FileChange } from "../shared/diff";
import { detectLanguage, highlight, type HighlightOptions } from "./highlight";
import type { Laid, LayoutContext, Node } from "./layout";
import type { Style } from "./style";
import { blank, sanitize, spansToLines, wrapLine, type Cell, type Span } from "./text";

export type { FileChange };

export interface DiffOptions {
  readonly contextLines: number;
  /** `auto`, `side-by-side` or `stacked` (§ 5.2). */
  readonly layout: string;
  readonly maxDisplayedLines: number;
  readonly intraline: boolean;
  readonly showInvisible: boolean;
  readonly highlight: HighlightOptions;
  /** FA-05: no write will take place. */
  readonly simulated?: boolean;
}

const ADD: Style = { fg: { ansi: 2 } };
const DEL: Style = { fg: { ansi: 1 } };
const CHANGED: Style = { inverse: true };
const DIM: Style = { dim: true };
/** Below this width a side-by-side presentation is not readable. */
const SIDE_BY_SIDE_MIN = 120;

const cells = (spans: readonly Span[]): Cell[] => spansToLines(spans).flat();

/** Size in a readable unit. */
function size(bytes: number | undefined): string {
  if (bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1).replace(".", ",")} Ko`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(".", ",")} Mo`;
}

/** Changed parts of a pair of lines: common prefix and suffix left out (§ 5.3). */
function changedRange(a: string, b: string): { a: [number, number]; b: [number, number] } {
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  return { a: [p, a.length - s], b: [p, b.length - s] };
}

/** Spans of a line: coloured by language, the changed range overlaid, trailing blanks made visible when asked (EF-06). */
function lineSpans(content: string, lang: string | undefined, o: DiffOptions, base: Style, range?: [number, number], showTrailing = false): Span[] {
  let spans: Span[] = highlight(content, lang, o.highlight).map((s) => ({ text: s.text, style: { ...base, ...(s.style ?? {}) } }));
  if (range && range[1] > range[0]) {
    const out: Span[] = [];
    let at = 0;
    for (const s of spans) {
      const start = at;
      const end = at + s.text.length;
      at = end;
      const a = Math.max(start, range[0]);
      const b = Math.min(end, range[1]);
      if (b <= a) {
        out.push(s);
        continue;
      }
      if (a > start) out.push({ text: s.text.slice(0, a - start), style: s.style });
      out.push({ text: s.text.slice(a - start, b - start), style: { ...s.style, ...CHANGED } });
      if (end > b) out.push({ text: s.text.slice(b - start), style: s.style });
    }
    spans = out;
  }
  if (showTrailing) {
    const trailing = /[ \t]+$/.exec(content);
    if (trailing) {
      const keep = content.length - trailing[0].length;
      const out: Span[] = [];
      let at = 0;
      for (const s of spans) {
        const end = at + s.text.length;
        if (end <= keep) out.push(s);
        else if (at < keep) out.push({ text: s.text.slice(0, keep - at), style: s.style });
        at = end;
      }
      out.push({ text: trailing[0].replace(/ /g, "·").replace(/\t/g, "→"), style: { ...base, ...CHANGED } });
      spans = out;
    }
  }
  return spans;
}

interface Row {
  readonly kind: "same" | "del" | "add";
  readonly oldNo?: number;
  readonly newNo?: number;
  readonly text: string;
  readonly range?: [number, number];
  /** The pair differs only by trailing blanks (EF-06). */
  readonly trailingOnly?: boolean;
}

/** Rows of a section: deleted and added lines paired in order, for the intraline highlighting. */
function rowsOf(ops: readonly DiffOp[], oldStart: number, newStart: number, intraline: boolean): Row[] {
  const rows: Row[] = [];
  let o = oldStart;
  let n = newStart;
  for (let i = 0; i < ops.length; ) {
    if (ops[i]!.kind === "same") {
      rows.push({ kind: "same", oldNo: o++, newNo: n++, text: ops[i]!.line });
      i++;
      continue;
    }
    const dels: string[] = [];
    const adds: string[] = [];
    while (i < ops.length && ops[i]!.kind === "del") dels.push(ops[i++]!.line);
    while (i < ops.length && ops[i]!.kind === "add") adds.push(ops[i++]!.line);
    dels.forEach((d, k) => {
      const pair = adds[k];
      const trailingOnly = pair !== undefined && d.trimEnd() === pair.trimEnd();
      rows.push({ kind: "del", oldNo: o++, text: d, range: intraline && pair !== undefined ? changedRange(d, pair).a : undefined, trailingOnly });
    });
    adds.forEach((a, k) => {
      const pair = dels[k];
      const trailingOnly = pair !== undefined && a.trimEnd() === pair.trimEnd();
      rows.push({ kind: "add", newNo: n++, text: a, range: intraline && pair !== undefined ? changedRange(pair, a).b : undefined, trailingOnly });
    });
  }
  return rows;
}

/** The view of a change; it is laid out for the width it receives (§ 5.2). */
export function diffNode(change: FileChange, o: DiffOptions): Node {
  return { kind: "render", render: (width, ctx) => renderDiff(change, o, width, ctx) };
}

export function renderDiff(change: FileChange, o: DiffOptions, width: number, ctx: LayoutContext): Laid {
  const out: Cell[][] = [];
  const push = (spans: Span[]) => out.push(...spansToLines(spans).flatMap((l) => wrapLine(l, width)));
  const path = sanitize(change.path, false); // RG-03
  const notes: string[] = [];
  if (o.simulated) notes.push("Simulation : aucune écriture n'aura lieu."); // FA-05
  // § 5.5: binary file (FA-03: a content with non-text characters is binary too).
  const binary = change.binary ?? ((change.before ?? "").includes("\u0000") || (change.after ?? "").includes("\u0000") ? { before: change.before?.length, after: change.after?.length } : undefined);
  if (binary) {
    push([{ text: path, style: { bold: true } }, { text: `  fichier binaire : ${size(binary.before)} → ${size(binary.after)}`, style: DIM }]); // CA-06
    for (const n of notes) push([{ text: n, style: DIM }]);
    return { lines: out };
  }
  const before = change.before ?? "";
  const after = change.after ?? "";
  const { ops, whole } = diffLines(before, after);
  const added = ops.filter((x) => x.kind === "add").length;
  const removed = ops.filter((x) => x.kind === "del").length;
  const kind = change.before === undefined ? "création du fichier" : change.after === undefined ? "suppression du fichier" : undefined;
  push([
    { text: path, style: { bold: true } },
    { text: `  +${added}`, style: ADD },
    { text: ` −${removed}`, style: DEL },
    ...(kind ? [{ text: `  (${kind})`, style: { bold: true } }] : []),
  ]);
  if (change.format) notes.push(`Changement invisible : ${change.format}.`); // EF-06
  if (before === after && change.before !== undefined && change.after !== undefined) notes.push("Contenu inchangé.");
  if (/[‪-‮⁦-⁩]/.test(after)) notes.push("Le nouveau contenu contient des caractères de contrôle de direction d'écriture, affichés par leur code."); // § 12
  if (whole) notes.push("Fichier trop volumineux pour une comparaison ligne à ligne : le contenu est présenté comme entièrement remplacé."); // ERR-01
  const hunks = hunksOf(ops, o.contextLines);
  const allRows = hunks.map((h) => rowsOf(h.ops, h.oldStart, h.newStart, o.intraline && !whole));
  if (o.showInvisible && allRows.some((rs) => rs.some((r) => r.trailingOnly && r.kind === "add"))) notes.push("Changement invisible : espaces de fin de ligne modifiés (marqués · et →)."); // EF-06, CA-03
  for (const n of notes) push([{ text: n, style: { italic: true } }]);
  const lang = detectLanguage({ path: change.path, content: after || before });
  const numberWidth = String(Math.max(before.split("\n").length, after.split("\n").length)).length;
  const sideBySide = o.layout === "side-by-side" || (o.layout === "auto" && width >= SIDE_BY_SIDE_MIN && !ctx.narrow);
  let shown = 0;
  let hiddenLines = 0;
  let hiddenHunks = 0;
  allRows.forEach((rows, k) => {
    const h = hunks[k]!;
    if (shown >= o.maxDisplayedLines) {
      hiddenLines += rows.filter((r) => r.kind !== "same").length;
      hiddenHunks++;
      return;
    }
    const oldCount = h.ops.filter((x) => x.kind !== "add").length;
    const newCount = h.ops.filter((x) => x.kind !== "del").length;
    push([{ text: `@@ lignes ${h.oldStart}–${h.oldStart + Math.max(0, oldCount - 1)} → ${h.newStart}–${h.newStart + Math.max(0, newCount - 1)} @@`, style: DIM }]);
    const room = o.maxDisplayedLines - shown;
    const visible = rows.slice(0, room);
    if (rows.length > room) hiddenLines += rows.slice(room).filter((r) => r.kind !== "same").length;
    shown += visible.length;
    if (sideBySide) out.push(...sideRows(visible, lang, o, width, numberWidth));
    else
      for (const r of visible) {
        const mark = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
        const base = r.kind === "add" ? ADD : r.kind === "del" ? DEL : {};
        const prefix: Span[] = [
          { text: `${r.oldNo !== undefined ? String(r.oldNo).padStart(numberWidth) : " ".repeat(numberWidth)} ${r.newNo !== undefined ? String(r.newNo).padStart(numberWidth) : " ".repeat(numberWidth)} `, style: DIM },
          { text: `${mark} `, style: { ...base, bold: r.kind !== "same" } },
        ];
        const content = lineSpans(r.text, lang, o, base, r.range, o.showInvisible && r.trailingOnly === true);
        // FA-02: a long line continues on the next lines, indented under its content.
        const pre = cells(prefix);
        const body = wrapLine(cells(content), Math.max(10, width - pre.length));
        body.forEach((line, i) => out.push([...(i === 0 ? pre : pre.map(() => blank())), ...line]));
      }
  });
  // EF-04, CA-04: what is not shown is said.
  if (hiddenLines > 0) push([{ text: `… ${hiddenLines} lignes modifiées non affichées${hiddenHunks > 0 ? ` (${hiddenHunks} section${hiddenHunks > 1 ? "s" : ""} de plus)` : ""} : ui.diff.maxDisplayedLines vaut ${o.maxDisplayedLines}.`, style: { bold: true } }]);
  return { lines: out };
}

/** § 5.2: the old content on the left, the new one on the right, the pairs side by side. */
function sideRows(rows: readonly Row[], lang: string | undefined, o: DiffOptions, width: number, numberWidth: number): Cell[][] {
  const half = Math.floor((width - 3) / 2);
  const column = (r: Row | undefined, side: "old" | "new"): Cell[] => {
    if (!r) return Array.from({ length: half }, () => blank());
    const base = r.kind === "add" ? ADD : r.kind === "del" ? DEL : {};
    const no = side === "old" ? r.oldNo : r.newNo;
    const mark = r.kind === "add" ? "+" : r.kind === "del" ? "-" : " ";
    const line = cells([{ text: `${String(no ?? "").padStart(numberWidth)} `, style: DIM }, { text: `${mark} `, style: { ...base, bold: r.kind !== "same" } }, ...lineSpans(r.text, lang, o, base, r.range, o.showInvisible && r.trailingOnly === true)]);
    const cut = line.length > half ? [...line.slice(0, half - 1), ...cells([{ text: "…", style: DIM }])] : line;
    return [...cut, ...Array.from({ length: Math.max(0, half - cut.length) }, () => blank())];
  };
  const out: Cell[][] = [];
  const sep = cells([{ text: " │ ", style: DIM }]);
  for (let i = 0; i < rows.length; ) {
    const r = rows[i]!;
    if (r.kind === "same") {
      out.push([...column(r, "old"), ...sep, ...column(r, "new")]);
      i++;
      continue;
    }
    const dels: Row[] = [];
    const adds: Row[] = [];
    while (i < rows.length && rows[i]!.kind === "del") dels.push(rows[i++]!);
    while (i < rows.length && rows[i]!.kind === "add") adds.push(rows[i++]!);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) out.push([...column(dels[k], "old"), ...sep, ...column(adds[k], "new")]);
  }
  return out;
}
