import { expect, test } from "bun:test";
import { Host } from "./helpers/control";
import { workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { parseSdkServers, sdkTools } from "../src/connectors/sdk";
import { parseControlMessage } from "../src/control/protocol";
import { ControlChannel } from "../src/control/channel";
import { bench } from "./helpers/engine";
const sdkServers = [{ name: "app", tools: [{ name: "lookup", description: "Look up a local application record.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false }, annotations: { readOnlyHint: true } }] }];
test("SPEC-MCP-005/CA-01 — a host-declared lookup is relayed as MCP tools/call and returned to the model", async () => {
  const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_app_lookup", input: { id: "42" } }] }, { text: "vu" }]); let received: unknown;
  const host = new Host(workspace(), { provider: p, argv: ["--allow-rule", "cnx_app_lookup"], init: { sdkServers, decisionAuthority: true, demands: ["sdk_mcp_request", "confirm_escalation"] }, userConfig: { engine: { control: { allowEscalation: true } } }, answers: { confirm_escalation: params => ({ decision: "confirm", escalationId: params["escalationId"] }), sdk_mcp_request: params => { received = params; return { content: [{ type: "text", text: "local record 42" }] }; } } });
  const state = await host.request("get_state"); expect(JSON.stringify(state)).toContain("cnx_app_lookup");
  const listed = await host.request("invoke_command", { command: "/connectors" }); expect(JSON.stringify(listed)).toContain("application");
  expect(host.demands("confirm_escalation")).toHaveLength(1);
  host.user("cherche"); await host.waitFor(message => message.type === "turn_completed"); host.feed.end(); const result = await host.finish();
  expect(result.code).toBe(0); expect(received).toMatchObject({ server: "app", method: "tools/call", params: { name: "lookup", arguments: { id: "42" } } }); expect(JSON.stringify(p.requests[1]?.history)).toContain("local record 42");
});
test("SPEC-MCP-005/CA-02 — a deny on a kit tool stops it before any request reaches the application", async () => {
  const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_app_lookup", input: { id: "42" } }] }, { text: "refus" }]); let calls = 0;
  const host = new Host(workspace(), { provider: p, argv: ["--deny-rule", "cnx_app_lookup"], init: { sdkServers, demands: ["sdk_mcp_request"] }, answers: { sdk_mcp_request: () => { calls++; return { content: [] }; } } });
  host.user("cherche"); await host.waitFor(message => message.type === "turn_completed"); host.feed.end(); await host.finish(); expect(calls).toBe(0); expect(JSON.stringify(p.requests[1]?.history)).toContain('"isError":true'); expect(p.requests[0]?.tools.some(tool => tool.name === "cnx_app_lookup")).toBe(false);
});
const options = { timeoutMs: 25, descriptionMax: 1000, outputLimit: 1000, estimateTokens: (text: string) => text.length / 4, store: () => "unused", redact: (text: string) => text };
function channel(answer?: unknown) {
  const channel = new ControlChannel({ send: message => { if (answer !== undefined && message["type"] === "control_request") queueMicrotask(() => channel.receive({ type: "control_response", id: message["id"], ok: true, result: answer })); }, handlers: {}, defaultTimeoutMs: 1000, maxInFlight: 4, warn: () => {}, trace: () => {}, fatal: message => { throw new Error(message); } });
  channel.receive({ type: "control_init", protocolVersion: "1.0", demands: ["sdk_mcp_request"] }); return channel;
}
test("TECH — SDK negotiation rejects a missing relay and accepts an optional description", () => {
  const servers = [{ name: "app", tools: [{ name: "lookup", inputSchema: { type: "object" } }] }]; expect(parseSdkServers(servers)[0]?.tools[0]?.description).toBeUndefined(); expect(parseControlMessage({ type: "control_init", protocolVersion: "1.0", demands: [], sdkServers: servers })).toHaveProperty("error");
});
test("TECH — SDK names reserve existing tools and never silently discard a colliding fallback", () => {
  const relay = channel(); const renamed = sdkTools(sdkServers, relay, { ...options, taken: new Set(["cnx_app_lookup"]) }); expect(renamed[0]?.name).not.toBe("cnx_app_lookup");
  const tool = (name: string) => ({ name, inputSchema: { type: "object" } }); expect(() => sdkTools([{ name: "a", tools: [tool("b_c_2e7d2c03"), tool("b_c")] }, { name: "a_b", tools: [tool("c")] }], relay, options)).toThrow("collision"); relay.close();
});
test("TECH — SDK timeouts retain their error kind and malformed content never succeeds", async () => {
  for (const [answer, kind] of [[undefined, "timeout"], [{ content: [{ type: "text" }] }, "unavailable"]] as const) {
    const relay = channel(answer), tool = sdkTools(sdkServers, relay, options)[0]!, b = bench([]); const result = await tool.execute({} as never, b.deps.executor.toolContext(new AbortController().signal)); expect(result.isError).toBe(true); expect(result.errorKind).toBe(kind); relay.close();
  }
});
