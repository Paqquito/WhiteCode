// Implements: SPEC-OUT-007 (§ 5.3 points 1 to 5, FA-01 to FA-03, EF-01 to EF-07, ERR-01 to ERR-03, RG-01, RG-02, CA-01 to CA-05)
// Supports: SPEC-PER-010, gaps E-033, E-047 (exclusion files), E-048 and E-071 (file types, order of results, empty result with a filter)
// Search engine of the system (ripgrep) when found, built-in fallback otherwise; both produce the same result model.

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import picomatch from "picomatch";
import description from "../../prompts/tools/search_content.md" with { type: "text" };
import { insideAllowed } from "../permissions/paths";
import { absolute } from "../platform/system";
import { suggest } from "../shared/suggest";
import { walkFiles } from "./file-walk";
import { decodeText } from "./text-file";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome } from "./types";

export interface SearchContentInput {
  readonly pattern: string;
  readonly path?: string;
  readonly glob?: string;
  readonly type?: string;
  readonly mode?: "files" | "lines" | "count";
  readonly ignore_case?: boolean;
  readonly multiline?: boolean;
  readonly before?: number;
  readonly after?: number;
  readonly around?: number;
  readonly line_numbers?: boolean;
  readonly offset?: number;
  readonly limit?: number;
}

/** File types accepted by `type` (gaps E-048, E-071): name → file name globs. */
export const FILE_TYPES: Readonly<Record<string, readonly string[]>> = {
  c: ["*.c", "*.h"],
  conf: ["*.conf", "*.cnf"],
  cpp: ["*.cpp", "*.cc", "*.cxx", "*.hpp", "*.hh", "*.hxx", "*.h"],
  cs: ["*.cs"],
  css: ["*.css", "*.scss", "*.sass", "*.less"],
  env: ["*.env", ".env", ".env.*"],
  go: ["*.go"],
  html: ["*.html", "*.htm"],
  ini: ["*.ini", "*.cfg"],
  java: ["*.java"],
  js: ["*.js", "*.mjs", "*.cjs", "*.jsx"],
  json: ["*.json", "*.jsonc"],
  kotlin: ["*.kt", "*.kts"],
  md: ["*.md", "*.markdown"],
  php: ["*.php"],
  powershell: ["*.ps1", "*.psm1", "*.psd1"],
  properties: ["*.properties"],
  py: ["*.py", "*.pyi"],
  rb: ["*.rb"],
  rust: ["*.rs"],
  scala: ["*.scala"],
  sh: ["*.sh", "*.bash", "*.zsh"],
  sql: ["*.sql"],
  swift: ["*.swift"],
  toml: ["*.toml"],
  ts: ["*.ts", "*.tsx", "*.mts", "*.cts"],
  txt: ["*.txt"],
  xml: ["*.xml"],
  yaml: ["*.yaml", "*.yml"],
};

interface Hit {
  readonly line: number;
  readonly text: string;
  readonly match: boolean;
}

interface FileResult {
  readonly path: string;
  readonly matches: number;
  readonly hits: Hit[];
}

interface SearchRun {
  readonly files: FileResult[];
  readonly timedOut: boolean;
}

interface Query {
  readonly pattern: string;
  readonly target: string;
  readonly isFile: boolean;
  readonly glob?: string;
  readonly typeGlobs?: readonly string[];
  readonly ignoreCase: boolean;
  readonly multiline: boolean;
  readonly before: number;
  readonly after: number;
  readonly respectIgnoreFiles: boolean;
  readonly caseInsensitivePaths: boolean;
  readonly deadline: number;
  readonly signal: AbortSignal;
}

const targetOf = (input: { path?: string }, ctx: ToolContext) => (input.path === undefined ? ctx.cwd : absolute(input.path, ctx.cwd));

/** Leading inline case flag of the ripgrep syntax, translated for the built-in engine. */
function jsRegex(pattern: string, ignoreCase: boolean, multiline: boolean): RegExp {
  let source = pattern;
  let insensitive = ignoreCase;
  if (source.startsWith("(?i)")) {
    source = source.slice(4);
    insensitive = true;
  }
  return new RegExp(source, `g${insensitive ? "i" : ""}${multiline ? "m" : ""}`);
}

function regexError(pattern: string, ignoreCase: boolean, multiline: boolean): string | undefined {
  try {
    jsRegex(pattern, ignoreCase, multiline);
    return undefined;
  } catch (error) {
    return `Invalid regular expression: ${(error as Error).message}.`;
  }
}

function addHit(hits: Map<number, Hit>, line: number, text: string, match: boolean): void {
  const existing = hits.get(line);
  if (!existing || (match && !existing.match)) hits.set(line, { line, text, match });
}

/** Built-in engine (FA-02). */
function searchBuiltIn(q: Query): SearchRun {
  const nameFilter = (globs: readonly string[]) => picomatch(globs.map((g) => (g.includes("/") ? g : `**/${g}`)), { dot: true, nocase: q.caseInsensitivePaths });
  const globFilter = q.glob ? nameFilter([q.glob]) : undefined;
  const typeFilter = q.typeGlobs ? nameFilter(q.typeGlobs) : undefined;
  const accept = (rel: string) => (!globFilter || globFilter(rel)) && (!typeFilter || typeFilter(rel));
  const walked = q.isFile
    ? { files: [{ path: q.target, relativePath: q.target.split(/[\\/]/).pop()!, stats: statSync(q.target) }], timedOut: false }
    : walkFiles(q.target, { respectIgnoreFiles: q.respectIgnoreFiles, caseInsensitive: q.caseInsensitivePaths, deadline: q.deadline, signal: q.signal }, accept);
  const regex = jsRegex(q.pattern, q.ignoreCase, q.multiline);
  const files: FileResult[] = [];
  let timedOut = walked.timedOut;
  for (const f of walked.files) {
    if (Date.now() > q.deadline || q.signal.aborted) {
      timedOut = true;
      break;
    }
    let decoded;
    try {
      decoded = decodeText(readFileSync(f.path));
    } catch {
      continue;
    }
    if (!decoded) continue; // binary files are ignored
    const lines = decoded.text.split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const hits = new Map<number, Hit>();
    let matches = 0;
    const matchedLines: number[] = [];
    if (q.multiline) {
      const text = lines.join("\n");
      const starts: number[] = [];
      let o = 0;
      for (const l of lines) {
        starts.push(o);
        o += l.length + 1;
      }
      const lineAt = (offset: number) => {
        let lo = 0;
        let hi = starts.length - 1;
        while (lo < hi) {
          const mid = (lo + hi + 1) >> 1;
          if (starts[mid]! <= offset) lo = mid;
          else hi = mid - 1;
        }
        return lo;
      };
      regex.lastIndex = 0;
      for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
        if (m[0] === "") regex.lastIndex++;
        matches++;
        const first = lineAt(m.index);
        const last = lineAt(m.index + Math.max(0, m[0].length - 1));
        for (let i = first; i <= last; i++) matchedLines.push(i);
      }
    } else {
      lines.forEach((line, i) => {
        regex.lastIndex = 0;
        let n = 0;
        for (let m = regex.exec(line); m !== null; m = regex.exec(line)) {
          if (m[0] === "") regex.lastIndex++;
          n++;
        }
        if (n > 0) {
          matches += n;
          matchedLines.push(i);
        }
      });
    }
    if (matches === 0) continue;
    for (const i of matchedLines) {
      for (let c = Math.max(0, i - q.before); c < i; c++) addHit(hits, c + 1, lines[c]!, false);
      addHit(hits, i + 1, lines[i]!, true);
      for (let c = i + 1; c <= Math.min(lines.length - 1, i + q.after); c++) addHit(hits, c + 1, lines[c]!, false);
    }
    files.push({ path: f.path, matches, hits: [...hits.values()].sort((a, b) => a.line - b.line) });
  }
  return { files, timedOut };
}

/** Search engine of the system: JSON output of ripgrep, converted to the common model. */
async function searchRipgrep(rg: string, q: Query): Promise<SearchRun> {
  const args = ["--json", "--no-config", "--hidden", "--no-require-git", "--no-ignore-parent", "--no-ignore-global", "--no-ignore-exclude", "-g", "!.git"];
  if (!q.respectIgnoreFiles) args.push("--no-ignore");
  if (q.ignoreCase) args.push("-i");
  if (q.multiline) args.push("-U");
  if (q.caseInsensitivePaths) args.push("--glob-case-insensitive");
  if (q.glob) args.push("-g", q.glob);
  if (q.typeGlobs) {
    for (const g of q.typeGlobs) args.push("--type-add", `selected:${g}`);
    args.push("-t", "selected");
  }
  if (q.before > 0) args.push("-B", String(q.before));
  if (q.after > 0) args.push("-A", String(q.after));
  args.push("-e", q.pattern, "--", q.target);

  const byPath = new Map<string, { matches: number; hits: Map<number, Hit> }>();
  let timedOut = false;
  let stderr = "";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(rg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, Math.max(0, q.deadline - Date.now()));
    const onAbort = () => child.kill();
    q.signal.addEventListener("abort", onAbort, { once: true });
    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf("\n");
        let event: { type: string; data: Record<string, unknown> };
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== "match" && event.type !== "context") continue;
        const d = event.data as { path: { text?: string }; lines: { text?: string }; line_number: number | null; submatches: unknown[] };
        const path = d.path.text;
        if (path === undefined || d.line_number === null) continue;
        let entry = byPath.get(path);
        if (!entry) byPath.set(path, (entry = { matches: 0, hits: new Map() }));
        const text = (d.lines.text ?? "").replace(/\r?\n$/, "");
        const parts = text.split(/\r?\n/);
        parts.forEach((t, k) => addHit(entry!.hits, d.line_number! + k, t, event.type === "match"));
        if (event.type === "match") entry.matches += Math.max(1, d.submatches.length);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      q.signal.removeEventListener("abort", onAbort);
      if (code === 2 && byPath.size === 0 && !timedOut) reject(new Error(stderr.trim() || "the search engine failed"));
      else resolve();
    });
  });
  const files = [...byPath.entries()].map(([path, e]) => ({ path, matches: e.matches, hits: [...e.hits.values()].sort((a, b) => a.line - b.line) }));
  return { files, timedOut };
}

function truncateLine(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)} [… ${text.length} characters]` : text; // FA-03
}

/** Output entries of a mode, before pagination. */
function entries(files: readonly FileResult[], mode: "files" | "lines" | "count", lineNumbers: boolean, maxLine: number): Array<{ text: string; file: string; line?: number }> {
  switch (mode) {
    case "files":
      return files.map((f) => ({ text: f.path, file: f.path }));
    case "count":
      return files.map((f) => ({ text: `${f.path}:${f.matches}`, file: f.path }));
    case "lines":
      return files.flatMap((f) =>
        f.hits.map((h) => ({
          text: lineNumbers ? `${f.path}${h.match ? ":" : "-"}${h.line}${h.match ? ":" : "-"}${truncateLine(h.text, maxLine)}` : `${f.path}${h.match ? ":" : "-"}${truncateLine(h.text, maxLine)}`,
          file: f.path,
          line: h.line,
        })),
      );
  }
}

/**
 * Gap E-071 (correction D-8): when a `type` or `glob` filter is given and nothing matches, the result says how many files
 * of the folder the filter left out, with a few names (never a file refused by a read rule, RG-01), so that the model
 * does not conclude from a filtered search that the text is nowhere.
 */
function filterNote(input: SearchContentInput, q: Query, ctx: ToolContext): string {
  if (q.isFile || (input.type === undefined && input.glob === undefined)) return "";
  const nameFilter = (globs: readonly string[]) => picomatch(globs.map((g) => (g.includes("/") ? g : `**/${g}`)), { dot: true, nocase: q.caseInsensitivePaths });
  const globFilter = input.glob ? nameFilter([input.glob]) : undefined;
  const typeFilter = q.typeGlobs ? nameFilter(q.typeGlobs) : undefined;
  const walked = walkFiles(q.target, { respectIgnoreFiles: q.respectIgnoreFiles, caseInsensitive: q.caseInsensitivePaths, deadline: Date.now() + 500, signal: q.signal }, () => true);
  const visible = walked.files.filter((f) => !ctx.readDenied(f.path));
  const left = visible.filter((f) => !((!globFilter || globFilter(f.relativePath)) && (!typeFilter || typeFilter(f.relativePath))));
  if (left.length === 0) return "";
  const filters = [input.type !== undefined ? `type ${input.type}` : undefined, input.glob !== undefined ? `glob ${input.glob}` : undefined].filter(Boolean).join(" and ");
  const names = left.slice(0, 5).map((f) => f.relativePath);
  const more = left.length > names.length ? ", …" : "";
  return ` The filter (${filters}) left out ${left.length} of the ${visible.length} files of ${q.target}, such as ${names.join(", ")}${more}. Search again without it to include them.`;
}

export const searchContentTool: Tool<SearchContentInput> = {
  name: "search_content",
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (ripgrep syntax)." },
      path: { type: "string", description: "File or folder to search. Default: the working directory." },
      glob: { type: "string", description: "Only files whose path matches this glob, such as *.ts or src/**/*.py." },
      type: { type: "string", description: "Only files of this type, such as py, ts, rust, md." },
      mode: { type: "string", enum: ["files", "lines", "count"], description: "files (default): matching files; lines: matching lines; count: matches per file." },
      ignore_case: { type: "boolean" },
      multiline: { type: "boolean", description: "Let the expression span several lines." },
      before: { type: "integer", minimum: 0, maximum: 20, description: "Context lines before each match (lines mode)." },
      after: { type: "integer", minimum: 0, maximum: 20, description: "Context lines after each match (lines mode)." },
      around: { type: "integer", minimum: 0, maximum: 20, description: "Context lines before and after each match (lines mode)." },
      line_numbers: { type: "boolean", description: "Show line numbers in lines mode. Default: true." },
      offset: { type: "integer", minimum: 0, description: "Output entries to skip." },
      limit: { type: "integer", minimum: 0, description: "Maximum output entries; 0 means no limit (costly on large results)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },
  description: () => description.trim(),
  flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: true, openWorld: false }), // EF-07
  isEnabled: () => true,
  validate(input) {
    const invalid = regexError(input.pattern, input.ignore_case === true, input.multiline === true);
    if (invalid) return invalid; // ERR-01
    if (input.type !== undefined && !(input.type in FILE_TYPES)) {
      // Only really close names (gap E-071): one edit for a name of up to five characters, two beyond.
      const near = suggest(input.type, Object.keys(FILE_TYPES), input.type.length <= 5 ? 1 : 2);
      return `Unknown file type: ${input.type}.${near.length > 0 ? ` Close types: ${near.join(", ")}.` : ""} Known types: ${Object.keys(FILE_TYPES).join(", ")}.`; // ERR-02
    }
    return undefined;
  },
  ruleSubject: (input, ctx) => ({ kind: "paths", access: "read", paths: [targetOf(input, ctx)] }),
  permissionContribution: (input, ctx) => (insideAllowed(targetOf(input, ctx), ctx.allowedDirectories, ctx.platform) ? "allow" : undefined),
  summary: (input) => `Search ${input.pattern}${input.path ? ` in ${input.path}` : ""}`,

  async execute(input, ctx): Promise<ToolOutcome> {
    const target = targetOf(input, ctx);
    let isFile: boolean;
    try {
      isFile = statSync(target).isFile();
    } catch {
      return textOutcome(`Path not found: ${target}.`, true, "invalid_input");
    }
    const mode = input.mode ?? "files";
    const q: Query = {
      pattern: input.pattern,
      target,
      isFile,
      glob: input.glob,
      typeGlobs: input.type !== undefined ? FILE_TYPES[input.type] : undefined,
      ignoreCase: input.ignore_case === true,
      multiline: input.multiline === true,
      before: mode === "lines" ? (input.before ?? input.around ?? 0) : 0,
      after: mode === "lines" ? (input.after ?? input.around ?? 0) : 0,
      respectIgnoreFiles: ctx.settings.respectIgnoreFiles,
      caseInsensitivePaths: ctx.platform === "windows" || ctx.platform === "macos",
      deadline: Date.now() + ctx.settings.searchTimeoutMs,
      signal: ctx.signal,
    };
    let run: SearchRun;
    let fallbackNote = "";
    if (ctx.ripgrepPath) {
      try {
        run = await searchRipgrep(ctx.ripgrepPath, q);
      } catch (error) {
        const message = (error as Error).message;
        if (/regex|parse error/i.test(message)) return textOutcome(`Invalid regular expression: ${message}`, true, "invalid_input");
        run = searchBuiltIn(q);
        fallbackNote = " The system search engine failed; the built-in search was used.";
      }
    } else run = searchBuiltIn(q);

    // RG-01: nothing from a file refused by a read rule; stable order by path (gap E-048).
    const files = run.files.filter((f) => !ctx.readDenied(f.path)).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (files.length === 0) {
      if (run.timedOut) return textOutcome(`Search stopped after ${Math.round(ctx.settings.searchTimeoutMs / 1000)} s: no match found in the part searched.`);
      return textOutcome(`No match found.${filterNote(input, q, ctx)}${fallbackNote}`); // FA-01
    }
    const all = entries(files, mode, input.line_numbers !== false, ctx.settings.searchMaxLineLength);
    const offset = input.offset ?? 0;
    const limit = input.limit ?? ctx.settings.searchDefaultLimit;
    const page = limit === 0 ? all.slice(offset) : all.slice(offset, offset + limit);
    const out: string[] = [];
    page.forEach((e, i) => {
      const prev = page[i - 1];
      // Non-contiguous groups of lines are separated, as ripgrep does.
      if (mode === "lines" && prev && (prev.file !== e.file || (e.line ?? 0) !== (prev.line ?? 0) + 1)) out.push("--");
      out.push(e.text);
    });
    const unit = mode === "files" ? "files" : mode === "count" ? "files" : "lines";
    const notes: string[] = [];
    if (offset + page.length < all.length || offset > 0) notes.push(`Showing entries ${all.length === 0 ? 0 : offset + 1} to ${offset + page.length} of ${all.length} ${unit}. Use offset and limit to see more.`); // EF-06
    if (mode === "count") notes.push(`Total: ${files.reduce((n, f) => n + f.matches, 0)} matches in ${files.length} files.`);
    if (run.timedOut) notes.push(`Search stopped after ${Math.round(ctx.settings.searchTimeoutMs / 1000)} s: results are partial.`); // ERR-03
    return textOutcome(out.join("\n") + (notes.length > 0 ? `\n\n[${notes.join(" ")}]` : "") + (fallbackNote ? `\n${fallbackNote.trim()}` : ""));
  },
};
