import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { prefix } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Host } from "./helpers/control";
import { interactive, sleep } from "./helpers/interactive";
import { projectSessions, readTranscript, sessionTaskSummary } from "../src/session/sessions";

test("SPEC-MOT-028/CA-01 — the real terminal shows a gray suggestion and Tab stages it without sending", async () => {
  const ws = workspace(), stop = new AbortController(), provider = new ScriptedProvider([{ text: "Initial answer" }, { text: "Run the relevant tests" }, { text: "Explicitly sent" }]);
  const run = interactive([], ws, { provider, signal: stop.signal, userConfig: { ui: { promptSuggestions: true } } });
  try {
    await run.idle(); run.type("Inspect\r"); await run.waitFor(text => text.includes("Run the relevant tests"));
    expect(provider.requests.filter(r => (r.purpose ?? "main") === "main")).toHaveLength(1);
    expect(run.term.vt.chunks.join("")).toMatch(/\u001b\[[0-9;]*2[;m]/);
    run.type("\t"); await sleep(30); expect(provider.requests.filter(r => (r.purpose ?? "main") === "main")).toHaveLength(1);
    run.type("\r"); await run.waitFor(text => text.includes("Explicitly sent"));
    const request = provider.requests.filter(r => (r.purpose ?? "main") === "main")[1]!; expect(JSON.stringify(request.history)).toContain("Run the relevant tests");
  } finally { stop.abort(); await run.done; }
});
test("TECH — the actual job composition writes validated state and preserves it on an invalid later classification", async () => {
  const ws = workspace(), folder = ws.project, provider = new ScriptedProvider([{ text: "Which option?" }, { text: '{"state":"needs_input","summary":"Choose an option."}' }]);
  const result = await cli(["--non-interactive", "Decide"], ws, { provider, env: { [prefix + "JOB_WORKSPACE"]: folder } });
  expect(result.code).toBe(0); expect(JSON.parse(readFileSync(join(folder, "job-state.json"), "utf8"))).toEqual({ state: "needs_input", summary: "Choose an option." });
  expect(provider.requests[1]!.tools).toEqual([]); expect(JSON.stringify(provider.requests[1]!.history)).toContain("Which option?");
  const absent = workspace(); await cli(["--non-interactive", "No job"], absent, { provider: new ScriptedProvider([{ text: "Done" }]) }); expect(existsSync(join(absent.project, "job-state.json"))).toBe(false);
});
test("TECH — the control host opts into tool progress and receives a sentence after three actual reads", async () => {
  const ws = workspace(), files = [1, 2, 3].map(n => ws.write(`project/${n}.txt`, `FILE_${n}`));
  const provider = new ScriptedProvider([{ toolCalls: files.map(path => ({ name: "read_file", input: { path } })) }, request => request.purpose === "side" ? { text: "Examiner les trois fichiers." } : { text: "Finished reads" }, { text: "Finished reads" }]);
  const host = new Host(ws, { provider, init: { toolProgress: true } });
  try { host.user("Read three files"); await host.waitFor(m => m.type === "progress_summary"); expect(host.messages.find(m => m.type === "progress_summary")!["text"]).toBe("Examiner les trois fichiers."); await host.waitFor(m => m.type === "turn_completed"); }
  finally { host.feed.end(); await host.finish(); }
});
test("TECH — control hosts receive optional suggestions and nested executable agents cannot write the parent job state", async () => {
  const host = new Host(workspace(), { provider: new ScriptedProvider([{ text: "Finished" }, { text: "Run the relevant tests" }]), userConfig: { ui: { promptSuggestions: true } } });
  try { host.user("Work"); const suggestion = await host.waitFor(m => m.type === "input_suggestion"); expect(suggestion["text"]).toBe("Run the relevant tests"); } finally { host.feed.end(); await host.finish(); }
  const ws = workspace(), provider = new ScriptedProvider([{ text: "Nested answer" }]);
  expect((await cli(["--non-interactive", "Nested"], ws, { provider, env: { [prefix + "AGENT_DEPTH"]: "1", [prefix + "JOB_WORKSPACE"]: ws.project }, userConfig: { sessions: { taskSummary: { enabled: true, everyTurns: 1 } } } })).code).toBe(0);
  expect(provider.requests).toHaveLength(1); expect(existsSync(join(ws.project, "job-state.json"))).toBe(false);
});
test("TECH — a real session persists its periodic task summary separately from the model history", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "Current answer" }, { text: "Task summary witness" }]);
  const host = new Host(ws, { provider, userConfig: { sessions: { taskSummary: { enabled: true, everyTurns: 1 } } } });
  host.user("Current task"); await host.waitFor(m => m.type === "turn_completed"); await sleep(40); host.feed.end(); expect((await host.finish()).code).toBe(0);
  const { loadIdentity } = await import("./helpers/env"), sessions = projectSessions(join(ws.configHome, "sessions"), ws.project);
  expect(sessions).toHaveLength(1); expect(sessionTaskSummary(readTranscript(sessions[0]!.path).records)).toBe("Task summary witness");
  expect(JSON.stringify(provider.requests[0]!.history)).not.toContain("Task summary witness"); expect(provider.requests[1]!.tools.length).toBeGreaterThan(0);
});
test("TECH — a focus return after thirty minutes displays a real side-query recap", async () => {
  let now = Date.now(); const stop = new AbortController(), provider = new ScriptedProvider([{ text: "Work done" }, { text: "RECAP_RUNTIME_WITNESS\nChecks passed\nNext step" }]);
  const run = interactive([], workspace(), { provider, signal: stop.signal, userConfig: { ui: { returnSummary: { enabled: true } } }, extra: { now: () => new Date(now) } });
  try { await run.idle(); run.type("Work\r"); await run.waitFor(t => t.includes("Work done")); await sleep(40); run.raw("\u001b[O"); now += 1800001; run.raw("\u001b[I"); await run.waitFor(t => t.includes("RECAP_RUNTIME_WITNESS")); expect(provider.requests).toHaveLength(2); }
  finally { stop.abort(); await run.done; }
});
test("TECH — a running background agent publishes a cached, tool-free progress report into the real task list", async () => {
  let now = Date.now(); const provider = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { role: "general", description: "Long review", prompt: "Review", detached: true } }] }, { text: "Background task running" }, { text: "RECENT_AGENT_PROGRESS_51" }], [{ hang: true }]);
  const host = new Host(workspace(), { provider, userConfig: { agents: { progressSummary: { enabled: true } } }, extra: { now: () => new Date(now) } });
  try {
    host.user("Review in background"); await host.waitFor(m => m.type === "turn_completed"); now += 120001;
    for (let n = 0; n < 160 && !provider.requests.some(request => request.purpose === "side"); n++) await sleep(50);
    const request = provider.requests.find(request => request.purpose === "side"); expect(request).toBeDefined(); expect(request!.tools.length).toBeGreaterThan(0); expect(request!.model.id).toBe(provider.requests.find(request => request.purpose === "subagent")!.model.id); await sleep(50);
    const panel = await host.request("invoke_command", { command: "/background-tasks" }); expect(JSON.stringify(panel)).toContain("RECENT_AGENT_PROGRESS_51");
    expect(provider.requests.filter(request => request.purpose === "subagent")).toHaveLength(1);
  } finally { host.feed.end(); await host.finish(); }
}, 15000);
