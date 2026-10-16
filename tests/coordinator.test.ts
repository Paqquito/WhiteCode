// Supports: SPEC-MOD-028/CA-01, CA-02 (parallel autonomous workers, direct-write boundary and persisted role), gap E-232.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, renameSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider, type ScriptStep } from "./helpers/scripted-provider";
import type { ModelProvider } from "../src/providers/types";
import { projectSessions } from "../src/session/sessions";
import { readTranscript, effectiveMeta } from "../src/session/transcript";
import { coordinatorDirectory } from "../src/engine/coordinator";

test("SPEC-MOD-028/CA-01 — three independent workers reach a barrier together, receive autonomous instructions and retain their write permissions", async () => {
  const ws = workspace(), stop = new AbortController(), agents = new Set<string>();
  let providerFailure = "";
  let shared = "";
  let release!: () => void, allStarted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { allStarted = resolve; });
  const worker: ScriptStep = request => {
    expect(JSON.stringify(request.history)).not.toContain("PARENT_ONLY_CONTEXT");
    expect(request.tools.some(tool => tool.name === "write_file")).toBe(true);
    return request.history.some(message => message.role === "user" && message.parts.some(part => part.type === "tool_result"))
      ? { text: "WORKER_COMPLETE_" + request.agent }
      : { toolCalls: [join(ws.project, request.agent + ".txt"), join(shared, request.agent + ".txt")].map(path => ({ name: "write_file", input: { path, content: "Worker evidence\n" } })) };
  };
  const scripted = new ScriptedProvider([
    request => {
      const mechanism = request.system.find(block => block.text.includes("You coordinate independent workers."))!.text;
      shared = JSON.parse(mechanism.split("Shared intermediate directory: ").at(-1)!);
      expect(existsSync(shared)).toBe(true);
      for (const tool of ["write_file", "edit_file", "run_shell", "run_code", "use_skill", "run_workflow"]) expect(request.tools.some(value => value.name === tool)).toBe(false);
      return { toolCalls: ["alpha", "beta", "gamma"].map(part => ({ name: "spawn_agent", input: { description: part, prompt: "Complete independent part " + part + ". Write its evidence and report it." } })) };
    },
    { text: "Workers running" },
    request => {
      const ids = [...new Set(Array.from(JSON.stringify(request.history).matchAll(/background as task ([a-zA-Z0-9_-]+)/g), match => match[1]!))];
      expect(ids).toHaveLength(3);
      return { toolCalls: ids.map(task_id => ({ name: "background_output", input: { task_id, block: true, timeout: 3000 } })) };
    },
    request => {
      const calls = new Set(request.history.flatMap(message => message.role === "assistant" ? message.toolCalls.filter(call => call.name === "background_output").map(call => call.callId) : []));
      const results = request.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result" && calls.has(part.callId)) : []);
      expect(results).toHaveLength(3);
      const reports = new Set(Array.from(JSON.stringify(results).matchAll(/WORKER_COMPLETE_(agent-[a-f0-9]{8})/g), match => match[1]!));
      expect([...reports].sort()).toEqual([...agents].sort());
      return { toolCalls: [...agents].map(id => ({ name: "read_file", input: { path: join(shared, id + ".txt") } })) };
    },
    request => {
      const outputs = request.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result") : []);
      expect(JSON.stringify(outputs).match(/Worker evidence/g)).toHaveLength(3); return { text: "All parts complete" };
    },
  ], Array.from({ length: 6 }, () => worker));
  const provider: ModelProvider = { id: "coordinator-fixture", async *stream(request, signal) {
    if (request.purpose === "subagent" && !agents.has(request.agent!)) {
      agents.add(request.agent!); if (agents.size === 3) allStarted();
      await Promise.race([gate, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(Error("Stopped")), { once: true }))]);
    }
    try { yield* scripted.stream(request, signal); }
    catch (error) { providerFailure = (error as Error).stack ?? String(error); throw error; }
  } };
  const host = new Host(ws, { provider, argv: ["--orchestrator"], extra: { signal: stop.signal }, userConfig: { agents: { maxParallel: 3 }, permissions: { allowRules: ["write_file"] } } });
  try {
    host.user("PARENT_ONLY_CONTEXT: handle three independent parts.");
    await Promise.race([started, host.run.then(result => { throw Error(result.stderr); })]);
    expect(agents.size).toBe(3);
    expect([...agents].every(id => !existsSync(join(ws.project, id + ".txt")))).toBe(true);
    await host.waitFor(message => message.type === "assistant" && message["content"] === "Workers running" && message["partial"] === false);
    release(); host.user("Collect all worker evidence.");
    await host.waitFor(message => message.type === "assistant" && message["content"] === "All parts complete" && message["partial"] === false).catch(error => { throw Error(String(error) + "\nProvider: " + providerFailure); });
    for (const id of agents) expect(readFileSync(join(ws.project, id + ".txt"), "utf8")).toBe("Worker evidence\n");
    await host.waitFor(message => message.type === "turn_completed" && message["turn"] === 2);
    host.feed.end(); expect((await host.finish()).code).toBe(0);
    expect(existsSync(shared)).toBe(false);
  } finally { release(); stop.abort(); host.feed.end(); await host.finish(); }
}, 15000);

test("SPEC-MOD-028/CA-02 — reopening a coordinator session under normal settings restores its role with a warning", async () => {
  const ws = workspace();
  expect((await cli(["--non-interactive", "--orchestrator", "Keep this role"], ws, { provider: new ScriptedProvider([{ text: "Coordinator session" }]) })).code).toBe(0);
  const sessions = projectSessions(join(ws.configHome, "sessions"), realpathSync(ws.project));
  expect(sessions).toHaveLength(1);
  expect(effectiveMeta(readTranscript(sessions[0]!.path).records)["coordinator"]).toBe(true);
  const provider = new ScriptedProvider([request => {
    expect(request.tools.some(tool => tool.name === "write_file")).toBe(false);
    expect(JSON.stringify(request.system)).toContain("coordinate independent workers"); return { text: "Role restored" };
  }]);
  const resumed = await cli(["--non-interactive", "--reopen=" + sessions[0]!.id, "Continue"], ws, { provider });
  expect({ code: resumed.code, stderr: resumed.stderr }).toMatchObject({ code: 0 }); expect(resumed.stderr).toContain("coordinateur enregistré est rétabli");
});

test("TECH — an undeclared direct write cannot bypass the coordinator tool view", async () => {
  const ws = workspace(), file = join(ws.project, "forbidden.txt"), provider = new ScriptedProvider([
    { toolCalls: [{ name: "write_file", input: { path: file, content: "Must not be written" } }] },
    request => { expect(JSON.stringify(request.history.at(-1))).toContain("write_file"); return { text: "Direct write unavailable" }; },
  ]);
  expect((await cli(["--non-interactive", "--orchestrator", "--allow-rule", "write_file", "Try a direct write"], ws, { provider })).code).toBe(0);
  expect(existsSync(file)).toBe(false);
});

test("TECH — coordinator cleanup never follows a replacement link outside its owned temporary directory", () => {
  const ws = workspace(), temporary = coordinatorDirectory(ws.root), target = join(ws.root, "project");
  const marker = ws.write("project/retained.txt", "Keep outside data");
  const saved = temporary.path + "-saved";
  // Both exact move targets are fresh paths inside this test's named workspace; no external tree is moved.
  expect(temporary.path.startsWith(realpathSync(ws.root) + (process.platform === "win32" ? "\\" : "/"))).toBe(true);
  expect(saved.startsWith(realpathSync(ws.root) + (process.platform === "win32" ? "\\" : "/"))).toBe(true);
  renameSync(temporary.path, saved); symlinkSync(target, temporary.path, process.platform === "win32" ? "junction" : "dir");
  expect(temporary.close()).toBe(false); expect(readFileSync(marker, "utf8")).toBe("Keep outside data");
});
