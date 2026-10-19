// Supports: SPEC-CMD-091, SPEC-MOD-015, SPEC-PER-023 (preflight before Git mutation and identity-bound recovery).
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { HandoffGit } from "../src/remote/handoff-git";
import { forgeInstallFixture } from "./helpers/forge-install";
type Fixture = Awaited<ReturnType<typeof forgeInstallFixture>>;
function engine(f: Fixture) {
  const commands: string[][] = []; let spawned = 0, closed = 0, children = 0;
  const transfer = new HandoffGit({ git: Bun.which("git")!, cwd: f.ws.project, environment: { ...f.environment, GIT_SSL_CAINFO: f.program.args.at(-1)! },
    launch: (file, args, _cwd, environment) => { commands.push([...args]); return { file, args: ["-c", "http.extraHeader=Authorization: Basic " + Buffer.from("fixture-human:fixture-forge-auth").toString("base64"), ...args], environment, fds: [], spawned: () => { spawned++; }, close: () => { closed++; } }; },
    child: () => { children++; },
  });
  return { transfer, commands, checkRouting: () => { expect(spawned).toBe(commands.length); expect(closed).toBe(commands.length); expect(children).toBe(commands.length); } };
}
function snapshot(f: Fixture) {
  return { branch: f.run(["branch", "--show-current"]), head: f.run(["rev-parse", "HEAD"]), status: f.run(["status", "--porcelain=v1", "--untracked-files=all"]), index: f.run(["ls-files", "--stage"]), objects: createHash("sha256").update(f.run(["cat-file", "--batch-all-objects", "--batch"])).digest("hex") };
}
function noMutatingGit(commands: string[][]) {
  const writers = new Set(["stash", "hash-object", "write-tree", "read-tree", "update-index", "commit-tree", "update-ref"]);
  expect(commands.some(args => args.some(value => writers.has(value)))).toBe(false);
}

test("TECH — handoff rejects a sensitive worktree file before any Git object or recovery ref is written", async () => {
  const f = await forgeInstallFixture(); f.run(["remote", "add", "origin", f.origin + "/owner/project.git"]);
  const e = engine(f), file = join(f.ws.project, "hello.txt"), marker = "token=fixturecredential";
  try {
    writeFileSync(file, marker + "\n"); const before = snapshot(f);
    await e.transfer.inspect(AbortSignal.timeout(10000)); await expect(e.transfer.capture(AbortSignal.timeout(15000))).rejects.toThrow("sensible");
    expect(snapshot(f)).toEqual(before); expect(readFileSync(file, "utf8")).toBe(marker + "\n");
    expect(f.run(["cat-file", "--batch-all-objects", "--batch"])).not.toContain(marker);
    expect(e.transfer.recovery).toBeUndefined(); noMutatingGit(e.commands); e.checkRouting();
  } finally { e.transfer.close(); f.close(); }
}, 25000);

test("TECH — handoff screens an already staged sensitive version even when its worktree version is benign", async () => {
  const f = await forgeInstallFixture(); f.run(["remote", "add", "origin", f.origin + "/owner/project.git"]);
  const e = engine(f), file = join(f.ws.project, "hello.txt");
  try {
    writeFileSync(file, "token=stagedfixturecredential\n"); f.run(["add", "hello.txt"]); writeFileSync(file, "Fixture project\n"); const before = snapshot(f);
    await e.transfer.inspect(AbortSignal.timeout(10000)); await expect(e.transfer.capture(AbortSignal.timeout(15000))).rejects.toThrow("sensible");
    expect(snapshot(f)).toEqual(before); expect(readFileSync(file, "utf8")).toBe("Fixture project\n");
    expect(e.transfer.recovery).toBeUndefined(); noMutatingGit(e.commands); e.checkRouting();
  } finally { e.transfer.close(); f.close(); }
}, 25000);

test("TECH — handoff rejects sensitive untracked files without moving them or storing their blobs", async () => {
  const f = await forgeInstallFixture(); f.run(["remote", "add", "origin", f.origin + "/owner/project.git"]);
  const e = engine(f), file = join(f.ws.project, "new.txt"), marker = "token=untrackedfixturecredential";
  try {
    writeFileSync(file, marker + "\n"); const before = snapshot(f);
    await e.transfer.inspect(AbortSignal.timeout(10000)); await expect(e.transfer.capture(AbortSignal.timeout(15000))).rejects.toThrow("sensible");
    expect(snapshot(f)).toEqual(before); expect(readFileSync(file, "utf8")).toBe(marker + "\n");
    expect(f.run(["cat-file", "--batch-all-objects", "--batch"])).not.toContain(marker);
    expect(e.transfer.recovery).toBeUndefined(); noMutatingGit(e.commands); e.checkRouting();
  } finally { e.transfer.close(); f.close(); }
}, 25000);

test("TECH — handoff preflight bounds files and rejects binary or invalid UTF-8 before writing Git objects", async () => {
  const f = await forgeInstallFixture(); f.run(["remote", "add", "origin", f.origin + "/owner/project.git"]);
  const e = engine(f), file = join(f.ws.project, "hello.txt");
  try {
    for (const bytes of [Buffer.from([0, 1, 2]), Buffer.from([0xff, 0x80]), Buffer.alloc(2 * 1024 * 1024 + 1, 97)]) {
      writeFileSync(file, bytes); const before = snapshot(f);
      await e.transfer.inspect(AbortSignal.timeout(10000)); await expect(e.transfer.capture(AbortSignal.timeout(15000))).rejects.toThrow();
      expect(snapshot(f)).toEqual(before); expect(readFileSync(file).equals(bytes)).toBe(true); expect(e.transfer.recovery).toBeUndefined();
    }
    noMutatingGit(e.commands); e.checkRouting();
  } finally { e.transfer.close(); f.close(); }
}, 35000);

test("TECH — handoff preflight bounds the aggregate of distinct untracked contents before stash", async () => {
  const f = await forgeInstallFixture(); f.run(["remote", "add", "origin", f.origin + "/owner/project.git"]);
  const e = engine(f);
  try {
    for (let i = 0; i < 9; i++) { const bytes = Buffer.alloc(2 * 1024 * 1024, 97); bytes[0] = 48 + i; writeFileSync(join(f.ws.project, `part-${i}.txt`), bytes); }
    const before = snapshot(f); await e.transfer.inspect(AbortSignal.timeout(10000));
    await expect(e.transfer.capture(AbortSignal.timeout(20000))).rejects.toThrow("volumineux");
    expect(snapshot(f)).toEqual(before); expect(e.transfer.recovery).toBeUndefined(); noMutatingGit(e.commands); e.checkRouting();
  } finally { e.transfer.close(); f.close(); }
}, 30000);

test("TECH — handoff recovery requires the original branch, commit and canonical origin before restoring", async () => {
  const f = await forgeInstallFixture(), origin = f.origin + "/owner/project.git"; f.run(["remote", "add", "origin", origin]);
  const e = engine(f), file = join(f.ws.project, "hello.txt");
  try {
    writeFileSync(file, "Staged source work\n"); f.run(["add", "hello.txt"]); writeFileSync(file, "Unstaged source work\n"); writeFileSync(join(f.ws.project, "new.txt"), "New source file\n");
    const original = snapshot(f); await e.transfer.inspect(AbortSignal.timeout(10000)); await e.transfer.capture(AbortSignal.timeout(20000));
    f.run(["checkout", "-b", "other"]); let before = snapshot(f);
    await expect(e.transfer.recover(AbortSignal.timeout(10000))).rejects.toThrow("Restauration manuelle"); expect(snapshot(f)).toEqual(before);
    f.run(["checkout", "main"]); f.run(["commit", "--allow-empty", "-m", "Unrelated fixture commit"]); const changed = f.run(["rev-parse", "HEAD"]); before = snapshot(f);
    await expect(e.transfer.recover(AbortSignal.timeout(10000))).rejects.toThrow("Restauration manuelle"); expect(snapshot(f)).toEqual(before);
    f.run(["update-ref", "refs/heads/main", f.base, changed]); f.run(["remote", "set-url", "origin", "https://unrelated.fixture.invalid/other.git"]); before = snapshot(f);
    await expect(e.transfer.recover(AbortSignal.timeout(10000))).rejects.toThrow("Restauration manuelle"); expect(snapshot(f)).toEqual(before);
    f.run(["remote", "set-url", "origin", origin.replace(/\.git$/, "")]); f.run(["config", "filter.untrusted.smudge", "echo forbidden-fixture-filter"]); before = snapshot(f);
    await expect(e.transfer.recover(AbortSignal.timeout(10000))).rejects.toThrow("Restauration manuelle"); expect(snapshot(f)).toEqual(before);
    f.run(["config", "--unset", "filter.untrusted.smudge"]); await e.transfer.recover(AbortSignal.timeout(15000));
    const restored = snapshot(f); expect(restored.branch).toBe(original.branch); expect(restored.head).toBe(original.head); expect(restored.status).toBe(original.status); expect(restored.index).toBe(original.index);
    expect(readFileSync(file, "utf8")).toBe("Unstaged source work\n"); expect(readFileSync(join(f.ws.project, "new.txt"), "utf8")).toBe("New source file\n");
    expect(e.transfer.recovery).toMatch(/^refs\/session-handoff\//); e.checkRouting();
  } finally { e.transfer.close(); f.close(); }
}, 45000);

test("TECH — an owned Git timeout cannot be interpreted as an absent optional configuration", async () => {
  const f = await forgeInstallFixture(), original = globalThis.setTimeout;
  let timed = false, pid: number | undefined;
  // Only the product's 30-second guard is accelerated; the real child still has to stop and drain.
  globalThis.setTimeout = ((...args: Parameters<typeof setTimeout>) => { if (args[1] === 30000) args[1] = 250; return original(...args); }) as typeof setTimeout;
  const transfer = new HandoffGit({ git: Bun.which("git")!, cwd: f.ws.project, environment: f.environment,
    launch: (_file, _args, _cwd, environment) => ({ file: process.execPath, args: ["--no-env-file", "-e", "setInterval(()=>{},1000)"], environment, fds: [], spawned: () => {}, close: () => {} }),
    child: child => { pid = child.pid; },
  });
  try {
    try { await transfer.run(["config", "--get", "fixture.optional"], AbortSignal.timeout(10000), undefined, {}, true); } catch { timed = true; }
    expect(timed).toBe(true); expect(pid).toBeGreaterThan(0); expect(() => process.kill(pid!, 0)).toThrow();
  } finally { globalThis.setTimeout = original; transfer.close(); f.close(); }
}, 15000);
