import { expect, test } from "bun:test";
import { Elicitation } from "../src/connectors/elicitation";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, KEY } from "./helpers/interactive";

function server() {
  let response: unknown; let pending: { stream: ReadableStreamDefaultController<Uint8Array>; id: number } | undefined;
  const encoder = new TextEncoder(); let advertised = false;
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) {
    if (req.method === "GET") return new Response(null, { status: 405 }); if (req.method === "DELETE") return new Response(null, { status: 204 });
    const m = await req.json() as Record<string, unknown>;
    if (m.id === 388 && m.result) { response = m.result; pending!.stream.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: pending!.id, result: { content: [{ type: "text", text: "elicited-done38" }] } })}\n\n`)); pending!.stream.close(); pending = undefined; return new Response(null, { status: 202 }); }
    if (m.id === undefined) return new Response(null, { status: 202 });
    if (m.method === "tools/call") return new Response(new ReadableStream({ start(stream) { pending = { stream, id: m.id as number }; stream.enqueue(encoder.encode(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 388, method: "elicitation/create", params: { message: "Choisissez une date pour la fixture.", requestedSchema: { type: "object", properties: { when: { type: "string", format: "date" } }, required: ["when"] } } })}\n\n`)); } }), { headers: { "content-type": "text/event-stream" } });
    if (m.method === "initialize") advertised = !!((m.params as { capabilities: { elicitation?: unknown } }).capabilities.elicitation);
    return Response.json({ jsonrpc: "2.0", id: m.id, result: m.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: { tools: {} } } : { tools: [{ name: "date", inputSchema: { type: "object", properties: {} } }] } });
  } });
  return { url: `http://127.0.0.1:${s.port}/mcp`, response: () => response, advertised: () => advertised, stop: () => s.stop(true) };
}

test("SPEC-MCP-012/CA-01 — an invalid calendar date is refused locally and only the reviewed valid value is sent to the connector", async () => {
  const ws = workspace(), s = server(); ws.write("home/config/connectors.json", JSON.stringify({ servers: { docs: { url: s.url } } }));
  const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_docs_date", input: {} }] }, { text: "finished-elicitation38" }]); const shutdown = new AbortController();
  const r = interactive(["--wait-for-mcp"], ws, { provider: p, signal: shutdown.signal, userConfig: { permissions: { allowRules: ["cnx_docs"] } } });
  try {
    await r.idle(); r.type("Ask for the date."); r.type(KEY.enter); await r.waitFor(t => t.includes("Champ when"));
    r.type("2026-02-30"); r.type(KEY.enter); await r.waitFor(t => t.includes("Valeur invalide pour when")); expect(s.response()).toBeUndefined();
    r.type("2026-02-28"); r.type(KEY.enter); await r.waitFor(t => t.includes("Vérifiez les réponses")); await new Promise(r => setTimeout(r, 380)); r.type(KEY.enter);
    await r.waitFor(t => t.includes("finished-elicitation38")); expect(s.response()).toEqual({ action: "accept", content: { when: "2026-02-28" } }); expect(s.advertised()).toBe(true); expect(JSON.stringify(p.requests.map(q => q.history))).not.toContain("2026-02-28");
  } finally { shutdown.abort(); await r.done; s.stop(); }
}, 15000);

test("SPEC-MCP-012/CA-02 — a real incoming headless elicitation returns cancel without blocking the tool call", async () => {
  const ws = workspace(), s = server(); ws.write("home/config/connectors.json", JSON.stringify({ servers: { docs: { url: s.url } } }));
  const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_docs_date", input: {} }] }, { text: "done" }]);
  try { const r = await cli(["--non-interactive", "--wait-for-mcp", "x"], ws, { provider: p, userConfig: { permissions: { allowRules: ["cnx_docs"] } } }); expect(r.code).toBe(0); expect(s.response()).toEqual({ action: "cancel" }); }
  finally { s.stop(); }
});

test("TECH — unsupported or nested elicitation schemas are declined and a hook answer is validated before it can replace the human", async () => {
  const handler = new Elicitation({ before: async () => ({ action: "accept", content: { when: "2026-02-30" } }), after: () => {} });
  expect(await handler.request("docs", { message: "fixture", requestedSchema: { type: "object", properties: { when: { type: "string", format: "date" } } } }, new AbortController().signal)).toEqual({ action: "decline" });
  expect(await handler.request("docs", { message: "fixture", requestedSchema: { type: "object", properties: { nested: { type: "object" } } } }, new AbortController().signal)).toEqual({ action: "decline" });
});

test("TECH — elicitation rejects impossible timestamps, contradictory bounds, known secrets and remote cleartext URL mode", async () => {
  let value: string | number = "2026-02-30T09:00:00Z";
  const h = new Elicitation({ before: async () => ({ action: "accept", content: { field: value } }), after: () => {}, containsSecret: text => text.includes("synthetic-private38") });
  const ask = (field: unknown) => h.request("docs", { message: "fixture", requestedSchema: { type: "object", properties: { field } } }, new AbortController().signal);
  expect(await ask({ type: "string", format: "date-time" })).toEqual({ action: "decline" });
  value = 5; expect(await ask({ type: "integer", minimum: 8, maximum: 2 })).toEqual({ action: "decline" });
  value = "synthetic-private38"; expect(await ask({ type: "string" })).toEqual({ action: "decline" });
  expect(await h.request("docs", { mode: "url", message: "fixture", elicitationId: "fixture", url: "http://external.invalid/" }, new AbortController().signal)).toEqual({ action: "cancel" });
});
