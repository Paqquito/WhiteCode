// Supports: SPEC-OUT-023/CA-01/02, SPEC-MOD-026 (real request, executor and multiplexed control input).
import { expect, test } from "bun:test";
import { Host } from "../helpers/control";
import { loadIdentity, workspace } from "../helpers/env";
import { ScriptedProvider } from "../helpers/scripted-provider";

test("TECH — controlled assistant waits without a shell or proactive mode and resumes on the next user event", async () => {
  const controller = new AbortController(), sampled = Promise.withResolvers<void>(), startedTool = Promise.withResolvers<void>();
  const startedCalls: string[] = [];
  const provider = new ScriptedProvider([
    () => { sampled.resolve(); return { toolCalls: [{ id: "assistant-wait-64", name: "wait", input: { duration: 600 } }] }; },
    { text: "ASSISTANT_MESSAGE_WAKE_64" },
    { text: "ASSISTANT_NEXT_TURN_64" },
  ]);
  const h = new Host(workspace(), {
    provider, argv: ["--toolset", "wait"],
    env: { [loadIdentity().get("ENV_PREFIX") + "ASSISTANT_WORKER"]: "1" },
    extra: { signal: controller.signal, onEvent: event => { if (event.type === "tool_started") { startedCalls.push(event.callId); if (event.callId === "assistant-wait-64") startedTool.resolve(); } } },
    userConfig: { ui: { promptSuggestions: false }, tasks: { enabled: false }, engine: { toolTimeout: "100ms" } },
  });
  try {
    h.user("Wait for the next message.");
    await Promise.race([sampled.promise, h.waitFor(message => message.type === "error").then(message => { throw Error("Controlled session rejected the assistant request: " + JSON.stringify(message)); }), h.run.then(result => { throw Error("Controlled session ended before sampling: " + JSON.stringify(result)); })]);
    expect(JSON.stringify(provider.requests[0]!.system)).toContain("You are running as a persistent assistant.");
    expect(provider.requests[0]!.tools.map(tool => tool.name)).toEqual(["wait"]);
    await startedTool.promise;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(provider.requests).toHaveLength(1);
    const started = performance.now();
    h.user("Wake on this user message.");
    const result = await h.waitFor(message => message.type === "tool_result" && message["callId"] === "assistant-wait-64");
    expect(performance.now() - started).toBeLessThan(500);
    expect(result["errored"]).toBe(false);
    expect(JSON.parse(String(result["output"]))).toMatchObject({ cause: "message" });
    await h.waitFor(message => message.type === "control_request" && message["request"] === "notify" && (message["params"] as Record<string, unknown>)["kind"] === "turn_completed" && (message["params"] as Record<string, unknown>)["turn"] === 2);
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[2]!.history)).toContain("Wake on this user message.");
    expect(h.demands("approval_request")).toHaveLength(0);
    expect(startedCalls).toEqual(["assistant-wait-64"]);
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  } finally { controller.abort(); h.feed.end(); await h.finish(); }
}, 10000);
