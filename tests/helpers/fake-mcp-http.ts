// Supports: SPEC-MCP-003 (local transport fixtures).
export function httpConnectorServer(mode: "json" | "stream" | "legacy" = "json", query = "") {
  const requests: Array<{ method: string; headers: Headers; message?: Record<string, unknown> }> = [];
  let channel: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "DELETE") { requests.push({ method: req.method, headers: req.headers }); return new Response(null, { status: 204 }); }
    if (req.method === "GET") {
      requests.push({ method: "GET", headers: req.headers });
      if (mode !== "legacy") return new Response(null, { status: 405 });
      return new Response(new ReadableStream({ start(c) { channel = c; c.enqueue(encoder.encode(`event: endpoint\r\ndata: /messages${query}\r\n\r\n`)); }, cancel() { channel = undefined; } }), { headers: { "content-type": "text/event-stream" } });
    }
    const m = await req.json() as Record<string, unknown>;
    requests.push({ method: req.method, headers: req.headers, message: m });
    if (m.id === undefined) return new Response(null, { status: 202 });
    const result = m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : m.method === "tools/list" ? { tools: [{ name: "lookup", description: "Look up a fixture value", inputSchema: { type: "object", properties: {} } }] }
      : { content: [{ type: "text", text: `REMOTE_VALUE_29 é漢 ${req.headers.get("Authorization") ?? ""} ${[...new URL(req.url).searchParams.values()].join(" ")}` }] };
    const json = JSON.stringify({ jsonrpc: "2.0", id: m.id, result });
    if (mode === "legacy") { channel!.enqueue(encoder.encode(`event: message\ndata: ${json}\n\n`)); return new Response(null, { status: 202 }); }
    if (mode === "stream" && m.method === "tools/call") {
      const bytes = encoder.encode(`: comment\r\nid: event29\r\ndata: ${json}\r\n\r\n`);
      return new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(new Uint8Array([byte])); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ jsonrpc: "2.0", id: m.id, result }, { headers: m.method === "initialize" ? { "MCP-Session-Id": "fixture-session29" } : {} });
  } });
  return { url: `http://127.0.0.1:${s.port}/mcp`, requests, stop: () => s.stop(true) };
}
