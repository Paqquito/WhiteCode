// Supports: SPEC-MCP-017 (configured service discovery, real MCP transport and persisted disable).
import { expect, test } from "bun:test";
import { companyFixture } from "./helpers/company";
import { cli } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("TECH — a managed-only connector policy prevents even the account catalogue request", async () => {
  const f = fixture();
  await f.login();
  f.ws.write(
    "managed/policy.json",
    JSON.stringify({ mcp: { managedServersOnly: true } }),
  );
  const result = await cli(
    ["--non-interactive", "--wait-for-mcp", "Local work"],
    f.ws,
    {
      identity: f.identity,
      extra: f.extra,
      provider: new ScriptedProvider([
        { text: "Managed connector policy respected" },
      ]),
    },
  );
  expect(result.code).toBe(0);
  expect(f.sent.some((row) => row.path.includes("/connectors/"))).toBe(false);
});
function fixture() {
  const f = companyFixture();
  f.handle((path, body) => {
    if (path === "/api/connectors/list")
      return { connectors: [{ id: "docs-id", name: "docs" }] };
    if (path === "/api/connectors/docs-id/rpc") {
      const message = (
        body as {
          message: {
            id?: number;
            method: string;
            params?: { protocolVersion?: string };
          };
        }
      ).message;
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params!.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "company-fixture", version: "1.0.0" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  {
                    name: "lookup",
                    description: "Return the connector witness.",
                    inputSchema: { type: "object", properties: {} },
                  },
                ],
              }
            : {
                content: [
                  { type: "text", text: "Web connector actual tool receipt" },
                ],
              };
      return { jsonrpc: "2.0", id: message.id, result };
    }
    return undefined;
  });
  return f;
}
test("TECH — the real CLI discovers a company web connector and calls its namespaced tool with the pinned company account", async () => {
  const f = fixture();
  await f.login();
  const provider = new ScriptedProvider([
    (request) => {
      expect(
        request.tools.some((tool) => tool.name === "cnx_web-docs_lookup"),
      ).toBe(true);
      return { toolCalls: [{ name: "cnx_web-docs_lookup", input: {} }] };
    },
    (request) => {
      expect(JSON.stringify(request.history)).toContain(
        "Web connector actual tool receipt",
      );
      return { text: "Web tool used" };
    },
  ]);
  const result = await cli(
    ["--non-interactive", "--wait-for-mcp", "Lookup"],
    f.ws,
    {
      identity: f.identity,
      extra: f.extra,
      provider,
      userConfig: { permissions: { allowRules: ["cnx_web-docs"] } },
    },
  );
  if (result.code !== 0) throw new Error(result.stderr + result.stdout);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Web tool used");
  expect(
    f.sent
      .filter((row) => row.path.includes("/connectors/"))
      .every((row) => row.authorization === "Bearer fixture-company-only"),
  ).toBe(true);
}, 10000);
test("SPEC-MCP-017/CA-02 — disabling an imported web connector persists and suppresses its tools at the next actual CLI startup", async () => {
  const f = fixture();
  await f.login();
  const h = new Host(f.ws, {
    identity: f.identity,
    extra: f.extra,
    provider: new ScriptedProvider([]),
    argv: ["--wait-for-mcp"],
    init: { decisionAuthority: true },
    userConfig: { engine: { control: { allowEscalation: true } } },
    answers: { confirm_escalation: params => ({ decision: "confirm", escalationId: params["escalationId"] }) },
  });
  try {
    expect(
      JSON.stringify(
        await h.request("invoke_command", {
          command: "/connectors disable web-docs",
        }),
      ),
    ).toContain("désactivé");
    expect(h.demands("confirm_escalation")).toHaveLength(1);
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
  const calls = f.sent.filter((row) => row.path.endsWith("/rpc")).length,
    provider = new ScriptedProvider([
      (request) => {
        expect(request.tools.map((tool) => tool.name)).not.toContain(
          "cnx_web-docs_lookup",
        );
        return { text: "Disabled stays disabled" };
      },
    ]);
  expect(
    (
      await cli(["--non-interactive", "--wait-for-mcp", "Work"], f.ws, {
        identity: f.identity,
        extra: f.extra,
        provider,
      })
    ).code,
  ).toBe(0);
  expect(f.sent.filter((row) => row.path.endsWith("/rpc")).length).toBe(calls);
}, 10000);
