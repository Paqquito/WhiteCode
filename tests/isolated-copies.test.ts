import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IsolatedCopies } from "../src/integrations/isolated-copies";
import { runToCompletion } from "../src/platform/process";
import { findExecutable } from "../src/platform/system";
import { workspace } from "./helpers/env";
const git = (cwd: string, args: readonly string[]) => runToCompletion(findExecutable("git")!, ["--no-optional-locks", ...args], { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>, timeoutMs: 10000 });
function fixture() { const ws = workspace(); for (const args of [["init"], ["config", "user.email", "fixture@example.test"], ["config", "user.name", "Fixture"], ["add", "."], ["commit", "--allow-empty", "-m", "Initial"]]) if (git(ws.project, args).code !== 0) throw new Error("Git fixture failed"); return { ws, manager: new IsolatedCopies(ws.project, { git, directory: ".copies", branchPrefix: "fixture/", copyFiles: () => [".env.fixture"] }) }; }
test("TECH — an isolated copy uses the current revision, stays excluded and reuses its registered folder", () => {
  const { ws, manager } = fixture(); ws.write("project/.gitignore", ".env.fixture\n"); ws.write("project/.env.fixture", "SYNTHETIC_LOCAL_VALUE");
  const copy = manager.open("check"); try { expect(copy.branch).toBe("fixture/check"); expect(git(copy.path, ["rev-parse", "HEAD"]).stdout.trim()).toBe(copy.baseline); expect(readFileSync(join(copy.path, ".env.fixture"), "utf8")).toBe("SYNTHETIC_LOCAL_VALUE"); expect(git(ws.project, ["status", "--porcelain"]).stdout).not.toContain(".copies"); manager.close("keep"); expect(manager.open("check", true).path).toBe(copy.path); } finally { if (manager.active) manager.close("remove", true); }
}, 20000);

test("TECH — a live copy has one kernel lease and model tools cannot adopt a retained copy", () => {
  const { ws, manager } = fixture(), other = new IsolatedCopies(ws.project, manager.options), copy = manager.open("exclusive");
  try {
    expect(() => other.open("exclusive", true)).toThrow("another session");
    manager.close("keep");
    expect(() => other.open("exclusive")).toThrow("cannot adopt");
    expect(other.open("exclusive", true).path).toBe(copy.path);
  } finally { if (other.active) other.close("remove", true); if (manager.active) manager.close("remove", true); }
}, 20000);
test("TECH — dirty worktrees and new commits are retained, while an unowned existing folder is refused", () => {
  const { ws, manager } = fixture(), copy = manager.open("dirty");
  try { writeFileSync(join(copy.path, "new.txt"), "LOCAL_CHANGE"); expect(manager.changed()).toBe(true); expect(() => manager.close("remove")).toThrow("confirmation"); expect(existsSync(copy.path)).toBe(true); manager.close("keep"); expect(manager.active).toBeUndefined(); expect(readFileSync(join(copy.path, "new.txt"), "utf8")).toBe("LOCAL_CHANGE"); } finally { if (!manager.active) manager.open("dirty", true); manager.close("remove", true); }
  ws.write("project/.copies/unowned/not-git", "Untouched"); expect(() => manager.open("unowned")).toThrow("matching Git worktree"); expect(readFileSync(join(ws.project, ".copies/unowned/not-git"), "utf8")).toBe("Untouched");
}, 20000);
test("TECH — switching away from the owned branch cannot hide commits that would be deleted with it", () => {
  const { manager } = fixture(), copy = manager.open("commits");
  try {
    writeFileSync(join(copy.path, "commit-evidence.txt"), "COMMIT_MUST_SURVIVE_49");
    for (const args of [["add", "."], ["commit", "-m", "New work"], ["checkout", "--detach", copy.baseline]]) expect(git(copy.path, args).code).toBe(0);
    expect(manager.changed()).toBe(true); expect(() => manager.close("remove")).toThrow("confirmation");
    expect(git(copy.path, ["show", `${copy.branch}:commit-evidence.txt`]).stdout).toBe("COMMIT_MUST_SURVIVE_49");
  } finally { if (manager.active) manager.close("remove", true); }
}, 20000);
