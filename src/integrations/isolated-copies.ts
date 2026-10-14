// Implements: SPEC-INT-007 (CA-01/02), SPEC-OUT-026 (CA-01/02).
// Supports: gap E-167.
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, appendFileSync, copyFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import picomatch from "picomatch";
import type { Tool } from "../tools/types";
import { textOutcome } from "../tools/types";
import { tryFileLock } from "../platform/file-lock";
export interface Copy { readonly name: string; readonly path: string; readonly branch: string; readonly baseline: string }
type Git = (cwd: string, args: readonly string[]) => { readonly code: number | null; readonly stdout: string; readonly stderr: string };
function ordinary(path: string): void { for (let cursor = resolve(path); ; cursor = dirname(cursor)) { if (existsSync(cursor)) { const stat = lstatSync(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Isolated-copy directory is not ordinary."); } if (cursor === dirname(cursor)) return; } }
export class IsolatedCopies {
  #active?: Copy;
  #release?: () => void;
  #ignored = new Map<string, string>();
  readonly root: string;
  readonly folder: string;
  constructor(readonly original: string, readonly options: { readonly git: Git; readonly directory: string; readonly branchPrefix: string; readonly copyFiles: () => readonly string[]; readonly warn?: (message: string) => void }) {
    this.root = this.run(["rev-parse", "--show-toplevel"]).trim();
    this.folder = resolve(this.root, options.directory);
    const part = relative(this.root, this.folder);
    if (!part || part.startsWith("..") || isAbsolute(part)) throw new Error("Isolated copies must stay in a dedicated project folder.");
  }
  get active(): Copy | undefined { return this.#active; }
  get cwd(): string { return this.#active?.path ?? this.original; }
  run(args: readonly string[], cwd = this.original): string { const result = this.options.git(cwd, args); if (result.code !== 0) throw new Error(`Git failed: ${result.stderr.slice(0, 1000) || "operation refused"}`); return result.stdout; }
  release(): void { this.#release?.(); this.#release = undefined; }
  open(requested?: string, reuse = false): Copy {
    if (this.#active) throw new Error("An isolated copy is already active.");
    const name = requested ?? `task-${randomUUID().slice(0, 8)}`;
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error("Invalid isolated-copy name.");
    ordinary(this.folder); const leases = join(this.folder, ".leases"); ordinary(leases); mkdirSync(leases, { recursive: true });
    const lock = join(leases, name + ".lock"); if (existsSync(lock)) { const stat = lstatSync(lock); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Invalid isolated-copy lease."); }
    this.#release = tryFileLock(lock); if (!this.#release) throw new Error("The isolated copy is already used by another session.");
    try { return this.#open(name, reuse); } catch (error) { this.release(); throw error; }
  }
  #open(requested: string, reuse: boolean): Copy {
    if (this.#active) throw new Error("An isolated copy is already active.");
    const name = requested ?? `task-${randomUUID().slice(0, 8)}`;
    if (!/^[a-z][a-z0-9-]{0,47}$/.test(name)) throw new Error("Invalid isolated-copy name.");
    const baseline = this.run(["rev-parse", "HEAD"], this.root).trim(), path = join(this.folder, name);
    ordinary(this.folder);
    const entries = this.run(["worktree", "list", "--porcelain", "-z"], this.root).split("\0");
    const registered = entries.some(entry => entry.startsWith("worktree ") && resolve(entry.slice(9)) === resolve(path));
    this.#ignored.clear();
    let branch: string;
    if (existsSync(path)) {
      ordinary(path); if (!registered) throw new Error("The copy folder exists without a matching Git worktree.");
      if (!reuse) throw new Error("The copy already exists; model tools cannot adopt another session's worktree.");
      branch = this.run(["symbolic-ref", "--short", "HEAD"], path).trim();
      if (!branch.startsWith(this.options.branchPrefix)) throw new Error("The existing worktree is not an owned isolated copy.");
    } else {
      mkdirSync(this.folder, { recursive: true });
      const exclude = resolve(this.root, this.run(["rev-parse", "--git-path", "info/exclude"], this.root).trim());
      ordinary(dirname(exclude));
      if (existsSync(exclude)) { const stat = lstatSync(exclude); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("The Git exclude file is not ordinary."); }
      const pattern = "/" + relative(this.root, this.folder).replace(/\\/g, "/") + "/";
      const old = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
      if (!old.split(/\r?\n/).includes(pattern)) appendFileSync(exclude, `\n${pattern}\n`);
      branch = this.options.branchPrefix + name;
      for (let index = 2; this.options.git(this.root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0; index++) { if (index > 100) throw new Error("No free isolated branch name."); branch = `${this.options.branchPrefix}${name}-${index}`; }
      this.run(["check-ref-format", "--branch", branch], this.root);
      this.run(["worktree", "add", "-b", branch, "--", path, "HEAD"], this.root);
      try { this.#copyIgnored(path); this.#ignored = this.#ignoredHashes(path); } catch (error) { this.run(["worktree", "remove", "--force", "--", path], this.root); this.run(["branch", "-D", "--", branch], this.root); throw error; }
    }
    return this.#active = { name, path: realpathSync(path), branch, baseline };
  }
  #copyIgnored(target: string): void {
    const patterns = this.options.copyFiles(); if (!patterns.length) return;
    const match = picomatch([...patterns]), listed = this.run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], this.root); let files = 0;
    if (listed.length > 4 * 1024 * 1024) throw new Error("Ignored configuration inventory is excessive.");
    for (const part of listed.split("\0").filter(part => part && match(part))) {
      const source = resolve(this.root, part), inside = relative(this.root, source);
      if (!inside || inside.startsWith("..") || isAbsolute(inside) || source.startsWith(this.folder)) throw new Error("Local configuration escapes the source folder.");
      ordinary(dirname(source)); const stat = lstatSync(source);
      if (++files > 128 || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("Local configuration exceeds copy limits or is linked.");
      const destination = resolve(target, part); ordinary(dirname(destination));
      if (existsSync(destination)) throw new Error("Local configuration would overwrite tracked copy content.");
      mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
    }
  }
  changed(): boolean {
    const active = this.#active; if (!active) return false;
    if (this.run(["status", "--porcelain", "--untracked-files=all"], active.path).trim()) return true;
    if (this.run(["rev-parse", "HEAD"], active.path).trim() !== active.baseline) return true;
    if (this.run(["rev-parse", "--verify", `refs/heads/${active.branch}`], this.root).trim() !== active.baseline) return true;
    const current = this.#ignoredHashes(active.path);
    if (current.size !== this.#ignored.size || [...current].some(([path, hash]) => this.#ignored.get(path) !== hash)) return true;
    return false;
  }
  #ignoredHashes(cwd: string): Map<string, string> {
    const listed = this.run(["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], cwd), hashes = new Map<string, string>();
    if (listed.length > 4 * 1024 * 1024) throw new Error("Ignored-file inventory is excessive; preserve the copy.");
    for (const part of listed.split("\0").filter(Boolean)) {
      if (hashes.size >= 128) throw new Error("Too many ignored files; preserve the copy.");
      const path = resolve(cwd, part), inside = relative(cwd, path); if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("Ignored file escapes the copy.");
      ordinary(dirname(path)); const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new Error("Ignored file is not ordinary or too large; preserve the copy.");
      hashes.set(part, createHash("sha256").update(readFileSync(path)).digest("hex"));
    } return hashes;
  }
  close(action: "keep" | "remove", confirmed = false): Copy {
    const active = this.#active; if (!active) throw new Error("No isolated copy belongs to this session.");
    if (action === "remove") {
      ordinary(active.path);
      if (this.changed() && !confirmed) throw new Error("Uncommitted changes or new commits would be lost. Explicit confirmation is required.");
      this.run(["worktree", "remove", "--force", "--", active.path], this.root);
      this.#active = undefined;
      try { this.run(["branch", "-D", "--", active.branch], this.root); }
      catch { this.options.warn?.(`Copie supprimée ; branche ${active.branch} conservée, nettoyage Git à reprendre manuellement.`); }
    }
    this.#active = undefined; this.release(); return active;
  }
}
export function isolatedCopyTools(options: { readonly manager: () => IsolatedCopies; readonly idle: () => boolean; readonly switch: (path: string) => void; readonly confirmDrop: (message: string, signal: AbortSignal) => Promise<boolean>; readonly hook: (event: "isolated_copy_created" | "isolated_copy_removed", fields: Record<string, unknown>) => void }): Tool<never>[] {
  const flags = () => ({ readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false });
  const open: Tool<{ name?: string }> = {
    name: "open_isolated_copy", inputSchema: { type: "object", properties: { name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" } }, additionalProperties: false },
    description: () => "Enter a new isolated Git worktree from the current revision, with ordinary permission checks. Local ignored configuration is copied only from the configured allowlist. Return to the original folder with close_isolated_copy.", flags: () => ({ ...flags(), requiresPermission: true }), isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), summary: input => `Copie isolée ${input.name ?? "nouvelle"}`,
    async execute(input, ctx) { ctx.signal.throwIfAborted(); if (!options.idle()) return textOutcome("Stop active background tasks before changing the working folder.", true, "unavailable"); const copy = options.manager().open(input.name); options.switch(copy.path); options.hook("isolated_copy_created", { path: copy.path, branch: copy.branch }); return textOutcome(`Working folder: ${copy.path}\nBranch: ${copy.branch}`); },
  };
  const close: Tool<{ action: "keep" | "remove"; drop_changes?: boolean }> = {
    name: "close_isolated_copy", inputSchema: { type: "object", properties: { action: { enum: ["keep", "remove"] }, drop_changes: { type: "boolean" } }, required: ["action"], additionalProperties: false },
    description: () => "Return to the original folder and keep or remove only this session's isolated copy. A dirty copy cannot be removed without a separate human confirmation; setting drop_changes merely requests that confirmation.", flags: input => ({ ...flags(), destructive: input.action === "remove" }), isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: input => `Copie isolée : ${input.action === "keep" ? "conserver" : "supprimer"}`,
    async execute(input, ctx) { ctx.signal.throwIfAborted(); if (!options.idle()) return textOutcome("Stop active background tasks before changing the working folder.", true, "unavailable"); const manager = options.manager(); let confirmed = false; if (input.action === "remove" && manager.changed()) { if (!input.drop_changes) return textOutcome("Uncommitted changes would be lost. Removal refused.", true, "permission_denied"); confirmed = await options.confirmDrop(`Supprimer la copie ${manager.active?.path} et perdre ses changements et commits ?`, ctx.signal); if (!confirmed) return textOutcome("Removal not confirmed.", true, "permission_denied"); ctx.signal.throwIfAborted(); } const copy = manager.close(input.action, confirmed); options.switch(manager.original); if (input.action === "remove") options.hook("isolated_copy_removed", { path: copy.path, branch: copy.branch }); return textOutcome(`Original working folder restored: ${manager.original}\nCopy ${input.action === "keep" ? "kept" : "removed"}: ${copy.path}`); },
  }; return [open, close] as Tool<never>[];
}
