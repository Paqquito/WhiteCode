import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { DEFAULT_WEB_SEARCH_ENDPOINT } from "../src/config/settings-schema";
import { searchExa, SearchRateLimited } from "../src/tools/exa-search";
import type { SearchInput } from "../src/tools/search-web";

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

type Filters = Omit<SearchInput, "query">;
const filterCases: [string, Filters, Filters, string[]][] = [
  ["two empty lists", { include_domains: [], exclude_domains: [] }, {}, ["Allowed", "Other"]],
  ["empty include list", { include_domains: [] }, {}, ["Allowed", "Other"]],
  ["empty exclude list", { exclude_domains: [] }, {}, ["Allowed", "Other"]],
  ["include subdomains", { include_domains: ["allowed.test"] }, { include_domains: ["allowed.test"] }, ["Allowed"]],
  ["include subdomains with empty exclusions", { include_domains: ["allowed.test"], exclude_domains: [] }, { include_domains: ["allowed.test"] }, ["Allowed"]],
  ["exclude subdomains", { include_domains: [], exclude_domains: ["allowed.test"] }, { exclude_domains: ["allowed.test"] }, ["Other"]],
];

test.each(filterCases)("SPEC-OUT-013/CA-02 — %s", async (_name, filters, expectedFilters, expectedTitles) => {
  const requests: unknown[] = [];
  const query = "Ollama latest version";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    requests.push(await request.json());
    return Response.json({ results: [
      { title: "Allowed", url: "https://docs.allowed.test/page", excerpt: "ALLOWED_EXCERPT" },
      { title: "Other", url: "https://allowed.test.evil.test/page", excerpt: "OTHER_EXCERPT" },
    ] });
  } });
  try {
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "search_web", input: { query, ...filters } }] }, { text: "done" }]);
    const result = await cli(["--non-interactive", "Search."], workspace(), { provider, userConfig: { tools: { webSearch: { endpoint: `http://127.0.0.1:${server.port}/search` } } } });
    expect(result.code).toBe(0);
    expect(requests).toEqual([{ query, ...expectedFilters }]);
    const history = JSON.stringify(provider.requests[1]!.history);
    expect(history.includes("ALLOWED_EXCERPT")).toBe(expectedTitles.includes("Allowed"));
    expect(history.includes("https://docs.allowed.test/page")).toBe(expectedTitles.includes("Allowed"));
    expect(history.includes("OTHER_EXCERPT")).toBe(expectedTitles.includes("Other"));
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
