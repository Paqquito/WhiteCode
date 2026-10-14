import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { runToCompletion } from "../src/platform/process";
import { findExecutable } from "../src/platform/system";
import { productEnv } from "./helpers/hooks";
function fixture() {
  const ws = workspace(), git = (cwd: string, args: readonly string[]) => runToCompletion(findExecutable("git")!, ["-c", "core.hooksPath=", ...args], { cwd, env: productEnv(ws, { GIT_TERMINAL_PROMPT: "0" }), timeoutMs: 10000 });
  ws.write("project/original.txt", "ORIGINAL_WORKTREE_WITNESS");
  for (const args of [["init"], ["config", "user.email", "fixture@example.test"], ["config", "user.name", "Fixture"], ["add", "original.txt"], ["commit", "-m", "Fixture baseline"]]) expect(git(ws.project, args).code).toBe(0);
  const folder = (name: string) => join(ws.project, loadIdentity().get("PROJECT_DIR"), "isolated-copies", name);
  return { ws, git, folder };
}
test("SPEC-INT-007/CA-01 — the isolated-copy launch creates and reuses the requested branch from the current revision", async () => {
  const f = fixture(), branch = loadIdentity().get("BRANCH_PREFIX") + "essai";
  for (let i = 0; i < 2; i++) {
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(f.folder("essai"), "original.txt") } }] }, request => { expect(JSON.stringify(request.history)).toContain("ORIGINAL_WORKTREE_WITNESS"); return { text: "ISOLATED_READY" }; }]);
    const result = await cli(["--non-interactive", "--isolated-copy", "essai", "Read baseline"], f.ws, { provider });
    if (result.code !== 0) throw new Error(result.stderr);
    expect(result.code).toBe(0); expect(result.stderr).toContain(f.folder("essai")); expect(result.stdout).toContain("ISOLATED_READY"); expect(f.git(f.folder("essai"), ["symbolic-ref", "--short", "HEAD"]).stdout.trim()).toBe(branch);
  }
  expect(f.git(f.ws.project, ["status", "--porcelain"]).stdout.trim()).toBe("");
}, 25000);

test("TECH — a read in the same model response as copy entry receives the new working folder", async () => {
  const f = fixture();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "open_isolated_copy", input: { name: "same-response" } }, { name: "find_files", input: { pattern: "original.txt" } }] }, request => {
    const history = JSON.stringify(request.history); expect(history).toContain(f.folder("same-response").replace(/\\/g, "\\\\"));
    const results = request.history.flatMap(row => row.role === "user" ? row.parts : []).filter(part => part.type === "tool_result"); expect(JSON.stringify(results.at(-1))).toContain("original.txt");
    expect(JSON.stringify(results.at(-1))).toContain("same-response"); return { text: "FRESH_COPY_CONTEXT" };
  }]);
  const result = await cli(["--non-interactive", "--allow-rule=open_isolated_copy", "Open then search"], f.ws, { provider });
  expect(result.code).toBe(0); expect(result.stdout).toContain("FRESH_COPY_CONTEXT");
}, 20000);

test("TECH — project read denials remain anchored in the original and the launch copy", async () => {
  const f = fixture(), identity = loadIdentity();
  f.ws.write("project/secret/private.txt", "DENIED_COPY_SECRET_49");
  expect(f.git(f.ws.project, ["add", "secret/private.txt"]).code).toBe(0); expect(f.git(f.ws.project, ["commit", "-m", "Private fixture"]).code).toBe(0);
  f.ws.write(`project/${identity.get("PROJECT_DIR")}/config.json`, JSON.stringify({ permissions: { denyRules: ["read_file(secret/**)"] } }));
  for (const launched of [false, true]) {
    const name = launched ? "denied-launch" : "denied-model", copy = f.folder(name);
    const provider = new ScriptedProvider([
      ...(!launched ? [{ toolCalls: [{ name: "open_isolated_copy", input: { name } }] }] : []),
      { toolCalls: [{ name: "read_file", input: { path: join(copy, "secret/private.txt") } }, { name: "read_file", input: { path: join(f.ws.project, "secret/private.txt") } }] },
      request => { expect(JSON.stringify(request.history)).not.toContain("DENIED_COPY_SECRET_49"); return { text: "DENIALS_PRESERVED" }; },
    ]);
    const result = await cli(["--non-interactive", "--allow-project-trust", "--allow-rule=open_isolated_copy", "--allow-rule=read_file", ...(launched ? ["--isolated-copy=" + name] : []), "Check private files"], f.ws, { provider });
    expect(result.code).toBe(0); expect(result.stdout).toContain("DENIALS_PRESERVED");
  }
}, 25000);
test("SPEC-INT-007/CA-02 — a modified launch copy remains on disk and reports its path after the session", async () => {
  const f = fixture(), provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: join(f.folder("dirty"), "new.txt"), content: "COPY_ONLY_CHANGE" } }] }, { text: "done" }]);
  const result = await cli(["--non-interactive", "--approval-mode=auto_edit", "--isolated-copy=dirty", "Write inside copy"], f.ws, { provider });
  expect(result.code).toBe(0); expect(readFileSync(join(f.folder("dirty"), "new.txt"), "utf8")).toBe("COPY_ONLY_CHANGE"); expect(existsSync(join(f.ws.project, "new.txt"))).toBe(false); expect(result.stderr).toContain("Copie conservée"); expect(result.stderr).toContain(f.folder("dirty"));
}, 20000);
test("SPEC-OUT-026/CA-01 — entering a model-created copy changes file and shell working folders and closing keeps the original intact", async () => {
  const f = fixture();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "open_isolated_copy", input: { name: "model-copy" } }] }, { toolCalls: [{ name: "write_file", input: { path: join(f.folder("model-copy"), "copy-only.txt"), content: "MODEL_COPY_WITNESS" } }] }, { toolCalls: [{ name: "run_shell", input: { command: "git symbolic-ref --short HEAD" } }] }, request => { expect(JSON.stringify(request.history)).toContain(loadIdentity().get("BRANCH_PREFIX") + "model-copy"); return { toolCalls: [{ name: "close_isolated_copy", input: { action: "keep" } }] }; }, { toolCalls: [{ name: "write_file", input: { path: join(f.ws.project, "original-only.txt"), content: "ORIGINAL_RESTORED" } }] }, { text: "MODEL_COPY_DONE" }]);
  const result = await cli(["--non-interactive", "--approval-mode=auto_edit", "--allow-rule=open_isolated_copy", "--allow-rule=run_shell", "Use an isolated copy"], f.ws, { provider });
  expect(result.code).toBe(0); expect(result.stdout).toContain("MODEL_COPY_DONE"); expect(readFileSync(join(f.folder("model-copy"), "copy-only.txt"), "utf8")).toBe("MODEL_COPY_WITNESS"); expect(existsSync(join(f.ws.project, "copy-only.txt"))).toBe(false); expect(readFileSync(join(f.ws.project, "original-only.txt"), "utf8")).toBe("ORIGINAL_RESTORED"); expect(existsSync(join(f.folder("model-copy"), "original-only.txt"))).toBe(false);
}, 25000);
test("SPEC-OUT-026/CA-02 — neither a remove call nor its drop_changes flag can discard dirty content without a human confirmation", async () => {
  const f = fixture();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "open_isolated_copy", input: { name: "keep-dirty" } }] }, { toolCalls: [{ name: "write_file", input: { path: join(f.folder("keep-dirty"), "new.txt"), content: "PRESERVE_DIRTY_CONTENT" } }] }, { toolCalls: [{ name: "close_isolated_copy", input: { action: "remove" } }] }, request => { expect(JSON.stringify(request.history)).toContain("Removal refused"); return { toolCalls: [{ name: "close_isolated_copy", input: { action: "remove", drop_changes: true } }] }; }, request => { expect(JSON.stringify(request.history)).toContain("Removal not confirmed"); return { text: "PRESERVED" }; }]);
  const result = await cli(["--non-interactive", "--approval-mode=auto_edit", "--allow-rule=open_isolated_copy", "Use an isolated copy"], f.ws, { provider });
  expect(result.code).toBe(0); expect(readFileSync(join(f.folder("keep-dirty"), "new.txt"), "utf8")).toBe("PRESERVE_DIRTY_CONTENT"); expect(result.stderr).toContain(f.folder("keep-dirty"));
}, 25000);
