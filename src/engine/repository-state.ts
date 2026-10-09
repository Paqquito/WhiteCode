// Implements: SPEC-MOT-003 (section 10, FA-04, EF-04, ERR-01, ENF-02, CA-01, CA-02; edge case: thousands of modified files)
// Snapshot of the Git state, taken once per context segment with read-only commands, bounded in time (E-133).
// Supports: SPEC-INT-017 (EF-03, CA-01, CA-02: sanitized remote and explicit repository absence), gap E-133.

import { runToCompletion } from "../platform/process";

const MAX_STATUS_LINES = 30;
const COMMITS = 5;

export interface GitCapture {
  readonly isRepository?: boolean;
  /** Text of the section, or undefined outside a repository or on failure. */
  readonly text?: string;
  /** Reason of an absence other than "not a repository" (ERR-01: logged only). */
  readonly problem?: string;
}

/** Never exposes URL credentials, query or fragment; unknown remote syntax stays private. */
export function sanitizeRemoteUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:", "ssh:", "git:", "file:"].includes(url.protocol)) return undefined;
    if (!value.startsWith(`${url.protocol}//`) || (url.protocol !== "file:" && !url.hostname)) return undefined;
    url.username = ""; url.password = ""; url.search = ""; url.hash = "";
    return url.href;
  } catch {
    const scp = /^[^@/\s]+@([^:@/\s]+):([^?#\s]+)(?:[?#].*)?$/.exec(value);
    return scp ? `${scp[1]}:${scp[2]}` : undefined;
  }
}

/** Captures branch, main branch, status summary and recent commits within `budgetMs` (ENF-02: 2 s). */
export function captureGitState(git: string | undefined, cwd: string, env: Readonly<Record<string, string>>, budgetMs = 2000): GitCapture {
  if (!git) return { problem: "git not found" };
  const deadline = Date.now() + budgetMs;
  let lastError = "";
  const run = (...args: string[]) => {
    const left = deadline - Date.now();
    if (left <= 0) return undefined;
    const r = runToCompletion(git, ["--no-optional-locks", ...args], { cwd, env: { ...env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, timeoutMs: left });
    lastError = r.stderr;
    return r.code === 0 ? r.stdout.replace(/\r\n/g, "\n").trimEnd() : undefined;
  };
  const inside = run("rev-parse", "--is-inside-work-tree");
  if (inside !== "true") return /not a git repository/i.test(lastError) ? { isRepository: false } : { problem: "git detection failed" };
  const branch = run("branch", "--show-current") || run("rev-parse", "--short", "HEAD");
  const refs = (run("for-each-ref", "--format=%(refname:short)|%(symref:short)", "refs/remotes/origin/HEAD", "refs/heads/main", "refs/heads/master") ?? "").split("\n");
  const originHead = refs.find((ref) => ref.startsWith("origin/HEAD|"))?.split("|")[1];
  const main = originHead?.replace(/^origin\//, "") || (refs.includes("main|") ? "main" : refs.includes("master|") ? "master" : undefined);
  const remote = sanitizeRemoteUrl(run("remote", "get-url", "origin"));
  const status = run("status", "--porcelain=v1", "--untracked-files=normal");
  const log = run("log", `-n${COMMITS}`, "--format=%h %s");
  if (status === undefined && log === undefined && Date.now() >= deadline) return { problem: "git too slow" };
  const statusLines = (status ?? "").split("\n").filter((l) => l !== "");
  const shown = statusLines.slice(0, MAX_STATUS_LINES);
  const lines = [
    `- Current branch: ${branch && branch !== "" ? branch : "(detached HEAD)"}`,
    `- Main branch: ${main ?? "unknown"}`,
    ...(remote ? [`- Remote: ${remote}`] : []),
    statusLines.length === 0 ? "- Status: clean" : `- Status: ${statusLines.length} changed or untracked file${statusLines.length === 1 ? "" : "s"}`,
    ...shown.map((l) => `  ${l}`),
    ...(statusLines.length > shown.length ? [`  … and ${statusLines.length - shown.length} more`] : []),
    "- Recent commits:",
    ...(log && log !== "" ? log.split("\n").map((l) => `  ${l}`) : ["  (none)"]),
  ];
  return { text: lines.join("\n"), isRepository: true };
}
