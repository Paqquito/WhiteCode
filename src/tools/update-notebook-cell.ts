// Implements: SPEC-OUT-005 (§ 5.3, FA-01, EF-01 to EF-04, ERR-01 to ERR-04, RG-01, CA-01 to CA-03)
// Supports: SPEC-OUT-003 (atomic write, read precondition), SPEC-PER-010, gaps E-033, E-046

import { existsSync } from "node:fs";
import { extname } from "node:path";
import description from "../../prompts/tools/update_notebook_cell.md" with { type: "text" };
import { ambiguousPathReason, writeContribution } from "../permissions/paths";
import { isAbsolutePath } from "../platform/system";
import { unifiedDiff } from "../shared/diff";
import { cellLabel, findCell, hasCellIds, newCellId, parseNotebook, serialiseNotebook, toSource, type NotebookCell } from "./notebook";
import { decodeText, encodeText, readBytesIfExists, readPreconditionError, recordWrite, toLf, WriteFailure, writeAtomic, type TextFormat } from "./text-file";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome, type ToolPreview } from "./types";

export interface UpdateNotebookCellInput {
  readonly path: string;
  readonly cell_id?: string;
  readonly mode?: "replace" | "insert" | "delete";
  readonly cell_type?: "code" | "markdown";
  readonly source?: string;
}

type Planned = { readonly before: string; readonly after: string; readonly format: TextFormat; readonly report: string };

const refuse = (message: string): { refusal: ToolOutcome } => ({ refusal: textOutcome(message, true, "invalid_input") });

function plan(input: UpdateNotebookCellInput, ctx: ToolContext): Planned | { refusal: ToolOutcome } {
  if (!existsSync(input.path)) return refuse(`File not found: ${input.path}.`);
  const precondition = readPreconditionError(input.path, ctx, false, "edit"); // ERR-04
  if (precondition) return refuse(precondition);
  const decoded = decodeText(readBytesIfExists(input.path) ?? new Uint8Array());
  const nb = decoded ? parseNotebook(decoded.text) : undefined;
  if (!decoded || !nb) return refuse("The notebook cannot be read: its JSON is invalid."); // ERR-01
  const mode = input.mode ?? "replace";
  const asList = nb.cells.some((c) => Array.isArray(c.source)) || nb.cells.length === 0;
  const available = () => nb.cells.map((c, i) => c.id ?? String(i + 1)).join(", ");

  let index: number | undefined;
  if (input.cell_id !== undefined) {
    index = findCell(nb, input.cell_id);
    if (index === undefined) return refuse(`Cell not found: ${input.cell_id}. Available cells: ${available() || "none"}.`); // ERR-02
  } else if (mode !== "insert") return refuse("Give cell_id: the id of the cell, or its index counted from 1.");

  let report: string;
  if (mode === "insert") {
    if (!input.cell_type) return refuse("Give cell_type (code or markdown) to insert a cell."); // EF-02, ERR-03
    const cell: NotebookCell = { cell_type: input.cell_type, metadata: {}, source: toSource(input.source ?? "", asList) };
    if (hasCellIds(nb)) cell.id = newCellId(nb); // FA-01
    if (input.cell_type === "code") {
      cell.execution_count = null;
      cell.outputs = [];
    }
    const at = index === undefined ? 0 : index + 1;
    nb.cells.splice(at, 0, cell);
    report = `Inserted ${cellLabel(nb, at)}:\n${JSON.stringify(cell, null, 1)}`;
  } else if (mode === "delete") {
    const label = cellLabel(nb, index!);
    nb.cells.splice(index!, 1);
    report = `Deleted ${label}.`;
  } else {
    if (input.source === undefined) return refuse("Give source: the new content of the cell.");
    const cell = nb.cells[index!]!;
    const type = input.cell_type ?? cell.cell_type;
    cell.source = toSource(input.source, Array.isArray(cell.source) || asList);
    if (type !== cell.cell_type) cell.cell_type = type;
    if (type === "code") {
      // EF-03: the outputs of a code cell whose source is replaced are cleared.
      cell.outputs = [];
      cell.execution_count = null;
    } else {
      delete cell.outputs;
      delete cell.execution_count;
    }
    report = `Updated ${cellLabel(nb, index!)}:\n${JSON.stringify(cell, null, 1)}`;
  }
  const after = serialiseNotebook(nb, decoded.text);
  return { before: decoded.text, after, format: decoded.format, report };
}

export const updateNotebookCellTool: Tool<UpdateNotebookCellInput> = {
  name: "update_notebook_cell",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the .ipynb notebook." },
      cell_id: { type: "string", description: "Id of the target cell, or its index counted from 1. For insert: the new cell goes after it; omitted, at the top." },
      mode: { type: "string", enum: ["replace", "insert", "delete"], description: "Default: replace." },
      cell_type: { type: "string", enum: ["code", "markdown"], description: "Required for insert; for replace, changes the type." },
      source: { type: "string", description: "New content of the cell (not used by delete)." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  description: () => description.trim(),
  flags: () => ({ readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: false }),
  isEnabled: () => true,
  validate(input, ctx) {
    if (!isAbsolutePath(input.path, ctx.platform)) return "The path must be absolute.";
    const ambiguous = ambiguousPathReason(input.path, ctx.platform);
    if (ambiguous) return ambiguous;
    if (extname(input.path).toLowerCase() !== ".ipynb") return "This tool only modifies .ipynb notebooks: use edit_file for other files.";
    return undefined;
  },
  ruleSubject: (input) => ({ kind: "paths", access: "write", paths: [input.path] }),
  permissionContribution: (input, ctx) => writeContribution(input.path, ctx.protectedLocations, ctx.platform),
  summary: (input) => `${input.mode ?? "replace"} a cell of ${input.path}`,

  async preview(input, ctx): Promise<ToolPreview> {
    const p = plan(input, ctx);
    if ("refusal" in p) return p;
    return { diff: unifiedDiff(toLf(p.before), toLf(p.after), input.path), change: { path: input.path, before: toLf(p.before), after: toLf(p.after) } };
  },

  async execute(input, ctx): Promise<ToolOutcome> {
    const p = plan(input, ctx);
    if ("refusal" in p) return p.refusal;
    try {
      writeAtomic(input.path, encodeText(p.after, p.format), ctx.platform);
    } catch (error) {
      if (error instanceof WriteFailure) return textOutcome(error.message, true, "execution");
      throw error;
    }
    recordWrite(input.path, ctx);
    return textOutcome(p.report);
  },
};

