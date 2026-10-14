// Implements: SPEC-IHM-009 (§ 5.1 triggers and sources, § 5.2 filtering and ranking, § 5.3 presentation data, FA-01, FA-02, FA-05, FA-06, EF-02, EF-03, EF-06, EF-07, ERR-02, RG-01, CA-01 to CA-03, CA-06), SPEC-IHM-007 (FA-06 trigger positions, CA-09)
// Completion of the input: the trigger under the caret (`/` at the start for commands, `@` at the start or after a blank
// for files and folders), tolerant filtering (sub-sequence, case and separators ignored, one or two typing errors) and a
// ranking by quality of the match, use and proximity.

import { join } from "node:path";
import { walkFiles } from "../tools/file-walk";

export interface Candidate {
  /** Text inserted after the trigger. */
  readonly value: string;
  readonly description?: string;
  /** Source shown for the commands (EF-07, § 12: the source of each proposal is shown). */
  readonly source?: string;
  readonly kind: "command" | "file" | "directory";
}

export interface Trigger {
  readonly trigger: "/" | "@";
  /** Offset of the trigger character in the text. */
  readonly start: number;
  /** Partial term typed after the trigger, up to the caret. */
  readonly term: string;
}

/** Spans of code (fenced blocks and inline code), where `@` triggers nothing. */
function inCode(text: string, at: number): boolean {
  for (const m of text.matchAll(/```[\s\S]*?(```|$)|`[^`\n]*`/g)) if (at >= m.index! && at < m.index! + m[0].length) return true;
  return false;
}

/** The trigger under the caret, if any (FA-06 of SPEC-IHM-007). */
export function detectTrigger(text: string, caret: number): Trigger | undefined {
  const before = text.slice(0, caret);
  const command = /^\s*\/([^\s/]*)$/.exec(before);
  if (command && !before.trimStart().startsWith("//")) return { trigger: "/", start: before.indexOf("/"), term: command[1]! };
  const at = before.lastIndexOf("@");
  if (at === -1) return undefined;
  const term = before.slice(at + 1);
  if (/\s/.test(term) || term.startsWith("@")) return undefined;
  // CA-09: `@` only at the start or after a blank, never inside a word (an address) nor in code.
  if (at > 0 && !/\s/.test(before[at - 1]!)) return undefined;
  if (inCode(text, at)) return undefined;
  return { trigger: "@", start: at, term };
}

const normalise = (s: string) => s.toLowerCase().replace(/[-_ .]/g, "");

/** Edit distance where exchanging two neighbouring characters is one typing error (optimal string alignment). */
function typingDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1);
    }
  return d[a.length]![b.length]!;
}

/**
 * Quality of a match, lower is better, or undefined: 0 exact, 1 prefix, 2 contained, 3 sub-sequence, 4 within one or two
 * typing errors of a prefix (EF-03, CA-02).
 */
export function matchQuality(term: string, candidate: string, fuzzy: boolean): number | undefined {
  if (term === "") return 1;
  const t = term.toLowerCase();
  const c = candidate.toLowerCase();
  if (c === t) return 0;
  if (c.startsWith(t)) return 1;
  // For a path, the last segment counts as a start too.
  const base = c.slice(c.lastIndexOf("/", c.length - 2) + 1);
  if (base.startsWith(t)) return 1;
  if (c.includes(t)) return 2;
  if (!fuzzy) return undefined;
  const nt = normalise(term);
  const nc = normalise(candidate);
  let i = 0;
  for (const ch of nc) if (ch === nt[i]) i++;
  if (i === nt.length) return 3;
  const allowed = nt.length >= 6 ? 2 : nt.length >= 3 ? 1 : 0;
  if (allowed > 0) {
    const nb = normalise(base);
    for (const target of [nc, nb]) {
      for (const len of [nt.length - 1, nt.length, nt.length + 1]) {
        if (len <= 0 || len > target.length) continue;
        if (typingDistance(nt, target.slice(0, len)) <= allowed) return 4;
      }
    }
  }
  return undefined;
}

export interface UsageStats {
  readonly count: number;
  readonly last: number;
}

/** § 5.2: matches ranked by quality, then use (frequency, recency), then proximity, then name; exact matches first. */
export function rankCandidates(term: string, candidates: readonly Candidate[], o: { fuzzy: boolean; usage: ReadonlyMap<string, UsageStats> }): Candidate[] {
  const scored: Array<{ c: Candidate; q: number }> = [];
  for (const c of candidates) {
    const q = matchQuality(term, c.value, o.fuzzy);
    if (q !== undefined) scored.push({ c, q });
  }
  const use = (c: Candidate) => o.usage.get(c.value);
  const latest = Math.max(0, ...[...o.usage.values()].map(value => value.last));
  const usageScore = (c: Candidate) => { const value = use(c); return value ? value.count / (1 + Math.max(0, latest - value.last) / 604800000) : 0; };
  const depth = (c: Candidate) => c.value.split("/").filter((s) => s !== "").length;
  scored.sort(
    (a, b) =>
      a.q - b.q ||
      usageScore(b.c) - usageScore(a.c) ||
      (use(b.c)?.last ?? 0) - (use(a.c)?.last ?? 0) ||
      depth(a.c) - depth(b.c) ||
      (a.c.value < b.c.value ? -1 : a.c.value > b.c.value ? 1 : 0),
  );
  return scored.map((s) => s.c);
}

export interface FileIndex {
  readonly entries: readonly Candidate[];
  /** The walk stopped on a bound (FA-05, ERR-02): results are partial. */
  readonly partial: boolean;
}

/**
 * The files and folders of the project that may be proposed (EF-02, EF-06, RG-01): the exclusion files of the project
 * apply, a path refused to reading is never proposed, and the walk is bounded in entries and in time.
 */
export function buildFileIndex(root: string, o: { readonly maxEntries: number; readonly timeoutMs: number; readonly respectIgnoreFiles: boolean; readonly caseInsensitive: boolean; readonly readDenied: (path: string) => boolean }): FileIndex {
  const walk = walkFiles(root, {
    respectIgnoreFiles: o.respectIgnoreFiles,
    caseInsensitive: o.caseInsensitive,
    deadline: Date.now() + o.timeoutMs,
    signal: new AbortController().signal,
    maxEntries: o.maxEntries,
    directories: true,
  });
  const entries: Candidate[] = [];
  for (const d of walk.directories) if (!o.readDenied(join(root, d))) entries.push({ value: `${d}/`, kind: "directory" });
  for (const f of walk.files) if (!o.readDenied(f.path)) entries.push({ value: f.relativePath, kind: "file" });
  return { entries, partial: walk.timedOut || walk.truncated };
}
