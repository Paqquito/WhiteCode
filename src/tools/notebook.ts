// Implements: SPEC-OUT-005 (§ 5.3 points 1 to 6, FA-01, EF-01 to EF-04, ERR-01 to ERR-04, RG-01, CA-01 to CA-03), SPEC-OUT-002 (§ 5.3 point 7, EF-04 notebook outputs truncated)
// Supports: gap E-046 (cell index counted from 1)

import { randomUUID } from "node:crypto";

export interface NotebookCell {
  cell_type: string;
  id?: string;
  source: string | string[];
  metadata?: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
  [key: string]: unknown;
}

export interface Notebook {
  cells: NotebookCell[];
  nbformat?: number;
  nbformat_minor?: number;
  [key: string]: unknown;
}

export function parseNotebook(text: string): Notebook | undefined {
  try {
    const nb = JSON.parse(text) as Notebook;
    return nb && typeof nb === "object" && Array.isArray(nb.cells) ? nb : undefined;
  } catch {
    return undefined;
  }
}

/** JSON indentation of the original file (§ 5.3 point 5). */
export function detectIndent(text: string): string | number {
  const m = /^\{\s*\n([ \t]+)"/.exec(text);
  return m ? m[1]! : 1;
}

export function serialiseNotebook(nb: Notebook, original: string): string {
  const out = JSON.stringify(nb, null, detectIndent(original));
  return original.endsWith("\n") ? `${out}\n` : out;
}

export function sourceText(cell: NotebookCell): string {
  return Array.isArray(cell.source) ? cell.source.join("") : String(cell.source ?? "");
}

/** Source in the form used by the notebook: a list of lines when the other cells use one. */
export function toSource(text: string, asList: boolean): string | string[] {
  if (!asList) return text;
  const lines = text.split(/(?<=\n)/);
  return lines.length === 1 && lines[0] === "" ? [] : lines;
}

/** Cell ids are part of the format from version 4.5 (FA-01). */
export function hasCellIds(nb: Notebook): boolean {
  return (nb.nbformat ?? 0) > 4 || ((nb.nbformat ?? 0) === 4 && (nb.nbformat_minor ?? 0) >= 5);
}

export function newCellId(nb: Notebook): string {
  const used = new Set(nb.cells.map((c) => c.id));
  for (;;) {
    const id = randomUUID().replace(/-/g, "").slice(0, 8);
    if (!used.has(id)) return id;
  }
}

/** Locates a cell by id, otherwise by its index counted from 1 (gap E-046). */
export function findCell(nb: Notebook, cellId: string): number | undefined {
  const byId = nb.cells.findIndex((c) => c.id === cellId);
  if (byId !== -1) return byId;
  if (/^\d+$/.test(cellId)) {
    const index = Number(cellId) - 1;
    if (index >= 0 && index < nb.cells.length) return index;
  }
  return undefined;
}

export function cellLabel(nb: Notebook, index: number): string {
  const c = nb.cells[index]!;
  return c.id ? `cell ${index + 1} (id ${c.id})` : `cell ${index + 1}`;
}

function outputText(output: unknown): string {
  const o = output as Record<string, unknown>;
  if (o["output_type"] === "stream") return Array.isArray(o["text"]) ? (o["text"] as string[]).join("") : String(o["text"] ?? "");
  if (o["output_type"] === "error") return `${String(o["ename"])}: ${String(o["evalue"])}`;
  const data = o["data"] as Record<string, unknown> | undefined;
  const plain = data?.["text/plain"];
  if (plain !== undefined) return Array.isArray(plain) ? plain.join("") : String(plain);
  if (data && Object.keys(data).some((k) => k.startsWith("image/"))) return "[image output]";
  return `[${String(o["output_type"] ?? "output")}]`;
}

/** Text rendering of a notebook for `read_file`: cells with type, source and outputs; long outputs truncated (EF-04). */
export function renderNotebook(nb: Notebook, maxOutputChars: number): { text: string; truncated: number } {
  let truncated = 0;
  const parts = nb.cells.map((cell, index) => {
    const head = `<${cellLabel(nb, index)}, ${cell.cell_type}>`;
    const lines = [head, sourceText(cell)];
    for (const output of cell.outputs ?? []) {
      let text = outputText(output);
      if (text.length > maxOutputChars) {
        truncated++;
        text = `${text.slice(0, maxOutputChars)} [… output truncated: ${text.length} characters]`;
      }
      lines.push(`[output]\n${text}`);
    }
    return lines.join("\n");
  });
  return { text: parts.join("\n\n"), truncated };
}
