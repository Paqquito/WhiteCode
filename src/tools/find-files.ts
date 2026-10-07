// Implements: SPEC-OUT-006 (§ 5.3 points 1 to 5, FA-01, FA-02, EF-01 to EF-05, ERR-01, ERR-02, RG-01, CA-01 to CA-03)
// Supports: decision D-20 (corrections D-1 and D-2 of the evaluation of 2026-10-01: a pattern without `/` matches at any depth; an empty result guides)
// Supports: SPEC-PER-010 (reads inside the allowed folders are allowed), gaps E-033, E-047

import { statSync } from "node:fs";
import picomatch from "picomatch";
import description from "../../prompts/tools/find_files.md" with { type: "text" };
import { insideAllowed } from "../permissions/paths";
import { absolute, isAbsolutePath } from "../platform/system";
import { walkFiles } from "./file-walk";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome } from "./types";

export interface FindFilesInput {
  readonly pattern: string;
  readonly path?: string;
}

const folderOf = (input: { path?: string }, ctx: ToolContext) => (input.path === undefined ? ctx.cwd : absolute(input.path, ctx.cwd));
const caseInsensitive = (ctx: ToolContext) => ctx.platform === "windows" || ctx.platform === "macos";

/** Compiles a glob; the error message when the pattern is invalid (ERR-01). */
export function compileGlob(pattern: string, nocase: boolean): ((path: string) => boolean) | string {
  if (pattern.trim() === "") return "Invalid pattern: it is empty.";
  let depth = 0;
  for (const c of pattern) {
    if (c === "{") depth++;
    if (c === "}") depth--;
    if (depth < 0) break;
  }
  if (depth !== 0) return "Invalid pattern: unbalanced braces.";
  if ((pattern.match(/\[/g)?.length ?? 0) !== (pattern.match(/\]/g)?.length ?? 0)) return "Invalid pattern: unbalanced brackets.";
  // D-1: a pattern without `/` matches at any depth, as in the exclusion files (gap E-047): `guide.md` finds `docs/guides/guide.md`.
  const effective = pattern.includes("/") ? pattern : `**/${pattern}`;
  try {
    return picomatch(effective, { nocase, dot: false });
  } catch (error) {
    return `Invalid pattern: ${(error as Error).message}.`;
  }
}

/** Shown files of an empty result, at most. */
const GUIDANCE_SAMPLE = 12;

/**
 * D-2: an empty result says what the folder holds and how to widen the search, so that the model does not
 * conclude too early that a file does not exist.
 */
function noMatchGuidance(pattern: string, folder: string, ctx: ToolContext): string {
  const all = walkFiles(folder, { respectIgnoreFiles: ctx.settings.respectIgnoreFiles, caseInsensitive: caseInsensitive(ctx), deadline: Date.now() + 2000, signal: ctx.signal })
    .files.filter((f) => !ctx.readDenied(f.path))
    .map((f) => f.relativePath)
    .sort();
  if (all.length === 0) return `No file matches ${pattern}: the folder ${folder} holds no file.`;
  const sample = all.slice(0, GUIDANCE_SAMPLE).join(", ");
  const more = all.length > GUIDANCE_SAMPLE ? `, and ${all.length - GUIDANCE_SAMPLE} more` : "";
  return `No file matches ${pattern} in ${folder}, which holds ${all.length} file${all.length === 1 ? "" : "s"}: ${sample}${more}. Use a broader pattern (such as * or **/*), or search file contents with search_content.`;
}

export const findFilesTool: Tool<FindFilesInput> = {
  name: "find_files",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Glob pattern relative to the folder, such as **/*.ts or src/{a,b}/*.md. Without /, it matches at any depth." },
      path: { type: "string", description: "Folder to search. Default: the working directory." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  description: () => description.trim(),
  flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: true, openWorld: false }), // EF-05
  isEnabled: () => true,
  validate(input, ctx) {
    const matcher = compileGlob(input.pattern, caseInsensitive(ctx));
    if (typeof matcher === "string") return matcher;
    if (input.path !== undefined && !isAbsolutePath(absolute(input.path, ctx.cwd), ctx.platform)) return "The folder path is invalid.";
    return undefined;
  },
  ruleSubject: (input, ctx) => ({ kind: "paths", access: "read", paths: [folderOf(input, ctx)] }),
  permissionContribution: (input, ctx) => (insideAllowed(folderOf(input, ctx), ctx.allowedDirectories, ctx.platform) ? "allow" : undefined),
  summary: (input) => `Find ${input.pattern}${input.path ? ` in ${input.path}` : ""}`,

  async execute(input, ctx): Promise<ToolOutcome> {
    const folder = folderOf(input, ctx);
    try {
      if (!statSync(folder).isDirectory()) return textOutcome(`Not a folder: ${folder}.`, true, "invalid_input");
    } catch {
      return textOutcome(`Folder not found: ${folder}.`, true, "invalid_input"); // ERR-02
    }
    const matcher = compileGlob(input.pattern, caseInsensitive(ctx)) as (p: string) => boolean;
    const walked = walkFiles(
      folder,
      { respectIgnoreFiles: ctx.settings.respectIgnoreFiles, caseInsensitive: caseInsensitive(ctx), deadline: Date.now() + ctx.settings.findTimeoutMs, signal: ctx.signal },
      matcher,
    );
    // RG-01: paths refused by a read rule are not returned.
    const found = walked.files.filter((f) => !ctx.readDenied(f.path)).sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs || (a.path < b.path ? -1 : 1)); // EF-03
    if (found.length === 0) {
      if (walked.timedOut) return textOutcome(`No file found before the time limit of ${Math.round(ctx.settings.findTimeoutMs / 1000)} s.`);
      return textOutcome(noMatchGuidance(input.pattern, folder, ctx)); // FA-01, D-2
    }
    const max = ctx.settings.findMaxResults;
    const shown = found.slice(0, max);
    const notes: string[] = [];
    if (found.length > max) notes.push(`Showing ${max} of ${found.length} files, most recently modified first. Narrow the pattern to see the others.`); // EF-04
    if (walked.timedOut) notes.push(`The search stopped after ${Math.round(ctx.settings.findTimeoutMs / 1000)} s: results are partial.`); // FA-02
    return textOutcome(shown.map((f) => f.path).join("\n") + (notes.length > 0 ? `\n\n[${notes.join(" ")}]` : ""));
  },
};
