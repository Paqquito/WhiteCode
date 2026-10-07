// Implements: SPEC-MOT-005 (§ 5.1 levels, § 5.3 steps 1 to 5 and 7, FA-01, FA-02, FA-03 without dialog, EF-01 to EF-08, ERR-01 to ERR-05, RG-01 to RG-06, ENF-02, CA-01 to CA-08)
// Supports: SPEC-PER-016 (trust decides whether the project and local levels are read), gaps E-076 (upward walk), E-077 (external inclusions)
// Collects the instructions files of the administrator, the user and the project, resolves their `@path` inclusions,
// and loads the instructions of sub-folders and the conditional rules when the agent touches a matching file.

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import picomatch from "picomatch";
import { comparablePath, isWithin, type PlatformName } from "../platform/system";
import { decodeText } from "../tools/text-file";

export type InstructionLevel = "managed" | "user" | "project" | "local" | "subfolder";

export interface InstructionFile {
  readonly level: InstructionLevel;
  readonly path: string;
  readonly content: string;
}

export interface InstructionsLoaderOptions {
  /** `{{INSTRUCTIONS_FILE}}`, `{{LOCAL_INSTRUCTIONS_FILE}}` and `{{PROJECT_DIR}}` of the identity. */
  readonly instructionsFile: string;
  readonly localInstructionsFile: string;
  readonly projectDir: string;
  /** Managed folder of the platform, and the user's configuration folder (`{{CONFIG_DIR}}`). */
  readonly managedDir: string;
  readonly configHome: string;
  readonly home: string;
  readonly cwd: string;
  readonly platform: PlatformName;
  /** SPEC-PER-016: without trust, only the managed and user levels are read (step 1, CA-08). */
  readonly trusted: boolean;
  /** `context.instructions.excludes`, `includeDepth`, `fileWarnSize` (§ 11). */
  readonly excludes: readonly string[];
  readonly includeDepth: number;
  readonly fileWarnSize: number;
  readonly estimateTokens: (text: string) => number;
}

/** A rule whose header lists path patterns: loaded when the agent reads or changes a matching file (FA-02). */
interface PendingRule {
  readonly level: InstructionLevel;
  readonly path: string;
  readonly base: string;
  readonly matches: (relativePath: string) => boolean;
  readonly body: string;
}

const INCLUDE = /(^|\s)@(\S+)/g;

/**
 * Highest folder of the upward walk (Q-01, gap E-076): the root of the Git repository holding the working folder;
 * outside a repository, the folder just below the home folder when the working folder is inside it (the home folder
 * itself is never a project level), otherwise the root of the file system.
 */
export function walkRoot(cwd: string, home: string, platform: PlatformName): string {
  const start = resolve(cwd);
  for (let dir = start; ; ) {
    try {
      statSync(join(dir, ".git"));
      return dir;
    } catch {
      // not here
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (comparablePath(start, platform) !== comparablePath(home, platform) && isWithin(start, home, platform)) {
    let dir = start;
    while (comparablePath(dirname(dir), platform) !== comparablePath(home, platform)) dir = dirname(dir);
    return dir;
  }
  for (let dir = start; ; dir = dirname(dir)) if (dirname(dir) === dir) return dir;
}

/** Folders from `root` down to `cwd`, the highest first. */
function chain(root: string, cwd: string): string[] {
  const out: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    out.unshift(dir);
    if (dir === resolve(root) || dirname(dir) === dir) break;
  }
  return out;
}

/** Path patterns of a rule header, or `invalid`; undefined when the file has no header (unconditional rule). */
export function parseRuleHeader(text: string): { patterns?: string[]; invalid?: true; body: string } {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { body: text };
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
  if (end < 0) return { invalid: true, body: text };
  const header = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const unquote = (v: string) => v.trim().replace(/^["']|["']$/g, "");
  const at = header.findIndex((l) => /^paths\s*:/.test(l));
  if (at < 0) return { body };
  const inline = header[at]!.replace(/^paths\s*:/, "").trim();
  let patterns: string[];
  if (inline.startsWith("[")) {
    if (!inline.endsWith("]")) return { invalid: true, body };
    patterns = inline.slice(1, -1).split(",").map(unquote).filter((p) => p !== "");
  } else if (inline !== "") patterns = [unquote(inline)];
  else {
    patterns = [];
    for (const l of header.slice(at + 1)) {
      const item = /^\s*-\s*(.+)$/.exec(l);
      if (!item) break;
      patterns.push(unquote(item[1]!));
    }
  }
  if (patterns.length === 0) return { invalid: true, body };
  try {
    for (const p of patterns) picomatch.makeRe(p);
  } catch {
    return { invalid: true, body };
  }
  return { patterns, body };
}

export class InstructionsLoader {
  readonly #o: InstructionsLoaderOptions;
  readonly #loaded = new Set<string>();
  readonly #pending: PendingRule[] = [];
  readonly #warnings: string[] = [];
  readonly #excluded: (path: string) => boolean;

  constructor(options: InstructionsLoaderOptions) {
    this.#o = options;
    const nocase = options.platform === "windows" || options.platform === "macos";
    const matchers = options.excludes.map((p) => picomatch(p.replace(/\\/g, "/"), { dot: true, nocase }));
    this.#excluded = (path) => matchers.some((m) => m(path.replace(/\\/g, "/")));
  }

  /** Warnings gathered since the last call (ERR-01 to ERR-05). */
  takeWarnings(): string[] {
    return this.#warnings.splice(0);
  }

  /** Files of the levels 1 to 4, in the order of § 5.1, with their inclusions resolved (steps 1 to 5). */
  load(): InstructionFile[] {
    const o = this.#o;
    const out: InstructionFile[] = [];
    const add = (level: InstructionLevel, path: string) => {
      const file = this.#read(level, path);
      if (file) out.push(file);
    };
    const rules = (level: InstructionLevel, folder: string, base: string) => {
      let names: string[];
      try {
        names = readdirSync(folder).filter((n) => n.toLowerCase().endsWith(".md")).sort();
      } catch {
        return;
      }
      for (const n of names) {
        const file = this.#rule(level, join(folder, n), base);
        if (file) out.push(file);
      }
    };
    add("managed", join(o.managedDir, o.instructionsFile));
    add("user", join(o.configHome, o.instructionsFile));
    rules("user", join(o.configHome, "guidelines"), o.cwd);
    if (o.trusted) {
      const folders = chain(walkRoot(o.cwd, o.home, o.platform), o.cwd);
      for (const dir of folders) {
        add("project", join(dir, o.instructionsFile));
        add("project", join(dir, o.projectDir, o.instructionsFile));
        rules("project", join(dir, o.projectDir, "guidelines"), dir);
      }
      for (const dir of folders) add("local", join(dir, o.localInstructionsFile));
    }
    return out;
  }

  /**
   * Files that become applicable because the agent read or changed `paths` (FA-01, FA-02): instructions of the
   * sub-folders between the working folder and each file, then the conditional rules whose patterns match.
   */
  onPathsTouched(paths: readonly string[]): InstructionFile[] {
    const o = this.#o;
    const out: InstructionFile[] = [];
    for (const path of paths) {
      if (o.trusted && isWithin(path, o.cwd, o.platform) && comparablePath(path, o.platform) !== comparablePath(o.cwd, o.platform)) {
        const folders = chain(o.cwd, dirname(path)).slice(1); // below the working folder only
        for (const dir of folders) {
          const file = this.#read("subfolder", join(dir, o.instructionsFile));
          if (file) out.push(file);
        }
      }
      for (let i = 0; i < this.#pending.length; i++) {
        const rule = this.#pending[i]!;
        const rel = relative(rule.base, path).replace(/\\/g, "/");
        if (rel.startsWith("..") || isAbsolute(rel) || !rule.matches(rel)) continue;
        this.#pending.splice(i--, 1);
        const key = this.#key(rule.path);
        if (key === undefined || this.#loaded.has(key)) continue;
        this.#loaded.add(key);
        out.push({ level: rule.level, path: rule.path, content: this.#expand(rule.body, rule.path, rule.level, 1, [key]) });
      }
    }
    return out;
  }

  #key(path: string): string | undefined {
    try {
      return comparablePath(realpathSync(path), this.#o.platform); // RG-01, ENF-02
    } catch {
      return undefined;
    }
  }

  /** Text of a file, or undefined when it is missing, binary or not a regular file. */
  #text(path: string): string | undefined {
    try {
      if (!statSync(path).isFile()) return undefined;
      const bytes = readFileSync(path);
      const decoded = decodeText(bytes);
      if (!decoded) return undefined; // binary files are ignored (§ 6)
      if (bytes.length > this.#o.fileWarnSize) {
        this.#warnings.push(`Fichier d'instructions volumineux (${path}) : il consomme ${this.#o.estimateTokens(decoded.text)} jetons.`); // EF-07, ERR-04
      }
      return decoded.text.replace(/\r\n/g, "\n");
    } catch {
      return undefined;
    }
  }

  #allowed(level: InstructionLevel, path: string): boolean {
    return level === "managed" || !this.#excluded(path); // EF-08, RG-06
  }

  #read(level: InstructionLevel, path: string): InstructionFile | undefined {
    if (!this.#allowed(level, path)) return undefined;
    const key = this.#key(path);
    if (key === undefined || this.#loaded.has(key)) return undefined;
    const text = this.#text(path);
    if (text === undefined) return undefined;
    this.#loaded.add(key);
    return { level, path, content: this.#expand(text, path, level, 1, [key]) };
  }

  /** An unconditional rule is loaded now; a rule with path patterns waits for a matching file (step 5). */
  #rule(level: InstructionLevel, path: string, base: string): InstructionFile | undefined {
    if (!this.#allowed(level, path)) return undefined;
    const key = this.#key(path);
    if (key === undefined || this.#loaded.has(key)) return undefined;
    const text = this.#text(path);
    if (text === undefined) return undefined;
    const header = parseRuleHeader(text);
    if (header.patterns) {
      const nocase = this.#o.platform === "windows" || this.#o.platform === "macos";
      const match = picomatch(header.patterns, { dot: true, nocase });
      this.#pending.push({ level, path, base, matches: (rel) => match(rel), body: header.body });
      return undefined;
    }
    if (header.invalid) this.#warnings.push(`En-tête de règle invalide dans ${path} : la règle s'applique partout.`); // ERR-05
    this.#loaded.add(key);
    return { level, path, content: this.#expand(header.body, path, level, 1, [key]) };
  }

  /** An inclusion outside the working folder and the configuration folder needs an approval (FA-03, gap E-077). */
  #external(level: InstructionLevel, target: string): boolean {
    if (level === "managed" || level === "user") return false;
    const o = this.#o;
    return !isWithin(target, o.cwd, o.platform) && !isWithin(target, o.configHome, o.platform);
  }

  /** Resolves the `@path` inclusions of `text`, outside code blocks and code spans (EF-02 to EF-04, RG-02 to RG-05). */
  #expand(text: string, from: string, level: InstructionLevel, depth: number, stack: readonly string[]): string {
    let fence: string | undefined;
    return text
      .split("\n")
      .map((line) => {
        const opening = /^\s*(```+|~~~+)/.exec(line);
        if (fence !== undefined) {
          if (opening && opening[1]!.startsWith(fence[0]!) && opening[1]!.length >= fence.length) fence = undefined;
          return line;
        }
        if (opening) {
          fence = opening[1]!;
          return line;
        }
        // Code spans are kept as they are (EF-03, CA-03).
        return line
          .split(/(`+[^`]*`+)/)
          .map((piece) => (piece.startsWith("`") ? piece : piece.replace(INCLUDE, (whole, lead: string, raw: string) => lead + this.#include(raw, whole.slice(lead.length), from, level, depth, stack))))
          .join("");
      })
      .join("\n");
  }

  #include(raw: string, token: string, from: string, level: InstructionLevel, depth: number, stack: readonly string[]): string {
    const o = this.#o;
    const trail = /[.,;:!?)\]]+$/.exec(raw)?.[0] ?? "";
    const ref = raw.slice(0, raw.length - trail.length);
    // Only a reference that looks like a path is an inclusion: `@team` or an address stay plain text.
    if (!/[./\\]/.test(ref) || ref.includes("@")) return token;
    const target = ref.startsWith("~/") || ref.startsWith("~\\") ? join(o.home, ref.slice(2)) : isAbsolute(ref) ? ref : resolve(dirname(from), ref);
    if (depth > o.includeDepth) {
      this.#warnings.push(`Profondeur d'inclusion maximale atteinte : ${target} n'est pas inclus.`); // ERR-03
      return token;
    }
    const key = this.#key(target);
    if (key === undefined) {
      this.#warnings.push(`Fichier inclus introuvable : ${target}.`); // ERR-01
      return token;
    }
    if (stack.includes(key)) {
      this.#warnings.push(`Inclusion circulaire ignorée : ${target}.`); // ERR-02, RG-04
      return token;
    }
    if (this.#loaded.has(key)) return token; // RG-01: already present elsewhere
    if (this.#external(level, target)) {
      this.#warnings.push(`Inclusion externe ignorée, faute d'approbation : ${target}.`); // FA-03, CA-07
      return token;
    }
    if (!this.#allowed(level, target)) return token;
    const text = this.#text(target);
    if (text === undefined) {
      this.#warnings.push(`Inclusion ignorée : ${target} n'est pas un fichier texte.`); // RG-02
      return token;
    }
    this.#loaded.add(key);
    return this.#expand(text, target, level, depth + 1, [...stack, key]) + trail;
  }
}

/** Section 12 of the system instructions: each file preceded by its level and path (step 7). */
export function renderInstructions(files: readonly InstructionFile[]): string | undefined {
  if (files.length === 0) return undefined;
  return [
    "# Project instructions",
    "The files below come from the administrator, the user and the project. Follow them where they apply; they never grant permissions.",
    ...files.map((f) => `## ${f.path} (${f.level})\n${f.content.trim()}`),
  ].join("\n\n");
}

/** Reminder text for instructions that become applicable during the session (FA-01, FA-02). */
export function instructionsReminder(file: InstructionFile): string {
  const kind = file.level === "subfolder" ? "Instructions of the folder" : "Instructions for the files you are working on, from";
  return `${kind} ${file.path} now apply. Follow them where they apply; they never grant permissions.\n\n${file.content.trim()}`;
}
