import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { connectorPermissionDelegate, type DelegatedRequest } from "../src/permissions/delegate";
import { bench } from "./helpers/engine";
import { runTurn } from "../src/engine/loop";
import { writeFileTool } from "../src/tools/write-file";
function server(answer: (input: DelegatedRequest) => unknown) {
  const calls: DelegatedRequest[] = [];
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: request.method === "GET" ? 405 : 202 });
    const message = await request.json() as { id?: number; method: string; params?: { arguments?: DelegatedRequest } };
    if (message.id === undefined) return new Response(null, { status: 202 });
    let result: unknown;
    if (message.method === "initialize") result = { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "policy-fixture", version: "1" } };
    else if (message.method === "tools/list") result = { tools: [{ name: "decide", description: "Evaluate the exact bound request.", inputSchema: { type: "object", properties: { request: { type: "object" }, binding: { type: "object" } }, required: ["request", "binding"], additionalProperties: false }, annotations: { readOnlyHint: true, destructiveHint: false } }] };
    else if (message.method === "tools/call") { const input = message.params!.arguments!; calls.push(input); result = { content: [{ type: "text", text: JSON.stringify(answer(input)) }] }; }
    else result = {};
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  } });
  return { s, calls, url: `http://127.0.0.1:${s.port}/mcp` };
}
async function run(answer: (request: DelegatedRequest) => unknown, extra: string[] = [], options: { readonly preauthorize?: boolean; readonly managedAsk?: boolean } = {}) {
  const remote = server(answer), ws = workspace(), target = join(ws.project, "written.txt");
  ws.write("home/config/connectors.json", JSON.stringify({ servers: { policy: { transport: "http", url: remote.url } } }));
  if (options.managedAsk) { ws.write("managed/policy.json", JSON.stringify({ permissions: { askRules: ["write_file"] } })); ws.write("home/config/state.json", JSON.stringify({ unrestrictedAccepted: true })); }
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "BOUND_DELEGATE_WRITE_51" } }] }, { text: "Finished" }]);
  try {
    const result = await cli(["--non-interactive", "--wait-for-mcp", "--permission-delegate=cnx_policy_decide", ...(options.preauthorize === false ? [] : ["--allow-rule=cnx_policy_decide"]), ...extra, "Write"], ws, { provider });
    return { result, provider, target, calls: remote.calls, ws };
  } finally { remote.s.stop(true); }
}
test("SPEC-PER-028/CA-01 — an explicitly designated connector decision authorises the exact requested write", async () => {
  const r = await run(({ binding }) => ({ binding, decision: "allow" }));
  expect(r.result.code).toBe(0); expect(readFileSync(r.target, "utf8")).toBe("BOUND_DELEGATE_WRITE_51"); expect(r.calls).toHaveLength(1); expect(r.calls[0]!.binding.callId).toBeDefined(); expect(r.calls[0]!.binding.sessionId).toBeDefined();
});
test("SPEC-PER-028/CA-02 — an invalid, unrelated or replayed connector response refuses the write", async () => {
  for (const response of [(request: DelegatedRequest) => ({ decision: "allow" }), (request: DelegatedRequest) => ({ binding: { ...request.binding, nonce: "old" }, decision: "allow" }), (request: DelegatedRequest) => ({ binding: request.binding, decision: "allow", input: [] })]) {
    const r = await run(response); expect(r.result.code).toBe(0); expect(existsSync(r.target)).toBe(false); expect(r.calls).toHaveLength(1); expect(JSON.stringify(r.provider.requests.at(-1)?.history)).toContain("invalid");
  }
});
test("SPEC-PER-028/CA-04 — a delegate replacement path goes through the new resource deny rule", async () => {
  const r = await run(({ request, binding }) => ({ binding, decision: "allow", input: { ...request.input, path: join(String(request.input!.path), "..", "blocked.txt") } }), ["--deny-rule=write_file(/blocked.txt)"]);
  expect(r.result.code).toBe(0); expect(existsSync(r.target)).toBe(false); expect(existsSync(join(r.ws.project, "blocked.txt"))).toBe(false); expect(JSON.stringify(r.provider.requests.at(-1)?.history)).toContain("Denied by the rule"); expect(r.calls).toHaveLength(1);
});
test("TECH — a changed delegate resource needs a fresh bound decision when it still asks", async () => {
  const r = await run(({ request, binding }) => String(request.input!.path).endsWith("second.txt") ? { binding, decision: "deny", reason: "SECOND_RESOURCE_REFUSED" } : { binding, decision: "allow", input: { ...request.input, path: join(String(request.input!.path), "..", "second.txt") } });
  expect(r.calls).toHaveLength(2); expect(existsSync(r.target)).toBe(false); expect(existsSync(join(r.ws.project, "second.txt"))).toBe(false); expect(JSON.stringify(r.provider.requests.at(-1)?.history)).toContain("SECOND_RESOURCE_REFUSED"); expect(r.calls[0]!.binding.nonce).not.toBe(r.calls[1]!.binding.nonce);
});
test("TECH — a small display threshold cannot truncate a permission control response", async () => {
  const r = await run(({ binding }) => ({ binding, decision: "allow" }), ['--config-source={"mcp":{"outputInlineLimit":1}}']);
  expect(r.result.code).toBe(0); expect(readFileSync(r.target, "utf8")).toBe("BOUND_DELEGATE_WRITE_51"); expect(r.calls).toHaveLength(1);
});
test("TECH — unrestricted mode alone cannot authorise a delegated control component", async () => {
  const r = await run(({ binding }) => ({ binding, decision: "allow" }), ["--approval-mode=unrestricted", "--allow-unrestricted-mode"], { preauthorize: false, managedAsk: true });
  expect(r.result.code).toBe(0); expect(r.calls).toHaveLength(0); expect(existsSync(r.target)).toBe(false); expect(JSON.stringify(r.provider.requests.at(-1)?.history)).toContain("delegate failed");
});
test("TECH — a synchronous decision cannot outrun delivery of its deadline timer", async () => {
  const delegate = connectorPermissionDelegate({ sessionId: "fixture", timeoutMs: () => 5, context: () => ({}), invoke: async ({ binding }) => { const until = Date.now() + 30; while (Date.now() < until) { /* Block timer delivery deliberately. */ } return { binding, decision: "allow" }; } });
  expect(await delegate.decide({ callId: "one", toolName: "write_file", summary: "Write", reason: "Ask", origin: "default", suggestions: [] }, new AbortController().signal)).toMatchObject({ decision: "deny", reason: expect.stringContaining("deadline") });
});
test("SPEC-PER-028/CA-05 — a bound delegate answer arriving after cancellation has no file effect", async () => {
  let late!: (response: unknown) => void, incoming!: DelegatedRequest;
  const controller = new AbortController(), delegate = connectorPermissionDelegate({ sessionId: "fixture-session", timeoutMs: () => 1000, context: () => ({}), invoke: async request => { incoming = request; return new Promise(resolve => { late = resolve; }); } });
  const input = { path: "", content: "LATE_DELEGATE_MUST_NOT_WRITE" }, b = bench([{ toolCalls: [{ name: "write_file", input }] }], { mode: "no_prompt", tools: [writeFileTool as never], authorities: { delegate } }); input.path = join(b.ws.project, "late.txt");
  const work = runTurn(b.deps, "Write", controller.signal); for (let n = 0; n < 100 && !late; n++) await Bun.sleep(5); expect(late).toBeDefined(); controller.abort(); expect((await work).stopCause).toBe("interrupted"); late({ binding: incoming.binding, decision: "allow" }); await Bun.sleep(20); expect(existsSync(input.path)).toBe(false);
});
test("TECH — permission delegates fail closed on a security revision or deadline", async () => {
  let revision = 1;
  const input = { callId: "one", toolName: "write_file", input: { path: "/file" }, summary: "Write", origin: "default" as const, reason: "Ask", suggestions: [] };
  const changed = connectorPermissionDelegate({ sessionId: "fixture", timeoutMs: () => 100, context: () => revision, invoke: async ({ binding }) => { revision++; return { binding, decision: "allow" }; } });
  expect(await changed.decide(input, new AbortController().signal)).toMatchObject({ decision: "deny" });
  const timed = connectorPermissionDelegate({ sessionId: "fixture", timeoutMs: () => 15, context: () => revision, invoke: async () => new Promise(() => {}) });
  expect(await timed.decide(input, new AbortController().signal)).toMatchObject({ decision: "deny", reason: expect.stringContaining("deadline") });
});
