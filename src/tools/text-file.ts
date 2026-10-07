// Implements: SPEC-OUT-003 (§ 5.3 points 2, 5, 6 and 7, EF-02 to EF-04, RG-02, RG-03, ERR-01, ERR-02, ERR-04, ERR-05, ENF-01, ENF-02, Q-01 POSIX mode kept)
// Supports: SPEC-OUT-002 (decoding), SPEC-OUT-004 (§ 5.3 points 2 and 6), SPEC-OUT-005 (§ 5.3 point 5)
// Shared by the writing tools: text format detection, faithful re-encoding, read precondition and atomic write.

import { chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { comparablePath, realPathOrSelf, type PlatformName } from "../platform/system";
import type { ReadRecord, ToolContext } from "./types";

export type TextEncoding = "utf8" | "utf16le" | "utf16be" | "latin1";

export interface TextFormat {
  readonly encoding: TextEncoding;
  readonly bom: boolean;
  readonly eol: "\n" | "\r\n";
}

export interface DecodedText {
  /** Content with its original line endings. */
  readonly text: string;
  readonly format: TextFormat;
}

/** Decodes a text file; undefined for binary content. */
export function decodeText(bytes: Uint8Array): DecodedText | undefined {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text: string;
  let encoding: TextEncoding;
  let bom = false;
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    text = b.subarray(3).toString("utf8");
    encoding = "utf8";
    bom = true;
  } else if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) {
    text = new TextDecoder("utf-16le").decode(b.subarray(2));
    encoding = "utf16le";
    bom = true;
  } else if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    text = new TextDecoder("utf-16be").decode(b.subarray(2));
    encoding = "utf16be";
    bom = true;
  } else {
    if (b.subarray(0, Math.min(b.length, 8000)).includes(0)) return undefined;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(b);
      encoding = "utf8";
    } catch {
      text = new TextDecoder("latin1").decode(b);
      encoding = "latin1";
    }
  }
  return { text, format: { encoding, bom, eol: dominantEol(text) ?? "\n" } };
}

/** Line ending used by most lines; undefined when the text has none. */
export function dominantEol(text: string): "\n" | "\r\n" | undefined {
  const crlf = text.match(/\r\n/g)?.length ?? 0;
  const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
  if (crlf === 0 && lf === 0) return undefined;
  return crlf > lf ? "\r\n" : "\n";
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Format of a new file: UTF-8 without mark, platform line endings unless the content imposes its own (§ 5.3 point 5). */
export function newFileFormat(content: string, platform: PlatformName): TextFormat {
  return { encoding: "utf8", bom: false, eol: dominantEol(content) ?? (platform === "windows" ? "\r\n" : "\n") };
}

/** Encodes `text` (any line endings) in `format`, line endings normalised to the format (EF-04, ENF-02). */
export function encodeText(text: string, format: TextFormat): Buffer {
  const lf = toLf(text);
  const body = format.eol === "\r\n" ? lf.replace(/\n/g, "\r\n") : lf;
  switch (format.encoding) {
    case "utf8":
      return Buffer.concat([format.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(body, "utf8")]);
    case "utf16le":
      return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(body, "utf16le")]);
    case "utf16be": {
      const le = Buffer.from(body, "utf16le");
      for (let i = 0; i + 1 < le.length; i += 2) [le[i], le[i + 1]] = [le[i + 1]!, le[i]!];
      return Buffer.concat([Buffer.from([0xfe, 0xff]), le]);
    }
    case "latin1":
      // A character outside Latin-1 cannot be kept in this encoding: the file becomes UTF-8.
      return [...body].some((c) => c.codePointAt(0)! > 0xff) ? Buffer.from(body, "utf8") : Buffer.from(body, "latin1");
  }
}

/** Key of the read state: real path in comparable form. */
export function readStateKey(path: string, platform: PlatformName): string {
  return comparablePath(realPathOrSelf(path), platform);
}

/**
 * Read precondition (EF-02 of SPEC-OUT-003, EF-04 of SPEC-OUT-004): the file was read in this session and has not changed since.
 * `complete` requires a whole read without truncation (RG-02 of SPEC-OUT-003). Returns the refusal message, or undefined.
 */
export function readPreconditionError(path: string, ctx: ToolContext, complete: boolean, verb: "rewrite" | "edit"): string | undefined {
  const record = ctx.readState.get(readStateKey(path, ctx.platform));
  if (!record) return `Read the file before you ${verb} it.`;
  if (complete && !record.complete) return `Read the whole file (without offset, limit or truncation) before you rewrite it.`;
  const now = statSync(path);
  if (now.mtimeMs !== record.mtimeMs || now.size !== record.size) return "The file has changed since you read it: read it again.";
  return undefined;
}

/** After a write, the file is known to the agent in its new state (§ 5.3 point 7). */
export function recordWrite(path: string, ctx: ToolContext): void {
  const s = statSync(path);
  const record: ReadRecord = { mtimeMs: s.mtimeMs, size: s.size, complete: true };
  ctx.readState.set(readStateKey(path, ctx.platform), record);
}

export class WriteFailure extends Error {}

function failureMessage(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "EACCES" || code === "EPERM" || code === "EROFS") return "Write failed: access denied by the system.";
  if (code === "ENOSPC" || code === "EDQUOT") return "Write failed: not enough disk space.";
  if (code === "ENAMETOOLONG") return "Write failed: the path is too long for the system.";
  return `Write failed: ${(error as Error)?.message ?? String(error)}.`;
}

/**
 * Atomic write (EF-03, RG-03, ENF-01): temporary file in the same folder, flushed, then renamed over the target.
 * Missing parent folders are created; the POSIX mode of a replaced file is kept (Q-01). The original stays intact on failure.
 */
export function writeAtomic(path: string, bytes: Uint8Array, platform: PlatformName): void {
  const dir = dirname(path);
  const temp = join(dir, `.${basename(path)}.${process.pid}.${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.tmp`);
  let mode: number | undefined;
  try {
    mode = statSync(path).mode & 0o7777;
  } catch {
    mode = undefined;
  }
  try {
    mkdirSync(dir, { recursive: true });
    const fd = openSync(temp, "wx", mode ?? 0o666);
    try {
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (mode !== undefined && platform !== "windows") chmodSync(temp, mode);
    renameSync(temp, path);
  } catch (error) {
    // Best-effort cleanup: when the folder itself could not be created, removing the temporary file fails too
    // (EFAULT or ENOTDIR on POSIX systems); the original error is the one reported.
    try {
      rmSync(temp, { force: true });
    } catch {
      // nothing was written
    }
    throw new WriteFailure(failureMessage(error));
  }
}

/** Current bytes of a file, or undefined when it does not exist (a path below a regular file is ENOTDIR on POSIX systems). */
export function readBytesIfExists(path: string): Buffer | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

/** Numbered excerpt of `text` (LF) around the lines [first, last] (1-based), as `read_file` numbers them. */
export function numberedExcerpt(text: string, first: number, last: number, context = 4): string {
  const lines = text.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const from = Math.max(1, first - context);
  const to = Math.min(lines.length, last + context);
  const out: string[] = [];
  for (let i = from; i <= to; i++) out.push(`${i}\t${lines[i - 1] ?? ""}`);
  return out.join("\n");
}

export function lineCount(text: string): number {
  if (text === "") return 0;
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}
