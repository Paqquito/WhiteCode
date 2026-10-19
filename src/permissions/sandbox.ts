// Implements: SPEC-PER-015 (CA-02/03, ordinary rules and managed exit veto).
import { basename, dirname } from "node:path";
import { splitCommand } from "./command-split";
import { pathGlob, ruleMatches } from "./rules";
import type { Rule } from "./rules";
import type { ProtectedLocations } from "./paths";
import { isProtectedPath } from "./paths";
import type { SandboxFiles } from "../platform/sandbox-kernel";
import type { PermissionContext } from "./engine";
import { isWithin } from "../platform/system";
export const sandboxRules = (context: PermissionContext): readonly Rule[] => [...(context.managedRulesOnly ? context.rules.filter(rule => rule.scope === "managed") : context.rules), ...context.sessionAllows];
export interface SandboxOptions {
  readonly enabled: boolean;
  readonly autoAllow: boolean;
  readonly allowOutside: boolean;
  readonly excludedCommands: readonly string[];
}
export function sandboxMode(options: SandboxOptions, command: string, outside = false): "disabled" | "outside" | "confined" {
  if (!options.enabled) return "disabled";
  const parsed = splitCommand(command, "posix");
  const excluded = [...parsed.parts, ...parsed.nested].some(part => {
    const program = /^(?:[A-Za-z_]\w*=\S+\s+)*(?:'([^']+)'|"([^"]+)"|([^\s;|&]+))/.exec(part.trim());
    return program !== null && options.excludedCommands.includes(basename(program[1] ?? program[2] ?? program[3]!));
  });
  if (outside || excluded) {
    if (!options.allowOutside) throw Error("Sandbox exit is forbidden by managed policy.");
    return "outside";
  }
  return "confined";
}
export function sandboxContribution(options: SandboxOptions, command: string, outside = false): "allow" | "ask" | undefined {
  const mode = sandboxMode(options, command, outside);
  return mode === "outside" ? "ask" : mode === "confined" && options.autoAllow ? "allow" : undefined;
}
/** Broad restrictive globs may over-restrict, but must never grant an unlisted read or write. */
export function sandboxFiles(input: { cwd: string; home: string; allowed: readonly string[]; rules: readonly Rule[]; protected: ProtectedLocations; readDenied(path: string): boolean }): SandboxFiles {
  const reading = new Set(["read_file", "find_files", "search_content", "code_intelligence"]), writing = new Set(["write_file", "edit_file", "update_notebook_cell"]);
  const exactRoot = (rule: Rule) => { if (!rule.pattern) return undefined; const glob = pathGlob(rule.pattern, rule.anchor, input.cwd, input.home); return glob.endsWith("/**") && !/[?*\[\]{}!]/.test(glob.slice(0, -3)) ? glob.slice(0, -3) : undefined; };
  const restrictiveRoot = (rule: Rule) => { if (!rule.pattern) return "/"; const glob = pathGlob(rule.pattern, rule.anchor, input.cwd, input.home), wildcard = glob.search(/[?*\[\]{}!]/); return wildcard === -1 ? glob : dirname(glob.slice(0, wildcard) + "placeholder"); };
  const grants = input.rules.filter(rule => rule.decision === "allow").map(rule => ({ rule, root: exactRoot(rule) })).filter((entry): entry is { rule: Rule; root: string } => entry.root !== undefined);
  const writable = [...input.allowed, ...grants.filter(entry => writing.has(entry.rule.tool)).map(entry => entry.root)], readable = grants.filter(entry => reading.has(entry.rule.tool)).map(entry => entry.root);
  const directories = input.protected.directories.filter(directory => {
    const copies = input.protected.ownedWorktrees?.filter(copy => isWithin(copy, directory, "linux")) ?? [];
    return !copies.length || ![...writable, ...readable].every(root => !(isWithin(root, directory, "linux") || isWithin(directory, root, "linux")) || copies.some(copy => isWithin(root, copy, "linux")));
  });
  return {
    writable, readable,
    hidden: [...directories, ...input.protected.files, ...input.rules.filter(rule => rule.decision !== "allow" && reading.has(rule.tool)).map(restrictiveRoot)],
    readonly: input.rules.filter(rule => rule.decision !== "allow" && writing.has(rule.tool)).map(restrictiveRoot),
    readDenied: input.readDenied,
    writeDenied: path => isProtectedPath(path, input.protected, "linux") || input.rules.some(rule => rule.decision !== "allow" && writing.has(rule.tool) && ruleMatches(rule, rule.tool, { kind: "paths", access: "write", paths: [path] }, { cwd: input.cwd, home: input.home, platform: "linux" })),
  };
}
