import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { DEFAULT_WEB_SEARCH_ENDPOINT } from "../src/config/settings-schema";
import { searchExa, SearchRateLimited } from "../src/tools/exa-search";

test("TECH — the public search service accepts anonymous MCP calls and returns attributable excerpts", async () => {
  const requests: string[] = [];
  const network = (async (url, init) => {
    expect(String(url)).toBe(DEFAULT_WEB_SEARCH_ENDPOINT);
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
    if (init?.method === "GET") return new Response(null, { status: 405 });
    const message = JSON.parse(String(init?.body));
    requests.push(message.method);
    if (!message.id) return new Response(null, { status: 202 });
    if (message.method === "initialize") return Response.json({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} } } });
    expect(message.params.name).toBe("web_search_exa");
    expect(message.params.arguments.query).toBe("test search");
    expect(message.params.arguments.objective).toContain("example.org");
    const text = "Title: First\nURL: https://example.org/one\nPublished: N/A\nAuthor: N/A\nHighlights:\nFirst passage\n\nTitle: Second\nURL: https://example.org/two\nText: Second passage";
    const reply = { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text }] } };
    return new Response("data: " + JSON.stringify(reply) + "\n\n", { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  expect(await searchExa({ query: "test search", include_domains: ["example.org"] }, network, new AbortController().signal)).toEqual([
    { title: "First", url: "https://example.org/one", excerpt: "First passage" },
    { title: "Second", url: "https://example.org/two", excerpt: "Second passage" },
  ]);
  expect(requests).toEqual(["initialize", "notifications/initialized", "tools/call"]);
});

test("TECH — an anonymous provider quota is reported without retrying through another service", async () => {
  const network = Object.assign(async () => new Response(null, { status: 429 }), { preconnect: fetch.preconnect });
  await expect(searchExa({ query: "test search" }, network, new AbortController().signal)).rejects.toBeInstanceOf(SearchRateLimited);
});

test("SPEC-OUT-013/CA-02 — a configured search service returns only the allowed domain and its subdomains", async () => {
  const requests: unknown[] = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) { requests.push(await request.json()); return Response.json({ results: [{ title: "Allowed", url: "https://docs.allowed.test/page", excerpt: "ALLOWED_EXCERPT" }, { title: "Blocked", url: "https://allowed.test.evil.test/page", excerpt: "FORBIDDEN_EXCERPT" }] }); } });
  try {
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "search_web", input: { query: "Find the documentation", include_domains: ["allowed.test"] } }] }, { text: "done" }]);
    const result = await cli(["--non-interactive", "Search."], workspace(), { provider, userConfig: { tools: { webSearch: { endpoint: `http://127.0.0.1:${server.port}/search` } } } });
    expect(result.code).toBe(0); expect(requests).toHaveLength(1);
    const history = JSON.stringify(provider.requests[1]!.history); expect(history).toContain("ALLOWED_EXCERPT"); expect(history).toContain("https://docs.allowed.test/page"); expect(history).not.toContain("FORBIDDEN_EXCERPT");
  } finally { await server.stop(true); }
});

test("SPEC-OUT-013/CA-03 — combining include and exclude domains refuses the call before any service request", async () => {
  let calls = 0; const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() { calls++; return Response.json({ results: [] }); } });
  try {
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "search_web", input: { query: "Find documentation", include_domains: ["a.test"], exclude_domains: ["b.test"] } }] }, { text: "done" }]);
    await cli(["--non-interactive", "Search."], workspace(), { provider, userConfig: { tools: { webSearch: { endpoint: `http://127.0.0.1:${server.port}/search` } } } });
    expect(calls).toBe(0); expect(JSON.stringify(provider.requests[1]!.history)).toContain("never both");
  } finally { await server.stop(true); }
});
