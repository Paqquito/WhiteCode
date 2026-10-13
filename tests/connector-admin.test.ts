import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { BUN, productEnv } from "./helpers/hooks";
import { httpConnectorServer } from "./helpers/fake-mcp-http";

test("SPEC-MCP-019/CA-01 — connector add in user scope writes a validated declaration while retaining comments", async () => {
  const ws = workspace(); ws.write("home/config/connectors.json", "{\n  // kept38\n  \"servers\": {}\n}\n");
  const result = await cli(["connector", "add", "docs", "--scope", "user", "--env", "FIRST=1", "--env", "SECOND=2", "--", BUN, join(import.meta.dir, "helpers/mcp-server.ts")], ws);
  expect(result.code).toBe(0); const text = readFileSync(`${ws.configHome}/connectors.json`, "utf8"); expect(text).toContain("// kept38"); expect(text).toContain('"docs"'); expect(text).toContain('"FIRST"'); expect(text).toContain('"SECOND"');
  const duplicate = await cli(["connector", "add", "docs", "--scope", "user", "--", BUN], ws); expect(duplicate.code).not.toBe(0); expect(readFileSync(`${ws.configHome}/connectors.json`, "utf8")).toBe(text);
});

test("SPEC-MCP-019/CA-02 — connector list --json returns a stable document with state and source, without opening a session", async () => {
  const ws = workspace(); ws.write("home/config/connectors.json", JSON.stringify({ servers: { docs: { command: "fixture", env: { TOKEN: "synthetic-secret38" } } } }));
  const result = await cli(["connector", "list", "--json"], ws); expect(result.code).toBe(0);
  const document = JSON.parse(result.stdout); expect(document.version).toBe(1); expect(document.connectors[0]).toMatchObject({ name: "docs", scope: "user", state: "pending", source: join(ws.configHome, "connectors.json") }); expect(result.stdout).not.toContain("synthetic-secret38");
});

test("SPEC-MCP-019/CA-03 — connector validate really connects and lists the tools, resources and prompts", async () => {
  const ws = workspace(), server = httpConnectorServer(); ws.write("home/config/connectors.json", JSON.stringify({ servers: { docs: { url: server.url } } }));
  try { const result = await cli(["connector", "validate", "docs", "--json"], ws, { env: productEnv(ws) }); expect(result.code).toBe(0); const document = JSON.parse(result.stdout); expect(document.state).toBe("connected"); expect(document.tools).toContain("cnx_docs_lookup"); expect(server.requests.some(r => r.message?.method === "initialize")).toBe(true); }
  finally { server.stop(); }
});

test("TECH — connector administration masks declarations and rejects managed writes, blocked declarations and ambiguous removal", async () => {
  const ws = workspace(); ws.write("home/config/connectors.json", JSON.stringify({ servers: { docs: { url: "https://example.invalid/mcp?opaque=synthetic38", headers: { Authorization: "Bearer synthetic-secret38" }, env: { OTHER: "synthetic-env38" } } } }));
  const shown = await cli(["connector", "show", "docs", "--json"], ws); expect(shown.code).toBe(0); expect(shown.stdout).not.toContain("synthetic");
  const managed = await cli(["connector", "remove", "docs", "--scope", "managed"], ws); expect(managed.code).not.toBe(0);
  const blocked = await cli(["connector", "add", "bad", "--scope", "user", "--transport", "http", "--", "http://external.invalid"], ws); expect(blocked.code).not.toBe(0);
  const local = await cli(["connector", "add", "docs", "--scope", "local", "--", BUN], ws); expect(local.code).toBe(0);
  const ambiguous = await cli(["connector", "remove", "docs"], ws); expect(ambiguous.code).not.toBe(0);
  expect((await cli(["connector", "show", "docs", "--json"], ws)).code).toBe(0);
});
