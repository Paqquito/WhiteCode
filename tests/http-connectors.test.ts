// Acceptance paths use local protocol servers and the actual composition root; no model service or real credential.
import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { HttpConnection } from "../src/connectors/http-client";
import { resolveConnectors } from "../src/connectors/declarations";
import { connectorTool } from "../src/connectors/tools";

import { httpConnectorServer as server } from "./helpers/fake-mcp-http";
const open = (url: string, transport: "http" | "sse" = "http", extra: Partial<Parameters<typeof HttpConnection.open>[0]> = {}) => HttpConnection.open({ name: "remote", url, transport, headers: {}, clientInfo: { name: "fixture", version: "1" }, connectTimeoutMs: 2000, ...extra });

test("SPEC-MCP-003/CA-01 — an unauthenticated HTTP server publishes its tool at startup and receives the tool result round trip", async () => {
  for (const withHeader of [false, true]) {
  const s = server("stream"), ws = workspace();
  const file = `${ws.configHome}/connectors.json`;
  await Bun.write(file, JSON.stringify({ servers: { remote: { transport: "http", url: s.url, headers: withHeader ? { Authorization: "Bearer ${CONNECTOR_TEST_TOKEN}" } : {} } } }));
  const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_remote_lookup", input: {} }] }, { text: "done" }]);
  try {
    const r = await cli(["--non-interactive", "--wait-for-mcp", "x"], ws, { provider: p, env: { CONNECTOR_TEST_TOKEN: "synthetic29" }, userConfig: { permissions: { allowRules: ["cnx_remote"] } } });
    expect(r.code).toBe(0); expect(p.requests[0]!.tools.map((t) => t.name)).toContain("cnx_remote_lookup");
    expect(JSON.stringify(p.requests[1]!.history)).toContain("REMOTE_VALUE_29 é漢");
    expect(JSON.stringify(p.requests[1]!.history)).not.toContain("synthetic29");
    expect(r.stderr).not.toContain("synthetic29");
    const subsequent = s.requests.filter((r) => r.message?.method !== "initialize");
    expect(subsequent.some((r) => r.method === "DELETE")).toBe(true);
    for (const r of subsequent) { expect(r.headers.get("MCP-Session-Id")).toBe("fixture-session29"); expect(r.headers.get("MCP-Protocol-Version")).toBe("2025-06-18"); }
    expect(s.requests.every((r) => r.headers.get("Authorization") === (withHeader ? "Bearer synthetic29" : null))).toBe(true);
  } finally { s.stop(); }
  }
}, 15_000);

test("SPEC-MCP-003/CA-02 — a protected server returns 401 and the connector shows authentication required without exposing tokens", async () => {
  let attempts = 0;
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { attempts++; return new Response("synthetic-secret29", { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://example.invalid/oauth"' } }); } });
  const ws = workspace(); await Bun.write(`${ws.configHome}/connectors.json`, JSON.stringify({ servers: { guarded: { transport: "http", url: `http://127.0.0.1:${s.port}/mcp`, headers: { Authorization: "Bearer synthetic-secret29" } } } }));
  const h = new Host(ws, { argv: ["--wait-for-mcp"], provider: new ScriptedProvider([]), init: {} });
  try {
    const status = await h.request("invoke_command", { command: "/connectors" });
    expect(JSON.stringify(status)).toContain("authentification requise");
    expect(JSON.stringify(status)).not.toContain("synthetic-secret29");
    h.feed.end(); const r = await h.finish(); expect(r.stderr).not.toContain("synthetic-secret29"); expect(attempts).toBe(1);
  } finally { h.feed.end(); await h.finish(); s.stop(true); }
}, 15_000);

test("SPEC-MCP-003/CA-03 — loading a remote cleartext URL rejects its declaration before any connection", () => {
  const s = resolveConnectors([{ scope: "user", source: "fixture", content: { servers: { unsafe: { transport: "http", url: "http://remote.example/mcp?secret=synthetic29" } } } }], { connectorsOnly: false, denyList: [], managedServersOnly: false, projectChoice: () => "approved" });
  expect(s.connectors).toHaveLength(0); expect(s.warnings.join(" ")).toContain("URL non sécurisée refusée"); expect(s.warnings.join(" ")).not.toContain("synthetic29");
});

test("TECH — a 401 on the notification channel during discovery requires authentication without automatic retries", async () => {
  let initializations = 0;
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "GET") return new Response("synthetic-secret29", { status: 401 });
    const m = await req.json() as { id?: number; method: string };
    if (!m.id) return new Response(null, { status: 202 });
    if (m.method === "initialize") { initializations++; return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } }); }
    await new Promise((r) => setTimeout(r, 100)); return Response.json({ jsonrpc: "2.0", id: m.id, result: { tools: [] } });
  } });
  const ws = workspace(); await Bun.write(`${ws.configHome}/connectors.json`, JSON.stringify({ servers: { guarded: { transport: "http", url: `http://127.0.0.1:${s.port}/mcp` } } }));
  const h = new Host(ws, { argv: ["--wait-for-mcp"], provider: new ScriptedProvider([]), init: {} });
  try { await new Promise((r) => setTimeout(r, 1200)); const status = await h.request("invoke_command", { command: "/connectors" }); expect(JSON.stringify(status)).toContain("authentification requise"); expect(initializations).toBe(1); }
  finally { h.feed.end(); await h.finish(); s.stop(true); }
}, 15_000);

test("TECH — legacy SSE keeps the endpoint channel alive after initialization and executes tools", async () => {
  const s = server("legacy"); let c: HttpConnection | undefined;
  try { c = await open(s.url, "sse", { connectTimeoutMs: 500 }); await new Promise((r) => setTimeout(r, 650)); expect((await c.listTools(1000))[0]!.name).toBe("lookup"); expect((await c.callTool("lookup", {}, { timeoutMs: 1000 })).content[0]!.text).toContain("REMOTE_VALUE_29"); }
  finally { await c?.close(); s.stop(); }
});

test("TECH — redirect and legacy endpoint changes cannot forward connector headers to another origin", async () => {
  let received = 0;
  const other = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { received++; return Response.json({}); } });
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { return req.method === "GET" ? new Response(`event: endpoint\ndata: http://127.0.0.1:${other.port}/messages\n\n`, { headers: { "content-type": "text/event-stream" } }) : new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${other.port}/mcp` } }); } });
  try { for (const transport of ["http", "sse"] as const) await expect(open(`http://127.0.0.1:${s.port}/mcp`, transport, { headers: { Authorization: "Bearer synthetic29" } })).rejects.toThrow("autre origine"); expect(received).toBe(0); }
  finally { s.stop(true); other.stop(true); }
});

test("TECH — credentials supplied in a legacy endpoint query are masked before tool results leave the transport", async () => {
  const s = server("legacy", "?token=leased-token29&sessionId=leased-session29&opaque=opaque-credential29"); let c: HttpConnection | undefined;
  try { c = await open(s.url, "sse"); const result = JSON.stringify(await c.callTool("lookup", {}, { timeoutMs: 1000 })); expect(result).toContain("REMOTE_VALUE_29"); for (const value of ["leased-token29", "leased-session29", "opaque-credential29"]) expect(result).not.toContain(value); }
  finally { await c?.close(); s.stop(); }
});

test("TECH — a credential in an arbitrary declared header is masked when reflected by the server", async () => {
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(options.body as string);
    if (message.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : { content: [{ type: "text", text: new Headers(options.headers).get("X-Opaque") }] } });
  }) as typeof fetch;
  const c = await open("http://127.0.0.1:12345/mcp", "http", { fetch: fetcher, headers: { "X-Opaque": "synthetic-header29" } });
  try { expect((await c.callTool("echo", {}, { timeoutMs: 1000 })).content).toEqual([{ type: "text", text: "[redacted]" }]); }
  finally { await c.close(); }
});

test("TECH — short query values cannot corrupt MCP framing or amplify redaction recursively", async () => {
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(options.body as string);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } }
      : message.method === "tools/list" ? { tools: [{ name: "echo", description: "a", inputSchema: { type: "object", properties: { data: { type: "string", description: "a" } } } }] }
      : { content: [{ type: "text", text: "a".repeat(1000) }], structuredContent: { a: "a" } };
    return Response.json({ jsonrpc: "2.0", id: message.id, result });
  }) as typeof fetch;
  const c = await open("http://127.0.0.1:12345/mcp?p1=a&p2=e&p3=d&p4=r&p5=c&p6=t", "http", { fetch: fetcher });
  try {
    expect((await c.listTools(1000))[0]).toEqual({ name: "echo", description: "[redacted]", inputSchema: { type: "object", properties: { data: { type: "string", description: "[redacted]" } } } });
    const result = await c.callTool("echo", { data: "value" }, { timeoutMs: 1000 });
    expect(result.content).toEqual([{ type: "text", text: "[redacted]".repeat(1000) }]);
    expect(result.structuredContent).toEqual({ "[redacted]": "[redacted]" });
    expect(JSON.stringify(result).length).toBeLessThan(11_000);
  } finally { await c.close(); }
});

test("TECH — secret masking refuses an expanded result beyond eight MiB instead of allocating an unbounded result", async () => {
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(options.body as string);
    if (message.id === undefined) return new Response(null, { status: 202 });
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : { content: [{ type: "text", text: "*".repeat(900_000) }] } });
  }) as typeof fetch;
  const c = await open("http://127.0.0.1:12345/mcp?opaque=*", "http", { fetch: fetcher });
  try { await expect(c.callTool("echo", {}, { timeoutMs: 1000 })).rejects.toThrow("The connector request failed."); }
  finally { await c.close(); }
});

test("TECH — a dropped response stream resumes its own event cursor without replaying the tool POST", async () => {
  let posts = 0, cursor = "";
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "GET") { cursor = req.headers.get("Last-Event-ID") ?? ""; if (!cursor) return new Response(null, { status: 405 }); return new Response('data: {"jsonrpc":"2.0","id":2,"result":{"tools":[]}}\n\n', { headers: { "content-type": "text/event-stream" } }); }
    const m = await req.json() as { id?: number; method: string };
    if (!m.id) return new Response(null, { status: 202 });
    if (m.method === "initialize") return Response.json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: {} } });
    posts++; return new Response('id: request-stream29\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n', { headers: { "content-type": "text/event-stream" } });
  } });
  let c: HttpConnection | undefined;
  try { c = await open(`http://127.0.0.1:${s.port}/mcp`); expect(await c.listTools(1000)).toEqual([]); expect(cursor).toBe("request-stream29"); expect(posts).toBe(1); }
  finally { await c?.close(); s.stop(true); }
});

test("TECH — a timed out HTTP tool sends cancellation, keeps the connection usable and returns a timeout outcome", async () => {
  const messages: string[] = []; let calls = 0;
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(options.body as string); messages.push(message.method);
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "tools/call" && ++calls === 1) return await new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), { once: true });
    });
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : { content: [{ type: "text", text: "completed" }] } });
  }) as typeof fetch;
  const c = await open("http://127.0.0.1:12345/mcp", "http", { fetch: fetcher });
  try {
    const tool = connectorTool({ name: "slow", inputSchema: { type: "object" } }, "cnx_remote_slow", { server: "remote", descriptionMax: 2000, timeoutMs: 20, outputLimit: 1000, estimateTokens: () => 1, store: () => "", overflowed: () => {}, call: (name, args, options) => c.callTool(name, args, options) });
    const result = await tool.execute({} as never, { signal: new AbortController().signal, modelImages: false } as never);
    expect(result.errorKind).toBe("timeout"); expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain("the call was cancelled");
    expect(messages).toContain("notifications/cancelled"); expect(c.lost).toBeUndefined();
    expect((await c.callTool("slow", {}, { timeoutMs: 1000 })).content[0]!.text).toBe("completed");
  } finally { await c.close(); }
});

test("TECH — an empty SSE event type dispatches a normal MCP message", async () => {
  const fetcher = (async (_url: unknown, options: RequestInit) => {
    if (options.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(options.body as string);
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result = message.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : { tools: [{ name: "lookup", inputSchema: { type: "object" } }] };
    return new Response(`event:\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n\n`, { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  const c = await open("http://127.0.0.1:12345/mcp", "http", { fetch: fetcher });
  try { expect((await c.listTools(1000))[0]!.name).toBe("lookup"); }
  finally { await c.close(); }
});
