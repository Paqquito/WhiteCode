// Implements: SPEC-OUT-006 (§ 5.3 point 2, EF-02, FA-02, edge cases: symbolic link loops, unreadable folders), SPEC-OUT-007 (§ 5.3 point 3 exclusion files)
// Supports: gap E-047 (exclusion files: `.gitignore` and `.ignore`, subset of their syntax)
// Walks a folder tree, honouring exclusion files and always skipping the internal folder of the version control system.

import { readdirSync, readFileSync, realpathSync, statSync, type Dirent, type Stats } from "node:fs";
import { join, relative, sep } from "node:path";
import picomatch from "picomatch";

const EXCLUSION_FILES = [".gitignore", ".ignore"];
const VCS_FOLDER = ".git";

interface IgnoreRule {
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly test: (relativePath: string) => boolean;
}

interface IgnoreLayer {
  /** Folder of the exclusion file, relative to the root of the walk (`""` for the root). */
  readonly base: string;
  readonly rules: readonly IgnoreRule[];
}

/** Parses the lines of an exclusion file (blank lines, comments, `!`, trailing `/`, anchoring by `/`, `**`). */
export function parseIgnore(text: string, caseInsensitive: boolean): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, "");
    if (line === "" || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    if (line.startsWith("\\#") || line.startsWith("\\!")) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (line === "") continue;
    const glob = anchored ? line : `**/${line}`;
    const matcher = picomatch(glob, { dot: true, nocase: caseInsensitive });
    const inner = picomatch(`${glob}/**`, { dot: true, nocase: caseInsensitive });
    rules.push({ negated, directoryOnly, test: (p) => matcher(p) || (!directoryOnly && inner(p)) });
  }
  return rules;
}

function ignoredBy(layers: readonly IgnoreLayer[], relPath: string, isDirectory: boolean): boolean {
  let ignored = false;
  for (const layer of layers) {
    const local = layer.base === "" ? relPath : relPath.startsWith(`${layer.base}/`) ? relPath.slice(layer.base.length + 1) : undefined;
    if (local === undefined) continue;
    for (const rule of layer.rules) {
      if (rule.directoryOnly && !isDirectory) continue;
      if (rule.test(local)) ignored = !rule.negated;
    }
  }
  return ignored;
}

export interface WalkOptions {
  readonly respectIgnoreFiles: boolean;
  readonly caseInsensitive: boolean;
  /** Absolute time after which the walk stops (FA-02). */
  readonly deadline: number;
  readonly signal: AbortSignal;
  /** Bound on the entries collected (files and folders): beyond, the walk stops (SPEC-IHM-009 EF-06). */
  readonly maxEntries?: number;
  /** Folders are collected too, with their relative path. */
  readonly directories?: boolean;
}

export interface WalkedFile {
  readonly path: string;
  /** Path relative to the root, with forward slashes. */
  readonly relativePath: string;
  readonly stats: Stats;
}

export interface WalkResult {
  readonly files: WalkedFile[];
  readonly timedOut: boolean;
  /** Folders walked, relative to the root (with `directories`). */
  readonly directories: string[];
  /** The bound `maxEntries` was reached. */
  readonly truncated: boolean;
}

/** Every regular file under `root`; folders reached twice through symbolic links are walked once. */
export function walkFiles(root: string, options: WalkOptions, accept: (relativePath: string) => boolean = () => true): WalkResult {
  const files: WalkedFile[] = [];
  const directories: string[] = [];
  const seen = new Set<string>();
  let timedOut = false;
  let truncated = false;
  const full = () => options.maxEntries !== undefined && files.length + directories.length >= options.maxEntries;
  const visit = (dir: string, layers: readonly IgnoreLayer[]): void => {
    if (Date.now() > options.deadline || options.signal.aborted) {
      timedOut = true;
      return;
    }
    if (full()) {
      truncated = true;
      return;
    }
    let real: string;
    try {
      real = realpathSync.native(dir);
    } catch {
      return;
    }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // unreadable folder: ignored
    }
    const rel = relative(root, dir).split(sep).join("/");
    let current = layers;
    if (options.respectIgnoreFiles) {
      for (const name of EXCLUSION_FILES) {
        if (!entries.some((e) => e.name === name)) continue;
        try {
          current = [...current, { base: rel, rules: parseIgnore(readFileSync(join(dir, name), "utf8"), options.caseInsensitive) }];
        } catch {
          // unreadable exclusion file: ignored
        }
      }
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (timedOut || truncated) return;
      if (full()) {
        truncated = true;
        return;
      }
      if (entry.name === VCS_FOLDER) continue;
      const path = join(dir, entry.name);
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      let stats: Stats;
      try {
        stats = statSync(path);
      } catch {
        continue; // broken link
      }
      if (options.respectIgnoreFiles && ignoredBy(current, relPath, stats.isDirectory())) continue;
      if (stats.isDirectory()) {
        if (options.directories) directories.push(relPath);
        visit(path, current);
      }
      else if (stats.isFile() && accept(relPath)) files.push({ path, relativePath: relPath, stats });
    }
  };
  visit(root, []);
  return { files, timedOut, directories, truncated };
}
