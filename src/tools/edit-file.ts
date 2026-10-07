// Implements: SPEC-OUT-004 (§ 5.3 points 1 to 8, FA-01 to FA-03, EF-01 to EF-07, ERR-01 to ERR-07, RG-01 to RG-03, CA-01 to CA-09, CA-11, CA-12, CA-14 to CA-16)
// Supports: SPEC-OUT-003 (effects identical to write_file), SPEC-PER-010, decision D-04, gap E-033

import { existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import description from "../../prompts/tools/edit_file.md" with { type: "text" };
import { ambiguousPathReason, writeContribution } from "../permissions/paths";
import { isAbsolutePath } from "../platform/system";
import { unifiedDiff } from "../shared/diff";
import { planEdit, STEP_NAMES, type EditFailure, type EditPlan } from "./edit-match";
import { decodeText, encodeText, newFileFormat, numberedExcerpt, readBytesIfExists, readPreconditionError, recordWrite, toLf, WriteFailure, writeAtomic, type TextFormat } from "./text-file";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome, type ToolPreview } from "./types";

export interface EditFileInput {
  readonly path: string;
  readonly old_text: string;
  readonly new_text: string;
  readonly all_occurrences?: boolean;
}

type Planned = { readonly plan: EditPlan; readonly before: string; readonly format: TextFormat; readonly created: boolean };

function failure(f: EditFailure): ToolOutcome {
  switch (f.kind) {
    case "not_found":
      return textOutcome(`Passage not found: check spaces and indentation, or read the file again.${f.hint ? ` ${f.hint}` : ""}`, true, "invalid_input"); // ERR-01
    case "not_unique":
      return textOutcome(`The passage occurs ${f.count} times: include more surrounding context to make it unique, or set all_occurrences.`, true, "invalid_input"); // ERR-02
    case "ambiguous_approximate":
      return textOutcome("Several approximate passages match: make old_text more precise with more context.", true, "invalid_input"); // ERR-07
  }
}

function plan(input: EditFileInput, ctx: ToolContext): Planned | { refusal: ToolOutcome } {
  const oldText = toLf(input.old_text);
  const newText = toLf(input.new_text);
  if (!existsSync(input.path)) {
    // FA-01: creation with an empty old_text.
    if (oldText !== "") return { refusal: textOutcome(`File not found: ${input.path}. To create a file, give an empty old_text.`, true, "invalid_input") };
    const content = newText;
    return {
      plan: { kind: "planned", content, step: 1, count: 1, firstLine: 1, lastLine: Math.max(1, content.split("\n").length), replaced: "" },
      before: "",
      format: newFileFormat(input.new_text, ctx.platform),
      created: true,
    };
  }
  if (statSync(input.path).isDirectory()) return { refusal: textOutcome("The path is a directory.", true, "invalid_input") };
  const precondition = readPreconditionError(input.path, ctx, false, "edit"); // EF-04, ERR-04, ERR-05 (partial read admitted)
  if (precondition) return { refusal: textOutcome(precondition, true, "invalid_input") };
  const decoded = decodeText(readBytesIfExists(input.path) ?? new Uint8Array());
  if (!decoded) return { refusal: textOutcome("This file is not a text file.", true, "invalid_input") };
  const before = toLf(decoded.text);
  if (oldText === "") {
    if (before !== "") return { refusal: textOutcome("old_text can be empty only to create a file or fill an empty one.", true, "invalid_input") };
    return { plan: { kind: "planned", content: newText, step: 1, count: 1, firstLine: 1, lastLine: Math.max(1, newText.split("\n").length), replaced: "" }, before, format: decoded.format, created: false };
  }
  const result = planEdit(before, oldText, newText, input.all_occurrences === true, ctx.settings.editLenientMatching);
  if (result.kind !== "planned") return { refusal: failure(result) };
  return { plan: result, before, format: decoded.format, created: false };
}

export const editFileTool: Tool<EditFileInput> = {
  name: "edit_file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the file to modify." },
      old_text: { type: "string", description: "Exact passage to replace; empty only to create a file." },
      new_text: { type: "string", description: "Replacement text; must differ from old_text." },
      all_occurrences: { type: "boolean", description: "Replace every occurrence of old_text. Default: false." },
    },
    required: ["path", "old_text", "new_text"],
    additionalProperties: false,
  },
  description: () => description.trim(),
  flags: () => ({ readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: false }),
  isEnabled: () => true,
  validate(input, ctx) {
    if (!isAbsolutePath(input.path, ctx.platform)) return "The path must be absolute.";
    const ambiguous = ambiguousPathReason(input.path, ctx.platform);
    if (ambiguous) return ambiguous;
    if (extname(input.path).toLowerCase() === ".ipynb") return "Use update_notebook_cell to modify notebooks."; // EF-06, ERR-06
    if (toLf(input.old_text) === toLf(input.new_text)) return "No change requested: old_text and new_text are identical."; // EF-03, ERR-03
    return undefined;
  },
  ruleSubject: (input) => ({ kind: "paths", access: "write", paths: [input.path] }),
  permissionContribution: (input, ctx) => writeContribution(input.path, ctx.protectedLocations, ctx.platform),
  summary: (input) => `Edit ${input.path}`,

  async preview(input, ctx): Promise<ToolPreview> {
    const p = plan(input, ctx);
    if ("refusal" in p) return p;
    return { diff: unifiedDiff(p.before, p.plan.content, input.path), change: { path: input.path, before: p.before, after: p.plan.content } };
  },

  async execute(input, ctx): Promise<ToolOutcome> {
    const p = plan(input, ctx);
    if ("refusal" in p) return p.refusal;
    try {
      writeAtomic(input.path, encodeText(p.plan.content, p.format), ctx.platform);
    } catch (error) {
      if (error instanceof WriteFailure) return textOutcome(error.message, true, "execution");
      throw error;
    }
    recordWrite(input.path, ctx);
    if (p.created) return textOutcome(`Created ${input.path}.`);
    const { plan: edit } = p;
    const head = edit.count > 1 ? `Replaced ${edit.count} occurrences in ${input.path}.` : `Edited ${input.path}.`;
    const parts = [head];
    // § 5.3 point 8: for a tolerant step, the step used and the whole replaced text.
    if (edit.step >= 3) parts.push(`Matched by step ${edit.step} (${STEP_NAMES[edit.step]}). Replaced text:\n${edit.replaced}`);
    else if (edit.step === 2) parts.push(`Matched by step 2 (${STEP_NAMES[2]}).`);
    parts.push(`Excerpt after the change:\n${numberedExcerpt(edit.content, edit.firstLine, edit.lastLine)}`); // EF-05
    return textOutcome(parts.join("\n\n"));
  },
};
