// Implements: SPEC-IHM-010 (§ 5.4 attachments by location, § 5.5 limits, FA-04, EF-04 to EF-06, EF-10, ERR-03 to ERR-05, RG-01 to RG-03, CA-05, CA-07),
//             SPEC-MOT-006 (§ 5.1 references, § 5.3 steps 1, 2 and 6, FA-01 to FA-03, EF-01 to EF-04, ERR-01, ERR-03, RG-01, RG-02, CA-01, CA-02, CA-05 to CA-07)
// The files referenced by `@` in a message, read when the message is sent (so that the current state goes), within the
// allowed folders and the reading rules, bounded in number and in size. A reference inside a pasted text or inside code
// attaches nothing.
// Implements: SPEC-IHM-007 (CA-10, distinct agent mentions), gap E-148.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { insideAllowed } from "../permissions/paths";
import type { PlatformName } from "../platform/system";
import type { DocumentPart } from "../providers/types";

export interface AttachmentOptions {
  readonly agents?: readonly string[];
  readonly cwd: string;
  readonly allowedDirectories: readonly string[];
  readonly platform: PlatformName;
  readonly readDenied: (path: string) => boolean;
  readonly maxCount: number;
  readonly maxTotalBytes: number;
  /** `context.attachments.maxTokens`: beyond, the start of the file only (FA-03 of SPEC-MOT-006). */
  readonly maxTokens?: number;
  /** `context.attachments.maxTotalTokens`: beyond, the reference alone (ERR-03). */
  readonly maxTotalTokens?: number;
  readonly pdf?: boolean;
  readonly documentReadDenied?: (path: string) => boolean;
}

/** About four characters per token, the estimate of the context meter. */
const CHARS_PER_TOKEN = 4;
/** Entries listed for a folder (one level, bounded). */
const MAX_FOLDER_ENTRIES = 200;

/** `path#L5-9` or `path#L5`: the lines asked (CA-02 of SPEC-MOT-006). */
function lineRange(ref: string): { readonly path: string; readonly from?: number; readonly to?: number } {
  const m = /^(.*)#L(\d+)(?:-L?(\d+))?$/.exec(ref);
  if (!m) return { path: ref };
  const from = Number(m[2]);
  const to = m[3] !== undefined ? Number(m[3]) : from;
  return { path: m[1]!, from: Math.min(from, to), to: Math.max(from, to) };
}

/** Spans of code (fenced blocks and inline code). */
function codeSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(/```[\s\S]*?(```|$)|`[^`\n]*`/g)].map((m) => [m.index!, m.index! + m[0].length]);
}

/** The `@<path>` references at a trigger position (start or after a blank), outside code and outside pasted texts. */
export function references(text: string, pasted: readonly string[] = [], trigger: "@" | "&" = "@"): Array<{ ref: string; at: number }> {
  const code = codeSpans(text);
  const excluded: Array<[number, number]> = [];
  for (const p of pasted) {
    if (p === "") continue;
    for (let at = text.indexOf(p); at !== -1; at = text.indexOf(p, at + p.length)) excluded.push([at, at + p.length]);
  }
  const out: Array<{ ref: string; at: number }> = [];
  // `@"a path with spaces"` or `@path` (EF-01 of SPEC-MOT-006).
  const pattern = trigger === "@" ? /(^|\s)@(?:"([^"\n]+)"|([^\s@`]+))/g : /(^|\s)&([a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)?)(?=$|[^a-z0-9-:])/g;
  for (const m of text.matchAll(pattern)) {
    const at = m.index! + m[1]!.length;
    if (code.some(([a, b]) => at >= a && at < b) || excluded.some(([a, b]) => at >= a && at < b)) continue;
    out.push({ ref: m[2] ?? m[3]!.replace(/[),.;:!?]+$/, ""), at });
  }
  return out;
}

/**
 * A file or a folder. `C:\…` or `C:/…` is a drive, never a connector (CA-06); `name:resource` that is no path is a
 * reference of a connector, left in the text (CA-07): nothing is attached for it in this version.
 */
function fileOf(ref: string, o: AttachmentOptions): string | undefined {
  const { path: raw } = lineRange(ref);
  const path = isAbsolute(raw) || /^[a-zA-Z]:[\\/]/.test(raw) ? raw : resolve(o.cwd, raw);
  try {
    const s = statSync(path);
    return s.isFile() || s.isDirectory() ? path : undefined;
  } catch {
    return undefined;
  }
}

/** The files a message will attach, as shown before sending (EF-10). */
export function attachable(text: string, o: AttachmentOptions, pasted: readonly string[] = []): string[] {
  const out: string[] = [];
  for (const { ref } of references(text, pasted)) {
    const path = fileOf(ref, o);
    if (path && insideAllowed(path, o.allowedDirectories, o.platform) && !o.readDenied(path) && !out.includes(ref)) out.push(ref);
  }
  return out.slice(0, o.maxCount);
}

export interface Attached {
  /** One part per attached file, `<attached-file path="…">…</attached-file>`. */
  readonly parts: readonly string[];
  readonly documents: readonly DocumentPart[];
  /** Messages for the user: refused or unreadable references. */
  readonly notices: readonly string[];
  /** The files attached whole, with their state, for the read precondition of the writing tools (step 6). */
  readonly read: ReadonlyArray<{ readonly path: string; readonly mtimeMs: number; readonly size: number; readonly complete: boolean }>;
}

/** § 5.4, EF-04: the content of each referenced file, read now. */
export function attach(text: string, o: AttachmentOptions, pasted: readonly string[] = []): Attached {
  const parts: string[] = [];
  const documents: DocumentPart[] = [];
  const notices: string[] = [];
  const read: Array<{ path: string; mtimeMs: number; size: number; complete: boolean }> = [];
  const seen = new Set<string>();
  let total = 0;
  let totalChars = 0;
  const maxChars = (o.maxTokens ?? 12_000) * CHARS_PER_TOKEN;
  const maxTotalChars = (o.maxTotalTokens ?? 60_000) * CHARS_PER_TOKEN;
  for (const { ref } of references(text, pasted)) {
    const path = fileOf(ref, o);
    const range = lineRange(ref);
    const key = `${path}#${range.from ?? ""}-${range.to ?? ""}`;
    if (!path || seen.has(key)) continue; // not a file: an ordinary `@` word (FA-01); the same reference once
    seen.add(key);
    if (!insideAllowed(path, o.allowedDirectories, o.platform) || o.readDenied(path)) {
      notices.push(`Ce fichier n'est pas accessible : ${ref}.`); // EF-05, ERR-03, RG-02
      continue;
    }
    if (/\.pdf$/i.test(path) && o.documentReadDenied?.(path)) { notices.push(`Ce fichier n'est pas accessible : ${ref}.`); continue; }
    if (parts.length + documents.length >= o.maxCount) {
      notices.push(`Nombre maximal de pièces jointes atteint (${o.maxCount}) : ${ref} n'est pas joint.`); // ERR-05, CA-07
      continue;
    }
    const shown = (relative(o.cwd, path) || ref).split("\\").join("/");
    let body: string;
    try {
      const stats = statSync(path);
      if (stats.isDirectory()) {
        // § 5.1: a folder is its list, one level, bounded.
        const entries = readdirSync(path, { withFileTypes: true })
          .filter((e) => !o.readDenied(resolve(path, e.name)))
          .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
          .sort();
        body = entries.slice(0, MAX_FOLDER_ENTRIES).join("\n") + (entries.length > MAX_FOLDER_ENTRIES ? `\n[… ${entries.length - MAX_FOLDER_ENTRIES} more entries]` : "");
        parts.push(`<attached-folder path="${shown}">\n${body}\n</attached-folder>`);
        continue;
      }
      if (/\.pdf$/i.test(path) && stats.size + total > o.maxTotalBytes) { notices.push(`Fichier trop volumineux pour le service : ${ref}.`); continue; }
      const bytes = readFileSync(path);
      if (/\.pdf$/i.test(path) && bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
        if (!o.pdf) { notices.push(`Ce modèle ne prend pas en charge les documents PDF : ${ref}.`); continue; }
        if (range.from !== undefined) { notices.push(`Un document PDF ne possède pas de lignes sélectionnables : ${ref}.`); continue; }
        if (total + bytes.length > o.maxTotalBytes) { notices.push(`Fichier trop volumineux pour le service : ${ref}.`); continue; }
        total += bytes.length;
        documents.push({ type: "document", mediaType: "application/pdf", name: shown, sourcePath: path, dataBase64: bytes.toString("base64") });
        continue;
      }
      if (bytes.includes(0)) {
        notices.push(`Type de fichier non pris en charge : ${ref}.`); // ERR-01 of SPEC-MOT-006
        continue;
      }
      if (total + bytes.length > o.maxTotalBytes || totalChars >= maxTotalChars) {
        notices.push(`Certaines pièces jointes ont été omises (limite atteinte) : ${ref} n'est pas joint.`); // EF-06, RG-03, ERR-03
        continue;
      }
      total += bytes.length;
      // CA-01, CA-02: numbered as read_file numbers them, the lines asked only.
      const lines = bytes.toString("utf8").replace(/\r\n/g, "\n").split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      const from = range.from ?? 1;
      const to = Math.min(range.to ?? lines.length, lines.length);
      const numbered: string[] = [];
      let size = 0;
      let cut = false;
      for (let i = from; i <= to; i++) {
        const line = `${i}\t${lines[i - 1] ?? ""}`;
        if (size + line.length > Math.min(maxChars, maxTotalChars - totalChars)) {
          cut = true;
          break;
        }
        numbered.push(line);
        size += line.length + 1;
      }
      totalChars += size;
      // FA-03: the start only, with the mention of the truncation and of the number of lines.
      const note = cut ? `\n[Truncated: lines ${from}–${from + numbered.length - 1} of ${lines.length}; read the rest with read_file.]` : "";
      const attrs = range.from !== undefined ? ` lines="${from}-${to}"` : "";
      body = `${numbered.join("\n")}${note}`;
      parts.push(`<attached-file path="${shown}"${attrs}>\n${body}\n</attached-file>`);
      if (range.from === undefined && !cut) read.push({ path, mtimeMs: stats.mtimeMs, size: stats.size, complete: true });
    } catch {
      notices.push(`Pièce jointe illisible : ${ref}.`); // FA-04, ERR-04: the message goes without it
      continue;
    }
  }
  const agents = [...new Set(references(text, pasted, "&").map(r => r.ref).filter(name => o.agents?.includes(name)))].slice(0, o.maxCount);
  for (const name of agents) parts.push(`<requested-agent name="${name}">The user selected this agent for the request. This mention grants no additional tools or permissions and does not start an agent automatically.</requested-agent>`);
  return { parts, documents, notices, read };
}
