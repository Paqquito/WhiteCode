// Implements: SPEC-MOT-003 (section 10, FA-04, EF-04, ERR-01, ENF-02, CA-01, CA-02; edge case: thousands of modified files)
// Snapshot of the Git state, taken once at session start with read-only commands, bounded in time.

import { runToCompletion } from "../platform/process";

const MAX_STATUS_LINES = 30;
const COMMITS = 5;

export interface GitCapture {
  /** Text of the section, or undefined outside a repository or on failure. */
  readonly text?: string;
  /** Reason of an absence other than "not a repository" (ERR-01: logged only). */
  readonly problem?: string;
}

/** Captures branch, main branch, status summary and recent commits within `budgetMs` (ENF-02: 2 s). */
export function captureGitState(git: string | undefined, cwd: string, env: Readonly<Record<string, string>>, budgetMs = 2000): GitCapture {
  if (!git) return { problem: "git not found" };
  const deadline = Date.now() + budgetMs;
  const run = (...args: string[]) => {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    const r = runToCompletion(git, ["--no-optional-locks", ...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, timeoutMs: left });
    return r.code === 0 ? r.stdout.replace(/\r\n/g, "\n").trimEnd() : undefined;
  };
  const inside = run("rev-parse", "--is-inside-work-tree");
  if (inside !== "true") return {}; // FA-04: not a repository, no section
  const branch = run("branch", "--show-current");
  const originHead = run("symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD");
  const main = originHead?.replace(/^origin\//, "") ?? (run("rev-parse", "--verify", "--quiet", "main") !== undefined ? "main" : run("rev-parse", "--verify", "--quiet", "master") !== undefined ? "master" : undefined);
  const status = run("status", "--porcelain=v1", "--untracked-files=normal");
  const log = run("log", `-n${COMMITS}`, "--format=%h %s");
  if (status === undefined && log === undefined && Date.now() >= deadline) return { problem: "git too slow" };
  const statusLines = (status ?? "").split("\n").filter((l) => l !== "");
  const shown = statusLines.slice(0, MAX_STATUS_LINES);
  const lines = [
    `- Current branch: ${branch && branch !== "" ? branch : "(detached HEAD)"}`,
    `- Main branch: ${main ?? "unknown"}`,
    statusLines.length === 0 ? "- Status: clean" : `- Status: ${statusLines.length} changed or untracked file${statusLines.length === 1 ? "" : "s"}`,
    ...shown.map((l) => `  ${l}`),
    ...(statusLines.length > shown.length ? [`  … and ${statusLines.length - shown.length} more`] : []),
    "- Recent commits:",
    ...(log && log !== "" ? log.split("\n").map((l) => `  ${l}`) : ["  (none)"]),
  ];
  return { text: lines.join("\n") };
}
