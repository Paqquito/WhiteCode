// Implements: SPEC-PER-008 (§ 5.1, § 5.3, FA-01, FA-02, EF-01, EF-02, EF-04, CA-01 to CA-03), SPEC-PER-009 (§ 5.1, § 5.3 steps 1 and 2, EF-01 to EF-03, CA-01, CA-02),
//             SPEC-PER-007 (§ 5.3 steps 1 to 3, FA-01, FA-02, EF-01, EF-02, CA-01, CA-02), SPEC-OUT-009 (CA-02)
// What the tool check of the shells concludes (step 5 of SPEC-PER-001): a command whose every part reads only, inside
// the allowed folders, is allowed; a dangerous command, or one whose program is chosen at run time, is always asked.
// The lists are allow lists: what is not listed is not read-only (EF-01 of SPEC-PER-008).

import { isAbsolute, resolve } from "node:path";
import type { PlatformName } from "../platform/system";
import { comparablePath, realPathOrSelf } from "../platform/system";
import { splitCommand, type Dialect } from "./command-split";

export interface AnalysisContext {
  readonly cwd: string;
  readonly allowedDirectories: readonly string[];
  readonly platform: PlatformName;
  /** Only the nature of the command counts (the flags of the tool), not where its paths lead. */
  readonly ignorePaths?: boolean;
}

export type ShellVerdict = { readonly kind: "read_only" } | { readonly kind: "dangerous"; readonly reason: string } | { readonly kind: "dynamic"; readonly reason: string } | { readonly kind: "other" };

/** Words of a sub-command, quotes removed; `undefined` when a word is expanded at run time (a variable, a home folder). */
export function words(part: string): { readonly words: string[]; readonly expanded: boolean } {
  const out: string[] = [];
  let expanded = false;
  let current = "";
  let quoted = false;
  for (let i = 0; i < part.length; i++) {
    const c = part[i]!;
    if (c === "'" || c === '"') {
      const end = part.indexOf(c, i + 1);
      const inner = part.slice(i + 1, end === -1 ? part.length : end);
      if (c === '"' && /\$/.test(inner)) expanded = true;
      current += inner;
      quoted = true;
      i = end === -1 ? part.length : end;
      continue;
    }
    if (/\s/.test(c)) {
      if (current !== "" || quoted) out.push(current);
      current = "";
      quoted = false;
      continue;
    }
    if (c === "$" || (c === "~" && current === "")) expanded = true;
    current += c;
  }
  if (current !== "" || quoted) out.push(current);
  return { words: out, expanded };
}

/** Programs that only read, with their unsafe options (FA-01: an option that runs code, writes or reaches the network). */
const POSIX_READERS: Readonly<Record<string, { readonly unsafe?: RegExp; readonly maxPaths?: number }>> = {
  ls: {}, pwd: {}, cat: {}, head: {}, tail: { unsafe: /^(-f|--follow|-F)/ }, wc: {}, file: {}, stat: {}, du: {}, df: {}, tree: { unsafe: /^-o$/ },
  which: {}, echo: {}, date: { unsafe: /^(-s|--set)/ }, whoami: {}, uname: {}, hostname: { unsafe: /^-/ }, basename: {}, dirname: {}, realpath: {}, readlink: {},
  grep: {}, egrep: {}, fgrep: {}, rg: { unsafe: /^(--pre|--search-zip|-z)/ }, cmp: {}, comm: {}, cut: {}, nl: {}, md5sum: {}, sha1sum: {}, sha256sum: {},
  sort: { unsafe: /^(-o|--output|--compress-program)/ }, uniq: { maxPaths: 1 }, diff: {}, less: { unsafe: /./ }, more: { unsafe: /./ },
  find: { unsafe: /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/ },
};
/** Sub-commands of the version control that only consult (state, history, differences, branches). */
const GIT_READERS: Readonly<Record<string, RegExp | undefined>> = {
  status: undefined, log: /^(--output|--ext-diff)/, diff: /^(--output|--ext-diff|--no-index)/, show: /^(--output|--ext-diff)/, blame: undefined, "rev-parse": undefined,
  "ls-files": undefined, describe: undefined, shortlog: undefined, "cat-file": undefined,
  branch: /^(-d|-D|-m|-M|-c|-C|--delete|--move|--copy|--set-upstream|-u|--edit-description|-f|--force)/, tag: /^(-d|--delete|-a|-s|-f|-m|-F|--force)/,
  remote: /^(add|remove|rm|rename|set-url|set-head|prune|update)$/,
};
/** PowerShell cmdlets that read (EF-04), with their usual aliases. */
const POWERSHELL_READERS = new Set(
  "get-childitem gci ls dir get-content gc cat type get-location gl pwd select-string sls get-item gi test-path resolve-path get-date get-filehash measure-object measure compare-object diff select-object select sort-object sort format-table ft format-list fl get-command gcm write-output echo"
    .split(" "),
);
const POWERSHELL_UNSAFE = /^-(outfile|encoding|stream)$/i; // nothing written, no alternate stream read

/** EF-03 of SPEC-PER-009: the dangerous families, in both shells. */
function dangerOf(argv: readonly string[], dialect: Dialect, whole: string): string | undefined {
  const [prog = "", ...args] = argv.map((w) => w.toLowerCase());
  const has = (re: RegExp) => args.some((a) => re.test(a));
  if (dialect === "posix") {
    if ((prog === "rm" && has(/^-[a-z]*r/i) && has(/^-[a-z]*f/i)) || (prog === "rm" && has(/^--recursive$/) && has(/^--force$/))) return "a forced recursive deletion";
    if (prog === "find" && has(/^-delete$/)) return "a deletion of every file found";
    if (prog === "shred" || prog === "wipefs" || prog.startsWith("mkfs") || (prog === "dd" && has(/^of=\/dev\//))) return "an erasure of a disk or of files";
    if ((prog === "chmod" || prog === "chown" || prog === "chgrp") && has(/^(-[a-z]*r|--recursive)$/i)) return "a recursive change of rights or owner";
    if (["sudo", "su", "doas", "pkexec"].includes(prog)) return "an elevation of privileges";
    if (["shutdown", "reboot", "halt", "poweroff"].includes(prog) || ((prog === "systemctl" || prog === "service") && has(/^(stop|disable|mask|kill|restart)$/))) return "a change of the system or of its services";
    if (prog === "git") {
      const sub = args.find((a) => !a.startsWith("-")) ?? "";
      if (sub === "push" && (has(/^(-f|--force|--force-with-lease.*|--mirror|--delete|-d)$/) || args.some((a) => /^\+|^:/.test(a)))) return "a forced push or a deletion of a remote branch";
      if (sub === "reset" && has(/^--hard$/)) return "a destructive reset of the repository";
      if (sub === "clean" && has(/^-[a-z]*f/)) return "a deletion of the untracked files";
      if (sub === "filter-branch" || sub === "filter-repo" || (sub === "rebase" && has(/^(-i|--interactive|--root)$/))) return "a rewriting of the history";
      if (sub === "branch" && has(/^-D$/)) return "a forced deletion of a branch";
      if (sub === "checkout" && has(/^(-f|--force|--)$/) && args.length > 2) return "a loss of uncommitted changes";
    }
  } else {
    const cmd = prog.replace(/^[&.]\s*/, "");
    if (["invoke-expression", "iex"].includes(cmd)) return "a dynamic evaluation of code";
    if (cmd === "set-executionpolicy" || /-executionpolicy\s+bypass/i.test(whole)) return "a bypass of the execution policy";
    if (["remove-item", "ri", "rm", "rmdir", "rd", "del", "erase"].includes(cmd) && has(/^-(r|recurse)/) && has(/^-(fo|force)/)) return "a forced recursive deletion";
    if (["format-volume", "clear-disk", "remove-partition", "initialize-disk"].includes(cmd)) return "an erasure of a disk";
    if (["stop-computer", "restart-computer", "stop-service", "spsv", "remove-service", "set-acl"].includes(cmd)) return "a change of the system, of its services or of the rights";
    if (/\b(HKLM|HKCU|HKCR|HKU|HKCC|Registry)::?/i.test(whole) && /^(set|new|remove|rename|move)-item/.test(cmd)) return "a modification of the registry";
    if (cmd === "start-process" && has(/^-verb$/) && /runas/i.test(whole)) return "an elevation of privileges";
  }
  return undefined;
}

/** Download followed by execution, across a pipeline (family « exécution distante »). */
function remoteExecution(parts: readonly string[]): boolean {
  for (let i = 0; i + 1 < parts.length; i++) {
    const a = words(parts[i]!).words[0]?.toLowerCase() ?? "";
    const b = words(parts[i + 1]!).words[0]?.toLowerCase() ?? "";
    if (["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod"].includes(a) && ["sh", "bash", "zsh", "dash", "python", "python3", "perl", "ruby", "node", "iex", "invoke-expression", "pwsh", "powershell"].includes(b)) return true;
  }
  return false;
}

function insideAllowed(arg: string, c: AnalysisContext): boolean {
  if (c.ignorePaths) return true;
  const p = isAbsolute(arg) || /^[a-zA-Z]:[\\/]/.test(arg) ? arg : resolve(c.cwd, arg);
  const real = realPathOrSelf(p);
  const within = (x: string, d: string) => {
    const cx = comparablePath(x, c.platform);
    const cd = comparablePath(d, c.platform).replace(/\/+$/, "");
    return cx === cd || cx.startsWith(`${cd}/`);
  };
  return c.allowedDirectories.some((d) => within(p, d) && within(real, d));
}

/** One sub-command reads only, inside the allowed folders (steps 1 to 4 of § 5.3 of SPEC-PER-008). */
function readsOnly(part: string, dialect: Dialect, c: AnalysisContext): boolean {
  const { words: argv, expanded } = words(part);
  if (expanded || argv.length === 0) return false;
  const [prog, ...args] = argv;
  const paths = (list: readonly string[]) => list.filter((a) => !a.startsWith("-"));
  if (dialect === "posix") {
    if (prog === "git") {
      const subIndex = args.findIndex((a) => !a.startsWith("-"));
      if (subIndex !== 0) return false; // options before the sub-command (-c, -C) change what runs
      const sub = args[0]!;
      if (!(sub in GIT_READERS)) return false;
      const unsafe = GIT_READERS[sub];
      const rest = args.slice(1);
      if (unsafe && rest.some((a) => unsafe.test(a))) return false;
      if (sub === "remote" && rest.some((a) => !a.startsWith("-"))) return rest.every((a) => a === "-v" || a === "--verbose" || a === "show" || !a.startsWith("-")) && !rest.some((a) => /^(add|remove|rm|rename|set-url|set-head|prune|update)$/.test(a));
      return paths(rest).every((a) => insideAllowed(a, c));
    }
    const spec = POSIX_READERS[prog!];
    if (!spec) return false;
    if (spec.unsafe && args.some((a) => spec.unsafe!.test(a))) return false;
    if (spec.maxPaths !== undefined && paths(args).length > spec.maxPaths) return false;
    // FA-02: a path outside the allowed folders is asked (grep's pattern is checked as a path too: prudent).
    return paths(args).every((a) => insideAllowed(a, c));
  }
  const cmd = prog!.toLowerCase();
  if (cmd === "git") return readsOnly(part, "posix", c);
  if (!POWERSHELL_READERS.has(cmd)) return false;
  if (args.some((a) => POWERSHELL_UNSAFE.test(a))) return false;
  return paths(args).every((a) => insideAllowed(a, c));
}

/** The verdict of the tool check for a whole command line. */
export function analyseShellCommand(command: string, dialect: Dialect, c: AnalysisContext): ShellVerdict {
  const split = splitCommand(command, dialect);
  const all = [...split.parts, ...split.nested];
  // SPEC-PER-009: the most restrictive part decides; a danger is always told (EF-02).
  for (const part of all) {
    const danger = dangerOf(words(part).words, dialect, part);
    if (danger) return { kind: "dangerous", reason: `This command performs ${danger}.` };
  }
  if (remoteExecution(split.parts)) return { kind: "dangerous", reason: "This command downloads code and runs it at once." };
  // FA-02 of SPEC-PER-007, CA-02: a program chosen at run time (a variable, a substitution in the program position).
  for (const part of split.parts) {
    const first = part.trim().replace(/^&\s*/, "");
    if (/^["']?\$/.test(first) || first.startsWith("`")) return { kind: "dynamic", reason: "The program of this command is chosen when it runs." };
  }
  // SPEC-PER-008 § 5.3 step 5: read-only only when every part is recognised (EF-02 of SPEC-PER-007).
  if (split.complete && split.parts.length > 0 && split.parts.every((p) => readsOnly(p, dialect, c))) return { kind: "read_only" };
  return { kind: "other" };
}

/** An `allow` rule that names exactly this command lifts the confirmation of a danger (step 2 of § 5.3 of SPEC-PER-009). */
export function exactlyAllowed(command: string, patterns: readonly string[]): boolean {
  const normal = command.trim().replace(/\s+/g, " ");
  return patterns.some((p) => !p.includes("*") && p.trim().replace(/\s+/g, " ") === normal);
}
