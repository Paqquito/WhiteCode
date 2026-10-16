import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { bunCommand, hook, platform, POSIX, productEnv, record } from "./helpers/hooks";
import { buildSnapshot } from "../src/hooks/config";
import { HookRuntime } from "../src/hooks/runtime";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { runToCompletion } from "../src/platform/process";
import { findExecutable } from "../src/platform/system";

function fixture() {
  const ws = workspace();
  const git = (args: readonly string[]) => runToCompletion(findExecutable("git")!, ["-c", "core.hooksPath=", ...args], { cwd: ws.project, env: productEnv(ws, { GIT_TERMINAL_PROMPT: "0" }), timeoutMs: 10000 });
  ws.write("project/original.txt", "ORIGINAL_FACTORY_WITNESS");
  for (const args of [["init"], ["config", "user.email", "fixture@example.test"], ["config", "user.name", "Fixture"], ["add", "original.txt"], ["commit", "-m", "Fixture baseline"]]) expect(git(args).code).toBe(0);
  const path = join(ws.project, loadIdentity().get("PROJECT_DIR"), "isolated-copies", "custom");
  return { ws, path, git };
}
test.each([
  { event: "after_tool", async: false, actions: [{ type: "command", command: "echo fixture" }] },
  { event: "isolated_copy_created", async: true, actions: [{ type: "command", command: "echo fixture" }] },
  { event: "isolated_copy_created", async: false, actions: [{ type: "command", command: "echo fixture" }, { type: "command", command: "echo fixture" }] },
])("TECH — invalid custom factory declarations are ignored explicitly, case %j", definition => {
  const snapshot = buildSnapshot([{ origin: "user", value: { [definition.event]: [{ ...definition, copyFactory: true }] } }], { noHooks: false, managedOnly: false, maxTimeoutMs: 1000 });
  expect(snapshot.declarations).toHaveLength(0); expect(snapshot.ignored[0]!.reason).toContain("copyFactory");
});

test("TECH — revoking a creation hook while its command runs refuses its late result", async () => {
  const ws = workspace(), ready = join(ws.root, "ready"), gate = join(ws.root, "gate");
  const command = hook(ws, "revoked-factory", `const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(ready)}, "ready"); while (!fs.existsSync(${JSON.stringify(gate)})) await Bun.sleep(10); console.log(JSON.stringify({isolatedCopy:{path:payload.path,branch:payload.branch}}));`);
  const controls = { noHooks: false, managedOnly: false, maxTimeoutMs: 10000 };
  const runtime = new HookRuntime({ snapshot: buildSnapshot([{ origin: "user", value: { isolated_copy_created: [{ copyFactory: true, actions: [{ type: "command", command }] }] } }], controls), sessionId: "factory-test", cwd: ws.project, platform, approvalMode: () => "ask", environment: extra => ({ ...productEnv(ws), ...extra }), envPrefix: "TEST_", shells: POSIX ? { posix: { path: POSIX.path, kind: "posix" } } : { powershell: { path: "powershell.exe", kind: "powershell" } }, commandTimeoutMs: 10000, outputMaxSize: 4000, payloadMaxSize: 4000, http: { timeoutMs: 1000, allowedEnvVars: [] }, maxAsync: 1, asyncKillOnExit: true, report: () => {}, addContext: () => {} });
  const pending = runtime.createIsolatedCopy({ path: join(ws.root, "copy"), branch: "fixture/revoked" }, new AbortController().signal); void pending.catch(() => {});
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) { if (Date.now() >= deadline) throw Error("Creation command did not reach its rendezvous."); await Bun.sleep(10); }
    runtime.replaceSnapshot(buildSnapshot([], controls)); writeFileSync(gate, "continue");
    await expect(pending).rejects.toThrow("revoked while running");
  } finally { writeFileSync(gate, "continue"); await pending.catch(() => {}); await runtime.close(); }
}, 15000);

test("SPEC-OUT-026/CA-03 — the actual creation hook makes a non-Git copy and the session uses it instead of the default method", async () => {
  const f = fixture(), receipt = join(f.ws.root, "factory.jsonl"), notice = record(f.ws, "ordinary-copy-notification");
  const command = bunCommand(f.ws.write("scripts/factory.ts", `
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
const payload = JSON.parse(await Bun.stdin.text());
appendFileSync(${JSON.stringify(receipt)}, JSON.stringify(payload) + "\\n");
mkdirSync(payload.path, { recursive: true });
writeFileSync(join(payload.path, "custom.txt"), "CUSTOM_COPY_METHOD_WITNESS");
console.log(JSON.stringify({ isolatedCopy: { path: payload.path, branch: payload.branch } }));
`));
  const shell = process.platform === "win32" ? "run_powershell" : "run_shell";
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "open_isolated_copy", input: { name: "custom" } }] },
    { toolCalls: [{ name: "read_file", input: { path: join(f.path, "custom.txt") } }, { name: shell, input: { command: "git rev-parse --show-toplevel" } }] },
    request => { expect(JSON.stringify(request.history)).toContain("not a git repository"); return { toolCalls: [{ name: "close_isolated_copy", input: { action: "keep" } }] }; },
    request => { expect(JSON.stringify(request.history)).toContain("CUSTOM_COPY_METHOD_WITNESS"); return { text: "Custom copy verified and retained." }; },
  ]);
  const result = await cli(["--non-interactive", "--allow-rule=open_isolated_copy", "--allow-rule=" + shell, "Work in a custom isolated copy, then retain it."], f.ws, { provider, env: productEnv(f.ws), userConfig: { hooks: { isolated_copy_created: [{ id: "custom-factory", copyFactory: true, actions: [{ type: "command", command }] }, { id: "ordinary-notification", actions: [{ type: "command", command: notice.command }] }] } } });
  if (result.code !== 0) throw new Error(result.stderr + "\n" + result.stdout);
  expect(result.code).toBe(0);
  expect(existsSync(join(f.path, ".git"))).toBe(false);
  expect(readFileSync(join(f.path, "custom.txt"), "utf8")).toBe("CUSTOM_COPY_METHOD_WITNESS");
  expect(readFileSync(join(f.ws.project, "original.txt"), "utf8")).toBe("ORIGINAL_FACTORY_WITNESS");
  expect(f.git(["worktree", "list", "--porcelain"]).stdout).not.toContain(f.path.replace(/\\/g, "/"));
  expect(f.git(["status", "--porcelain", "--untracked-files=all"]).stdout.trim()).toBe("");
  const calls = readFileSync(receipt, "utf8").trim().split("\n").map(line => JSON.parse(line));
  expect(calls).toHaveLength(1); expect(calls[0].operation).toBe("create");
  expect(notice.read()).toHaveLength(1);
}, 20_000);
