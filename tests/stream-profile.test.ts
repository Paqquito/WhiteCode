import { expect, test } from "bun:test";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Host } from "./helpers/control";
import { parseCommandLine } from "../src/cli/parser";
import { EventStream } from "../src/headless/stream-output";

const events = (text: string): Record<string, any>[] => text.trim().split("\n").map(line => JSON.parse(line));
const steps = (paths: string[]) => [{ toolCalls: paths.map(path => ({ name: "read_file", input: { path } })) }, { text: "Les deux fichiers sont lus.\nRésultat intact." }];

test("TECH — compact suppresses real thinking events even when explicitly enabled, and resets tool counters after text", () => {
  let output = ""; const stream = new EventStream({ profile: "compact", write: text => { output += text; }, includeThinking: true, maxEventSize: 10000, now: () => new Date() });
  stream.engine({ type: "thinking_delta", text: "private reasoning" });
  const call = { name: "read_file", callId: "first", input: {} };
  stream.engine({ type: "assistant_message", text: "", toolCalls: [call, { ...call, callId: "second" }] });
  stream.engine({ type: "assistant_message", text: "reset", toolCalls: [] });
  stream.engine({ type: "assistant_message", text: "", toolCalls: [call] });
  expect(events(output).filter(event => event.type === "tool_summary").map(event => event.label)).toEqual(["2 fichiers lus", "1 fichier lu"]);
  expect(output).not.toContain("private reasoning");
});

test("SPEC-OBS-022/CA-01 — two reads produce a compact summary followed by the unchanged text", async () => {
  const ws = workspace(); const files = [ws.write("project/a", "FIRST_WITNESS"), ws.write("project/b", "SECOND_WITNESS")];
  const r = await cli(["--non-interactive", "--result-format", "jsonl", "--stream-profile", "compact", "read"], ws, { provider: new ScriptedProvider(steps(files)), userConfig: { engine: { output: { includeThinking: true } } } });
  expect(r.code).toBe(0); const out = events(r.stdout);
  expect(out[0]).toMatchObject({ streamProfile: "compact" });
  const summary = out.findIndex(event => event.type === "tool_summary" && event.label === "2 fichiers lus");
  expect(summary).toBeGreaterThan(0);
  expect(out.findIndex(event => event.type === "assistant" && event.partial === false && event.content === steps(files)[1]!.text)).toBeGreaterThan(summary);
  expect(out.some(event => ["thinking", "tool_call", "tool_result"].includes(event.type))).toBe(false);
  expect(r.stdout).not.toContain("FIRST_WITNESS"); expect(r.stdout).not.toContain("private reasoning");
});

test("SPEC-OBS-022/CA-02 — compact presentation preserves the entire final result, costs and stop counters", async () => {
  const finals: Record<string, any>[] = [];
  for (const profile of ["standard", "compact"]) {
    const ws = workspace(); const file = ws.write("project/a", "witness");
    const r = await cli(["--non-interactive", "--result-format", "jsonl", "--stream-profile", profile, "read"], ws, { provider: new ScriptedProvider(steps([file])) });
    expect(r.code).toBe(0); const { timestamp, sessionId, elapsedMs, ...final } = events(r.stdout).at(-1)!; finals.push(final);
  }
  expect(finals[1]).toEqual(finals[0]);
  expect(finals[1]).toMatchObject({ type: "run_completed", iterations: 2, turns: 1, haltReason: "completed", result: "Les deux fichiers sont lus.\nRésultat intact." });
  expect(finals[1]!.usage).toBeDefined(); expect(finals[1]!.cost).toBeDefined();
});

test("SPEC-OBS-022/CA-03 — standard output reconstructs both tool exchanges and text without exposing disabled reasoning", async () => {
  const ws = workspace(); const files = [ws.write("project/a", "FIRST_WITNESS"), ws.write("project/b", "SECOND_WITNESS")];
  const r = await cli(["--non-interactive", "--result-format", "jsonl", "--stream-profile", "standard", "read"], ws, { provider: new ScriptedProvider(steps(files)) });
  const out = events(r.stdout); expect(out[0]).toMatchObject({ streamProfile: "standard" });
  expect(out.filter(event => event.type === "tool_call").map(event => event.input.path)).toEqual(files);
  const results = out.filter(event => event.type === "tool_result"); expect(results).toHaveLength(2);
  expect(results[0]!.output).toContain("FIRST_WITNESS"); expect(results[1]!.output).toContain("SECOND_WITNESS");
  expect(out.find(event => event.type === "user" && event.content[0]?.type === "tool_result")?.content).toHaveLength(2);
  expect(out.filter(event => event.type === "assistant" && event.partial === false).at(-1)!.content).toBe("Les deux fichiers sont lus.\nRésultat intact.");
  expect(out.some(event => event.type === "thinking")).toBe(false);
});

test("SPEC-OBS-022/CA-04 — compact settings never remove command details from a control permission request", async () => {
  const ws = workspace(); const path = ws.write("project/a", "existing"); let approval: Record<string, unknown> | undefined;
  const host = new Host(ws, { argv: ["--stream-profile", "compact"], init: { decisionAuthority: true }, provider: new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { toolCalls: [{ name: "write_file", input: { path, content: "changed" } }] }, { text: "finished" }]), answers: { approval_request: params => { approval = params; return { decision: "deny" }; } } });
  try { await host.waitFor(message => message.type === "session"); host.user("change"); await host.waitFor(message => message.type === "turn_completed"); }
  finally { host.feed.end(); }
  expect((await host.run).code).toBe(0);
  expect(approval).toMatchObject({ toolName: "write_file", input: { path, content: "changed" }, origin: "default" });
  expect(String(approval?.preview)).toContain("-existing\n+changed"); expect(approval?.reason).toBeDefined();
});

test("SPEC-MOD-011/CA-06 — a deprecated spelling still runs and names its replacement in the warning", async () => {
  const provider = new ScriptedProvider([{ text: "legacy launch completed" }]);
  const r = await cli(["--automated", "--result-format", "json", "go"], workspace(), { provider });
  expect(r.code).toBe(0); expect(JSON.parse(r.stdout).result).toBe("legacy launch completed");
  expect(r.stderr).toContain("--automated est dépréciée ; utilisez --non-interactive");
  expect(parseCommandLine(["--automated", "--automated"]).warnings).toHaveLength(1);
});

test("TECH — a managed stream profile wins over the environment and command line; compact is inert for plain output", async () => {
  const ws = workspace(); ws.write("managed/policy.json", JSON.stringify({ ui: { streamProfile: "standard" } }));
  const r = await cli(["--non-interactive", "--result-format", "jsonl", "--stream-profile", "compact", "go"], ws, { provider: new ScriptedProvider([{ text: "complete" }]), env: { [`${loadIdentity().get("ENV_PREFIX")}STREAM_PROFILE`]: "compact" } });
  expect(r.code).toBe(0); expect(events(r.stdout)[0]).toMatchObject({ streamProfile: "standard" });
  const plain = await cli(["--non-interactive", "--stream-profile", "compact", "go"], workspace(), { provider: new ScriptedProvider([{ text: "complete" }]) });
  expect(plain.code).toBe(0); expect(plain.stdout.trim()).toBe("complete");
});
