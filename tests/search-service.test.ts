import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

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
