// Implements: SPEC-OUT-002 (§ 5.3 points 5 to 7, EF-01 to EF-07, FA-01 to FA-03, ERR-01 to ERR-07, RG-01, CA-01, CA-02, CA-04, CA-05)
// Supports: SPEC-PER-010 (reads inside the allowed folders are allowed), decisions D-06 (PDF in lot 2) and D-20 (correction D-3), gaps E-027 (image limits), E-033 (model-facing messages in English), E-082 (PDF as text)
// Supports: SPEC-OUT-002 (CA-03 PNG resizing), gap E-162.

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync, type Stats } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import description from "../../prompts/tools/read_file.md" with { type: "text" };
import { comparablePath, isAbsolutePath, isWithin, realPathOrSelf } from "../platform/system";
import { suggest } from "../shared/suggest";
import { IMAGE_MAX_BYTES } from "./image-header";
import { ImageFailure, prepareImage } from "./image-resize";
import { parseNotebook, renderNotebook } from "./notebook";
import { readPdf } from "./pdf";
import { decodeText } from "./text-file";
import { walkFiles } from "./file-walk";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome } from "./types";

export interface ReadFileInput {
  readonly path: string;
  readonly offset?: number;
  readonly limit?: number;
  readonly pages?: string;
}

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
/** Beyond this length, a notebook output is truncated (EF-04). */
const NOTEBOOK_OUTPUT_MAX_CHARS = 4000;

function readAll(path: string, size: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = readSync(fd, buffer, offset, size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

/**
 * Suggestions for a missing file (FA-01), as full paths with the separator of the platform (D-3):
 * first the files of the same name in the nearby folders (below the parent and the grandparent), then similar names in the folder.
 */
function suggestions(path: string, ctx: ToolContext): string[] {
  const name = basename(path);
  const dir = dirname(path);
  const out: string[] = [];
  const caseInsensitive = ctx.platform === "windows" || ctx.platform === "macos";
  const same = (a: string) => (caseInsensitive ? a.toLowerCase() === name.toLowerCase() : a === name);
  for (const base of [dir, dirname(dir)]) {
    // Never outside the allowed folders: a suggestion would reveal names the agent may not read.
    if (!existsSync(base) || !ctx.allowedDirectories.some((d) => isWithin(base, d, ctx.platform))) continue;
    const found = walkFiles(base, { respectIgnoreFiles: true, caseInsensitive, deadline: Date.now() + 500, signal: ctx.signal }, (rel) => same(rel.split("/").pop() ?? ""));
    for (const f of found.files) if (!out.includes(f.path) && !ctx.readDenied(f.path)) out.push(f.path);
    if (out.length > 0) break;
  }
  try {
    for (const n of suggest(name, readdirSync(dir), 3)) {
      const candidate = join(dir, n);
      if (!out.includes(candidate)) out.push(candidate);
    }
  } catch {
    // missing folder: nothing more to suggest
  }
  return out.slice(0, 3);
}

export const readFileTool: Tool<ReadFileInput> = {
  name: "read_file",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path of the file to read." },
      offset: { type: "integer", minimum: 1, description: "First line to read, starting at 1." },
      limit: { type: "integer", minimum: 1, maximum: 10000, description: "Number of lines to read." },
      pages: { type: "string", pattern: "^\\d+(-\\d+)?$", description: "Page range for documents, such as 3 or 3-7." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  description: () => description.trim(),
  flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: true, openWorld: false }),
  isEnabled: () => true,
  validate(input, ctx) {
    if (!isAbsolutePath(input.path, ctx.platform)) return "The path must be absolute.";
    return undefined;
  },
  ruleSubject: (input) => ({ kind: "paths", access: "read", paths: [input.path] }),
  permissionContribution(input, ctx) {
    const real = realPathOrSelf(input.path);
    const readable = [...ctx.allowedDirectories, ...(ctx.extraReadableDirectories ?? [])];
    const inside = (p: string) => readable.some((d) => isWithin(p, d, ctx.platform));
    return inside(input.path) && inside(real) ? "allow" : undefined;
  },
  summary: (input) => `Read ${input.path}`,

  async execute(input, ctx): Promise<ToolOutcome> {
    if (ctx.readDenied(input.path) || ctx.readDenied(realPathOrSelf(input.path))) return textOutcome("This file is not accessible.", true, "permission_denied");
    let stats: Stats;
    try {
      stats = statSync(input.path);
    } catch {
      const near = suggestions(input.path, ctx);
      return textOutcome(`File not found: ${input.path}.${near.length > 0 ? ` Did you mean: ${near.join(", ")}?` : ""}`, true);
    }
    if (stats.isDirectory()) return textOutcome("This path is a directory, not a file: search for files instead.", true);
    if (stats.isFIFO() || stats.isCharacterDevice() || stats.isBlockDevice() || stats.isSocket()) {
      return textOutcome("Device files, sockets and named pipes cannot be read.", true);
    }
    const ext = extname(input.path).toLowerCase();
    const key = comparablePath(realPathOrSelf(input.path), ctx.platform);
    if (ext === ".pdf") return readPdf(input.path, stats, input.pages, key, ctx);
    if (IMAGE_EXTENSIONS.has(ext)) return readImage(input.path, stats, ctx);
    if (ext === ".ipynb") {
      const nb = stats.size <= ctx.settings.readMaxBytesWithoutRange * 16 ? parseNotebook(readFileSync(input.path, "utf8")) : undefined;
      if (!nb) return textOutcome("The notebook cannot be read: its JSON is invalid or too large.", true);
      const rendered = renderNotebook(nb, NOTEBOOK_OUTPUT_MAX_CHARS);
      ctx.readState.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, complete: rendered.truncated === 0 });
      const note = rendered.truncated > 0 ? `\n\n[${rendered.truncated} output${rendered.truncated === 1 ? " was" : "s were"} truncated.]` : "";
      return textOutcome((rendered.text === "" ? "The notebook has no cells." : rendered.text) + note);
    }

    const rangeGiven = input.offset !== undefined || input.limit !== undefined;
    if (!rangeGiven && stats.size > ctx.settings.readMaxBytesWithoutRange) {
      return textOutcome(`The file is too large to be read at once (${stats.size} bytes): give offset and limit.`, true);
    }
    const text = decodeText(readAll(input.path, stats.size))?.text;
    if (text === undefined) return textOutcome("This file type cannot be read as text.", true);

    ctx.languages?.opened(input.path, text, ctx);
    if (text.length === 0) {
      ctx.readState.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, complete: true });
      return textOutcome("The file is empty.");
    }
    const lines = text.split(/\r\n|\n|\r/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const total = lines.length;
    const offset = input.offset ?? 1;
    const limit = input.limit ?? ctx.settings.readDefaultLines;
    if (offset > total) {
      ctx.readState.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, complete: false });
      return textOutcome(`The file has only ${total} line${total === 1 ? "" : "s"}.`);
    }
    const end = Math.min(total, offset - 1 + limit);
    const out: string[] = [];
    let truncatedLines = 0;
    for (let i = offset - 1; i < end; i++) {
      let line = lines[i]!;
      if (line.length > ctx.settings.readMaxLineLength) {
        truncatedLines++;
        line = `${line.slice(0, ctx.settings.readMaxLineLength)} [… line truncated: ${line.length} characters]`;
      }
      out.push(`${i + 1}\t${line}`);
    }
    const notes: string[] = [];
    if (offset > 1 || end < total) notes.push(`Showing lines ${offset} to ${end} of ${total}. Use offset and limit to read other lines.`);
    if (truncatedLines > 0) notes.push(`${truncatedLines} line${truncatedLines === 1 ? " was" : "s were"} truncated.`);
    const complete = offset === 1 && end === total && truncatedLines === 0;
    ctx.readState.set(key, { mtimeMs: stats.mtimeMs, size: stats.size, complete });
    return textOutcome(out.join("\n") + (notes.length > 0 ? `\n\n[${notes.join(" ")}]` : ""));
  },
};

async function readImage(path: string, stats: Stats, ctx: ToolContext): Promise<ToolOutcome> {
  if (!ctx.modelImages) return textOutcome("The current model does not accept images.", true);
  if (extname(path).toLowerCase() === ".bmp") return textOutcome("BMP images are not supported: convert the image to PNG or JPEG.", true);
  if (stats.size > IMAGE_MAX_BYTES) return textOutcome(`The image is too large (${stats.size} bytes, limit ${IMAGE_MAX_BYTES}): reduce it before reading it.`, true);
  let info;
  try { info = await prepareImage(readFileSync(path), ctx.signal); }
  catch (error) { if (error instanceof ImageFailure) return textOutcome(error.message, true); throw error; }
  ctx.readState.set(comparablePath(realPathOrSelf(path), ctx.platform), { mtimeMs: stats.mtimeMs, size: stats.size, complete: true });
  return {
    isError: false,
    content: [
      { type: "text", text: `Image ${path} (${info.width} × ${info.height}, ${info.mediaType}${info.resized ? ", resized" : ""}).` },
      { type: "image", mediaType: info.mediaType, dataBase64: info.bytes.toString("base64") },
    ],
  };
}
