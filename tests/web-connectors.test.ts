// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { WebConnectors } from "../src/connectors/web";
function fixture() {
  const calls: any[] = [],
    networkCalls: any[] = [];
  let enabled = true;
  const web = new WebConnectors({
    account: {
      profile: async () => ({ account: "member", organization: { id: "org" } }),
      request: async (service, path, body) => {
        calls.push({ service, path, body });
        if (path === "list")
          return { connectors: [{ id: "docs-id", name: "docs" }] };
        return {
          jsonrpc: "2.0",
          id: (body as any).message.id,
          result: {
            content: [{ type: "text", text: "company connector receipt" }],
          },
        };
      },
    },
    webUrl: "https://company.example.test/",
    network: (async (input) => {
      networkCalls.push(String(input));
      return Response.json({});
    }) as typeof fetch,
    enabled: () => enabled,
    report: () => {},
  });
  return { web, calls, networkCalls, disable: () => (enabled = false) };
}
test("SPEC-MCP-017/CA-01 — a web-configured connector becomes a namespaced MCP proxy and uses the company service contract", async () => {
  const f = fixture(),
    source = await f.web.load(new AbortController().signal);
  expect(source?.content.servers.docs!.url).toBe(
    "https://company.example.test/api/connectors/relay/docs-id",
  );
  const response = await f.web.fetch(source!.content.servers.docs!.url, {
    method: "POST",
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "query", arguments: {} },
    }),
  });
  expect(JSON.stringify(await response.json())).toContain(
    "company connector receipt",
  );
  expect(f.calls[1].path).toBe("docs-id/rpc");
  expect(f.networkCalls).toHaveLength(0);
});
test("TECH — an unknown relay or third-party URL never receives a company request or authorization token", async () => {
  const f = fixture();
  await f.web.load(new AbortController().signal);
  expect(
    (
      await f.web.fetch(
        "https://company.example.test/api/connectors/relay/not-listed",
        { method: "POST", body: "{}" },
      )
    ).status,
  ).toBe(404);
  await f.web.fetch("https://connector.example.test/mcp", {
    method: "POST",
    body: "{}",
  });
  expect(f.calls).toHaveLength(1);
  expect(f.networkCalls).toEqual(["https://connector.example.test/mcp"]);
  f.disable();
  expect(
    (
      await f.web.fetch(
        "https://company.example.test/api/connectors/relay/docs-id",
        { method: "POST", body: "{}" },
      )
    ).status,
  ).toBe(403);
});
