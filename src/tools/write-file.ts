// Implements: SPEC-OUT-003 (§ 5.3, FA-01, FA-02, EF-01 to EF-04, EF-06, EF-07, ERR-01 to ERR-06, RG-01 to RG-03, CA-01 to CA-05)
// Supports: SPEC-PER-010 (protected locations, allowed folders), gap E-033 (model-facing messages in English)

import { statSync } from "node:fs";
import { extname } from "node:path";
import description from "../../prompts/tools/write_file.md" with { type: "text" };
import { ambiguousPathReason, writeContribution } from "../permissions/paths";
import { isAbsolutePath } from "../platform/system";
import { unifiedDiff } from "../shared/diff";
import { decodeText, encodeText, lineCount, newFileFormat, readBytesIfExists, readPreconditionError, recordWrite, toLf, WriteFailure, writeAtomic } from "./text-file";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome, type ToolPreview } from "./types";

export interface WriteFileInput {
  readonly path: string;
  readonly content: string;
}

/** Refusal before any write, or the current state of the target. */
function inspect(input: WriteFileInput, ctx: ToolContext): { refusal: ToolOutcome } | { before?: string; binary?: number } {
  let exists = false;
  try {
    const s = statSync(input.path);
    if (s.isDirectory()) return { refusal: textOutcome("The path is a directory.", true, "invalid_input") }; // ERR-03
    exists = true;
  } catch {
    exists = false;
  }
  if (!exists) return {};
  const precondition = readPreconditionError(input.path, ctx, true, "rewrite"); // ERR-01, ERR-02, RG-02
  if (precondition) return { refusal: textOutcome(precondition, true, "invalid_input") };
  const bytes = readBytesIfExists(input.path) ?? new Uint8Array();
  const decoded = decodeText(bytes);
  return decoded ? { before: toLf(decoded.text) } : { before: "", binary: bytes.length };
}

export const writeFileTool: Tool<WriteFileInput> = {
  name: "write_file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the file to create or overwrite." },
      content: { type: "string", description: "Complete new content of the file." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  description: () => description.trim(),
  flags: () => ({ readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: false }), // EF-07
  isEnabled: () => true,
  validate(input, ctx) {
    if (!isAbsolutePath(input.path, ctx.platform)) return "The path must be absolute."; // EF-01
    const ambiguous = ambiguousPathReason(input.path, ctx.platform);
    if (ambiguous) return ambiguous;
    if (extname(input.path).toLowerCase() === ".ipynb") return "Use update_notebook_cell to modify notebooks."; // ERR-06
    if (Buffer.byteLength(input.content, "utf8") > ctx.settings.writeMaxSize) return `The content exceeds the maximum size of ${ctx.settings.writeMaxSize} bytes.`;
    return undefined;
  },
  ruleSubject: (input) => ({ kind: "paths", access: "write", paths: [input.path] }),
  permissionContribution: (input, ctx) => writeContribution(input.path, ctx.protectedLocations, ctx.platform),
  summary: (input) => `Write ${input.path}`,

  async preview(input, ctx): Promise<ToolPreview> {
    const state = inspect(input, ctx);
    if ("refusal" in state) return state;
    const after = toLf(input.content);
    const change = state.binary !== undefined ? { path: input.path, binary: { before: state.binary, after: Buffer.byteLength(input.content, "utf8") } } : { path: input.path, before: state.before, after };
    return { diff: unifiedDiff(state.before ?? "", after, input.path), change };
  },

  async execute(input, ctx): Promise<ToolOutcome> {
    const state = inspect(input, ctx);
    if ("refusal" in state) return state.refusal;
    const existing = readBytesIfExists(input.path);
    // EF-04: encoding, byte order mark and line endings of an existing file are kept.
    const format = existing ? (decodeText(existing)?.format ?? newFileFormat(input.content, ctx.platform)) : newFileFormat(input.content, ctx.platform);
    try {
      writeAtomic(input.path, encodeText(input.content, format), ctx.platform); // EF-03, RG-03
    } catch (error) {
      if (error instanceof WriteFailure) return textOutcome(error.message, true, "execution"); // ERR-04, ERR-05
      throw error;
    }
    recordWrite(input.path, ctx);
    const lines = lineCount(toLf(input.content));
    return textOutcome(`${existing ? "Updated" : "Created"} ${input.path} (${lines} line${lines === 1 ? "" : "s"}).`);
  },
};
