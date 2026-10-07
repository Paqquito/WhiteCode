// Implements: SPEC-IHM-010 (§ 5.4 attachments by location, § 5.5 limits, FA-04, EF-04 to EF-06, EF-10, ERR-03 to ERR-05, RG-01 to RG-03, CA-05, CA-07)
// The files referenced by `@` in a message, read when the message is sent (so that the current state goes), within the
// allowed folders and the reading rules, bounded in number and in size. A reference inside a pasted text or inside code
// attaches nothing.

import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { insideAllowed } from "../permissions/paths";
import type { PlatformName } from "../platform/system";

export interface AttachmentOptions {
  readonly cwd: string;
  readonly allowedDirectories: readonly string[];
  readonly platform: PlatformName;
  readonly readDenied: (path: string) => boolean;
  readonly maxCount: number;
  readonly maxTotalBytes: number;
}

/** Spans of code (fenced blocks and inline code). */
function codeSpans(text: string): Array<[number, number]> {
  return [...text.matchAll(/```[\s\S]*?(```|$)|`[^`\n]*`/g)].map((m) => [m.index!, m.index! + m[0].length]);
}

/** The `@<path>` references at a trigger position (start or after a blank), outside code and outside pasted texts. */
export function references(text: string, pasted: readonly string[] = []): Array<{ ref: string; at: number }> {
  const code = codeSpans(text);
  const excluded: Array<[number, number]> = [];
  for (const p of pasted) {
    if (p === "") continue;
    for (let at = text.indexOf(p); at !== -1; at = text.indexOf(p, at + p.length)) excluded.push([at, at + p.length]);
  }
  const out: Array<{ ref: string; at: number }> = [];
  for (const m of text.matchAll(/(^|\s)@([^\s@`]+)/g)) {
    const at = m.index! + m[1]!.length;
    if (code.some(([a, b]) => at >= a && at < b) || excluded.some(([a, b]) => at >= a && at < b)) continue;
    out.push({ ref: m[2]!.replace(/[),.;:!?]+$/, ""), at });
  }
  return out;
}

function fileOf(ref: string, o: AttachmentOptions): string | undefined {
  const path = isAbsolute(ref) ? ref : resolve(o.cwd, ref);
  try {
    return statSync(path).isFile() ? path : undefined;
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
  /** Messages for the user: refused or unreadable references. */
  readonly notices: readonly string[];
}

/** § 5.4, EF-04: the content of each referenced file, read now. */
export function attach(text: string, o: AttachmentOptions, pasted: readonly string[] = []): Attached {
  const parts: string[] = [];
  const notices: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  for (const { ref } of references(text, pasted)) {
    const path = fileOf(ref, o);
    if (!path || seen.has(path)) continue; // not a file: an ordinary `@` word
    seen.add(path);
    if (!insideAllowed(path, o.allowedDirectories, o.platform) || o.readDenied(path)) {
      notices.push(`Ce fichier n'est pas accessible : ${ref}.`); // EF-05, ERR-03, RG-02
      continue;
    }
    if (parts.length >= o.maxCount) {
      notices.push(`Nombre maximal de pièces jointes atteint (${o.maxCount}) : ${ref} n'est pas joint.`); // ERR-05, CA-07
      continue;
    }
    let content: string;
    try {
      const bytes = readFileSync(path);
      if (bytes.includes(0)) {
        notices.push(`Pièce jointe non textuelle, non jointe : ${ref}.`);
        continue;
      }
      if (total + bytes.length > o.maxTotalBytes) {
        notices.push(`Taille maximale des pièces jointes atteinte : ${ref} n'est pas joint.`); // EF-06, RG-03
        continue;
      }
      total += bytes.length;
      content = bytes.toString("utf8");
    } catch {
      notices.push(`Pièce jointe illisible : ${ref}.`); // FA-04, ERR-04: the message goes without it
      continue;
    }
    const shown = relative(o.cwd, path) || ref;
    parts.push(`<attached-file path="${shown.split("\\").join("/")}">\n${content.replace(/\n$/, "")}\n</attached-file>`);
  }
  return { parts, notices };
}
