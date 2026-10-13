// Supports: SPEC-HOK-005, SPEC-HOK-006; scripted model decisions, real file reads and hook execution.
import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { buildSnapshot } from "../src/hooks/config";
import { readFileSync } from "node:fs";
import { interactive } from "./helpers/interactive";
import { answer, hook, record } from "./helpers/hooks";
import { HookFileWatch } from "../src/hooks/file-watch";
import { PostSampling } from "../src/hooks/post-sampling";
import { writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { watch } from "node:fs";
import { join } from "node:path";
const hooks = (event: string, action: Record<string, unknown>) => ({ [event]: [{ id: "guard", actions: [action] }] });

test("SPEC-HOK-005/CA-01 — SPEC-HOK-014/CA-02 — a prompt guard blocks a proposed removal with its reason and its name and no verifier tool access", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "retain me");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: process.platform === "win32" ? "run_powershell" : "run_shell", input: { command: process.platform === "win32" ? "Remove-Item -LiteralPath a.txt" : "rm a.txt" } }] }, { text: JSON.stringify({ decision: "deny", reason: "Deletion is forbidden." }) }, { text: "done" }]);
  const r = await cli(["--non-interactive", "x"], ws, { provider, env: productEnv(ws), userConfig: { hooks: hooks("before_tool", { type: "prompt", prompt: "Deny every file deletion. $PAYLOAD" }) } });
  expect(r.code).toBe(0); expect(r.stderr).toContain("Deletion is forbidden.");
  expect(r.stderr).toContain("user/before_tool/guard"); expect(readFileSync(file, "utf8")).toBe("retain me");
  expect(provider.requests[1]!.tools).toEqual([]);
  expect(JSON.stringify(provider.requests[2]!.history)).toContain("Deletion is forbidden.");
});

test("SPEC-HOK-005/CA-02 — an unavailable hook model is reported and the original tool continues", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "readable");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { error: { kind: "authentication" } }, { text: "done" }]);
  const r = await cli(["--non-interactive", "x"], ws, { provider, env: productEnv(ws), userConfig: { hooks: hooks("before_tool", { type: "prompt", prompt: "Check the proposed action." }) } });
  expect(r.code).toBe(0); expect(r.stderr).toContain("réponse du modèle inexploitable");
  expect(JSON.stringify(provider.requests[2]!.history)).toContain("readable");
});

test("SPEC-HOK-006/CA-01 — SPEC-HOK-006/CA-02 — a verifier reads failed tests, continues the main turn, then ends normally after a successful verification", async () => {
  const ws = workspace(), file = ws.write("project/test-results.txt", "tests failed");
  const read = { toolCalls: [{ name: "read_file", input: { path: file } }] };
  const provider = new ScriptedProvider([read, { text: "done" }, read, { text: JSON.stringify({ decision: "continue", reason: "tests failed" }) },
    { toolCalls: [{ name: "write_file", input: { path: file, content: "tests passed" } }] }, { text: "fixed" }, read, { text: JSON.stringify({ decision: "continue", reason: "" }) }]);
  const r = await cli(["--non-interactive", "--approval-mode", "auto_edit", "x"], ws, { provider, env: productEnv(ws), userConfig: { hooks: hooks("turn_completed", { type: "agent", prompt: "Read the test results. Continue only if tests failed.", tools: ["read_file"] }) } });
  expect(r.code).toBe(0); expect(r.stdout).toContain("fixed"); expect(readFileSync(file, "utf8")).toBe("tests passed");
  expect(provider.requests).toHaveLength(8);
  expect(provider.requests[2]!.tools.map(t => t.name)).toEqual(["read_file"]);
  expect(JSON.stringify(provider.requests[4]!.history)).toContain("tests failed");
  expect(JSON.stringify(provider.requests[7]!.history)).toContain("tests passed");
});

test("SPEC-HOK-011/CA-02 — a headless question reruns its command with answer null and only applies the final decision", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "safe");
  const command = hook(ws, "question", 'const p = payload; console.log(JSON.stringify(Object.hasOwn(p, "answer") ? { decision: "deny", reason: p.answer === null ? "No human answer." : "Wrong answer." } : { question: { text: "Deploy?", options: ["yes", "no"] } }));');
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "done" }]);
  const r = await cli(["--non-interactive", "x"], ws, { provider, env: productEnv(ws), userConfig: { hooks: hooks("before_tool", { type: "command", command }) } });
  expect(r.code).toBe(0); expect(r.stderr).toContain("No human answer.");
  expect(JSON.stringify(provider.requests[1]!.history)).not.toContain("safe");
});

test("SPEC-HOK-011/CA-01 — a human no answer is returned to the hook and blocks the tool", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "safe"), controller = new AbortController();
  const command = hook(ws, "question", 'const p = payload; console.log(JSON.stringify(Object.hasOwn(p, "answer") ? { decision: "deny", reason: "Human answered: " + p.answer } : { question: { text: "Deploy to production?", options: ["yes", "no"], allowFreeText: false } }));');
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "finished" }]);
  const ui = interactive([], ws, { provider, signal: controller.signal, env: productEnv(ws), userConfig: { hooks: hooks("before_tool", { type: "command", command }) } });
  try { await ui.idle(); ui.type("go\r"); await ui.waitFor(t => t.includes("Deploy to production?")); await Bun.sleep(380); ui.type("2\r"); await ui.waitFor(t => t.includes("Human answered: no")); }
  finally { controller.abort(); await ui.done; }
  expect(JSON.stringify(provider.requests[1]!.history)).not.toContain("safe");
});

test("SPEC-HOK-014/CA-03 — emit-hook-events includes the hook group in the headless JSON stream", async () => {
  const ws = workspace(), command = answer(ws, "group", { userMessage: "checked" });
  const r = await cli(["--non-interactive", "--result-format", "jsonl", "--emit-hook-events", "x"], ws, { provider: new ScriptedProvider([{ text: "done" }]), env: productEnv(ws), userConfig: { hooks: hooks("prompt_submitted", { type: "command", command }) } });
  expect(r.code).toBe(0); const event = r.stdout.trim().split("\n").map(line => JSON.parse(line)).find(e => e.type === "hook_event");
  expect(event).toMatchObject({ event: "prompt_submitted", outcomes: [{ label: "user/prompt_submitted/guard" }] });
});

test("SPEC-HOK-006/CA-03 — verifier write tools are removed at configuration with an explicit warning", () => {
  const snapshot = buildSnapshot([{ origin: "user", value: hooks("turn_completed", { type: "agent", prompt: "Check tests.", tools: ["write_file", "read_file"] }) }], { noHooks: false, managedOnly: false, maxTimeoutMs: 600000 });
  expect(snapshot.declarations[0]!.actions[0]).toMatchObject({ tools: ["read_file"] });
  expect(snapshot.warnings.join("\n")).toContain("Outil non autorisé pour un crochet agent : write_file");
});

test("SPEC-HOK-008/CA-01 — SPEC-HOK-008/CA-02 — an agent header hook runs for its own tool and never the parent", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "ok"), tracked = record(ws, "scoped");
  ws.write("home/config/agents/scoped.md", `---\nname: scoped\ndescription: Reads a file with its own guard.\ntools: [read_file]\nhooks: ${JSON.stringify(hooks("before_tool", { type: "command", command: tracked.command }))}\n---\nRead the requested file.`);
  const read = { toolCalls: [{ name: "read_file", input: { path: file } }] };
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { description: "read", prompt: "read a.txt", role: "scoped" } }] }, read, { text: "child done" }, read, { text: "parent done" }]);
  const r = await cli(["--non-interactive", "x"], ws, { provider, env: productEnv(ws) });
  expect(r.code).toBe(0); expect(tracked.read()).toHaveLength(1); expect(tracked.read()[0].agent.type).toBe("scoped");
});

test("SPEC-HOK-008/CA-03 — interrupting an inline skill unregisters its hooks before the following turn", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "ok"), tracked = record(ws, "skill-guard"), controller = new AbortController();
  ws.write("home/config/skills/scoped/definition.md", `---\nname: scoped\ndescription: A scoped read.\nhooks: ${JSON.stringify(hooks("before_tool", { type: "command", command: tracked.command }))}\n---\nRead a.txt.`);
  const read = { toolCalls: [{ name: "read_file", input: { path: file } }] };
  const provider = new ScriptedProvider([read, { hang: true }, read, { text: "second done" }]);
  const ui = interactive([], ws, { provider, signal: controller.signal, env: productEnv(ws) });
  try { await ui.idle(); ui.type("/scoped\r"); await ui.waitFor(() => provider.requests.length >= 2); ui.type("\u0003"); await ui.idle(); ui.type("next\r"); await ui.waitFor(t => t.includes("second done")); }
  finally { controller.abort(); await ui.done; }
  expect(tracked.read()).toHaveLength(1);
}, 15000);

test("SPEC-HOK-009/CA-01 — a failing internal processor is logged and the next request still finishes", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "ok"), debug = join(ws.root, "sampling.log");
  const processor = { name: "fails", timeoutMs: 1000, enabled: () => true, run: async () => { throw new Error("isolated sampling failure"); } };
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "done" }]);
  const r = await cli(["--non-interactive", "--debug", "--debug-output", debug, "x"], ws, { provider, extra: { samplingProcessors: [processor] }, env: productEnv(ws) });
  expect(r.code).toBe(0); expect(provider.requests).toHaveLength(2); expect(readFileSync(debug, "utf8")).toContain("isolated sampling failure");
});

test("SPEC-HOK-014/CA-01 — three successful silent hooks produce one summary and their details remain in the transcript", async () => {
  const ws = workspace(), controller = new AbortController();
  const list = [1, 2, 3].map(i => ({ id: String(i), actions: [{ type: "command", command: answer(ws, "silent" + i, {}) }] }));
  const ui = interactive([], ws, { provider: new ScriptedProvider([{ text: "done" }]), signal: controller.signal, env: productEnv(ws), userConfig: { hooks: { prompt_submitted: list } } });
  try { await ui.idle(); ui.type("go\r"); await ui.waitFor(t => t.includes("done")); expect(ui.all().join("\n").match(/3 crochets exécutés/g)).toHaveLength(1); }
  finally { controller.abort(); await ui.done; }
  const directory = join(ws.configHome, "sessions");
  const persisted = readdirSync(directory, { recursive: true }).filter((name): name is string => typeof name === "string" && name.endsWith(".jsonl")).flatMap(name => readFileSync(join(directory, name), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  expect(persisted.some(r => r.data.event === "hook_group" && r.data.detail.outcomes.length === 3 && r.data.detail.outcomes.every((o: { stdout?: string }) => o.stdout?.includes("{}")))).toBe(true);
});

test("SPEC-HOK-013/CA-01 — an external proto edit runs its hook once while the interactive agent is idle", async () => {
  const ws = workspace(), file = ws.write("project/a.proto", "old"), tracked = record(ws, "external"), controller = new AbortController();
  const ui = interactive([], ws, { provider: new ScriptedProvider([]), signal: controller.signal, env: productEnv(ws), userConfig: { hooks: { watched_file_modified: [{ match: "*.proto", actions: [{ type: "command", command: tracked.command }] }] }, hooksConfig: { fileWatch: { debounce: 80 } } } });
  try {
    await ui.idle(); writeFileSync(file, "new"); await ui.waitFor(() => tracked.read().length === 1); await Bun.sleep(400);
    expect(tracked.read()).toHaveLength(1); expect(tracked.read()[0]).toMatchObject({ path: file, change: "modified", origin: "external" });
  } finally { controller.abort(); await ui.done; }
}, 15000);

test("SPEC-HOK-013/CA-02 — a formatting hook's own write is absorbed and does not trigger itself again", async () => {
  const ws = workspace(), file = ws.write("project/a.proto", "old"), events: Record<string, unknown>[] = [];
  const watcher = new HookFileWatch({ roots: [ws.project], matches: path => path.endsWith(".proto"), debounce: () => 30, burstLimit: () => 200, warn: () => {}, emit: async fields => { events.push(fields); writeFileSync(String(fields["path"]), "formatted"); } });
  try { writeFileSync(file, "external"); const end = Date.now() + 5000; while (!events.length && Date.now() < end) await Bun.sleep(10); await Bun.sleep(300); expect(events).toHaveLength(1); expect(readFileSync(file, "utf8")).toBe("formatted"); }
  finally { watcher.close(); }
});

test("TECH — the startup rescan catches a change missed while a native watcher is arming", async () => {
  const ws = workspace(), file = ws.write("project/a.proto", "old"), events: Record<string, unknown>[] = [];
  const watcher = new HookFileWatch({ roots: [ws.project], watch: root => watch(root, { recursive: true, persistent: false }, () => {}), matches: path => path.endsWith(".proto"), debounce: () => 10, burstLimit: () => 200, warn: () => {}, emit: async fields => { events.push(fields); writeFileSync(file, "formatted"); } });
  try { writeFileSync(file, "early change"); const deadline = Date.now() + 2000; while (!events.length && Date.now() < deadline) await Bun.sleep(10); expect(events).toHaveLength(1); expect(readFileSync(file, "utf8")).toBe("formatted"); await Bun.sleep(150); expect(events).toHaveLength(1); }
  finally { watcher.close(); }
});

test("SPEC-HOK-013/CA-03 — a burst of five thousand real file changes emits one summary", async () => {
  const ws = workspace(), folder = join(ws.project, "schemas"), events: Record<string, unknown>[] = []; mkdirSync(folder);
  const watcher = new HookFileWatch({ roots: [ws.project], matches: path => path.endsWith(".proto"), debounce: () => 80, burstLimit: () => 200, warn: () => {}, emit: async fields => { events.push(fields); } });
  try {
    for (let i = 0; i < 5000; i++) writeFileSync(join(folder, `${i}.proto`), "changed");
    const end = Date.now() + 10000; while (!events.length && Date.now() < end) await Bun.sleep(10); await Bun.sleep(300);
    expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ summary: true, count: 5000 }); expect((events[0]!["paths"] as string[]).length).toBe(200);
  } finally { watcher.close(); }
}, 60000);

test("TECH — post-sampling processors cannot mutate the assistant, run in forbidden modes, or make logging failures fatal", async () => {
  const errors: string[] = [], source = { role: "assistant" as const, text: "kept", toolCalls: [], native: { provider: "simulated", content: [] } };
  const pipeline = new PostSampling([{ name: "mutates", timeoutMs: 500, enabled: () => true, run: async context => { Object.assign(context.assistant, { text: "changed" }); } }], (name, error) => errors.push(name + error));
  pipeline.dispatch({ assistant: source, minimal: true, ephemeral: false }); pipeline.dispatch({ assistant: source, minimal: false, ephemeral: true });
  await Bun.sleep(0); expect(errors).toEqual([]);
  pipeline.dispatch({ assistant: source, minimal: false, ephemeral: false }); await Bun.sleep(0);
  expect(source.text).toBe("kept"); expect(errors).toHaveLength(1); pipeline.close();
});

test("TECH — verifier tools cannot modify the project even if a model invents a write call", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "kept");
  const provider = new ScriptedProvider([{ text: "done" }, { toolCalls: [{ name: "write_file", input: { path: file, content: "overwrite" } }] }, { text: JSON.stringify({ decision: "continue", reason: "" }) }]);
  const r = await cli(["--non-interactive", "--approval-mode", "auto_edit", "x"], ws, { provider, env: productEnv(ws), userConfig: { hooks: hooks("turn_completed", { type: "agent", prompt: "Inspect without writing.", tools: ["read_file", "write_file"] }) } });
  expect(r.code).toBe(0); expect(readFileSync(file, "utf8")).toBe("kept"); expect(JSON.stringify(provider.requests[2]!.history)).toContain("Unknown tool");
});

test("SPEC-HOK-009/CA-02 — a five-second processor cannot delay the following model request", async () => {
  const ws = workspace(), file = ws.write("project/a.txt", "ok"), starts: number[] = [], finished: string[] = [];
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, () => { starts.push(Date.now()); return { text: "done" }; }]);
  const r = await cli(["--non-interactive", "x"], ws, { provider, env: productEnv(ws), extra: { samplingProcessors: [{ name: "slow", timeoutMs: 5000, enabled: () => true, run: async (_, signal) => {
    starts.push(Date.now()); await new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); timer.unref(); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); }); finished.push("finished");
  } }] } });
  expect(r.code).toBe(0); expect(starts[1]! - starts[0]!).toBeLessThan(1500); expect(provider.requests).toHaveLength(2);
});
