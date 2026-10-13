import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { cli, workspace } from "./helpers/env";
import { BUN } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, KEY } from "./helpers/interactive";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVcoAAAAASUVORK5CYII=";
function setup() {
  const ws = workspace(), servers: Record<string, unknown> = {};
  for (const name of ["docs", "images"]) {
    const path = ws.write(`${name}.json`, JSON.stringify({ tools: [], resourcesPageSize: 1, resources: name === "docs" ? [{ uri: "document:guide", name: "guide", mimeType: "text/plain", text: "Text resource witness" }, { uri: "document:faq", name: "faq", mimeType: "text/plain", text: "Frequently asked witness" }, { uri: "binary:data", name: "binary", mimeType: "application/octet-stream", blob: "U0VDUkVULUJJTkFSWS1XSVRORVNT" }] : [{ uri: "picture:pixel", name: "pixel", mimeType: "image/png", blob: PNG }] }));
    servers[name] = { transport: "stdio", command: BUN, args: [join(import.meta.dir, "helpers", "mcp-server.ts"), path] };
  }
  writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers })); return ws;
}

test("SPEC-OUT-028/CA-01 — listing two connected resource servers includes their names and published addresses", async () => {
  const ws = setup(), provider = new ScriptedProvider([{ toolCalls: [{ name: "list_connector_resources", input: {} }] }, { text: "listed" }]);
  const result = await cli(["--non-interactive", "--wait-for-mcp", "List resources."], ws, { provider });
  expect(result.code).toBe(0); const history = JSON.stringify(provider.requests[1]!.history);
  expect(history).toContain("document:guide"); expect(history).toContain("docs"); expect(history).toContain("picture:pixel"); expect(history).toContain("images");
  expect(history).toContain("document:faq");
});
test("SPEC-MCP-010/CA-01 — typing a resource server prefix proposes its cached published resources", async () => {
  const ws = setup(), provider = new ScriptedProvider([{ text: "attached" }]), controller = new AbortController();
  const run = interactive(["--wait-for-mcp"], ws, { provider, signal: controller.signal });
  try { await run.idle(); run.type("@docs:"); await run.waitFor(t => t.includes("docs:document:guide") && t.includes("guide")); run.type(KEY.enter); run.type(KEY.enter); await run.waitFor(t => t.includes("attached")); expect(JSON.stringify(provider.requests[0]!.history)).toContain("Untrusted connector resource"); } finally { controller.abort(); await run.done; }
}, 12_000);
test("SPEC-MCP-010/CA-02 — a user binary resource reference inserts a mention and never its bytes", async () => {
  const ws = setup(), provider = new ScriptedProvider([{ text: "done" }]);
  await cli(["--non-interactive", "--wait-for-mcp", "Read @docs:binary:data"], ws, { provider }); const history = JSON.stringify(provider.requests[0]!.history);
  expect(history).toContain("Binary resource docs:binary:data"); expect(history).not.toContain("U0VDUkVULUJJTkFSWS1XSVRORVNT");
});
test("TECH — explicit resource references respect denials and pasted or code spans stay inert", async () => {
  const ws = setup(); for (const [input, denied] of [["Read @docs:document:guide", true], ["Read `@docs:document:guide`", false]] as const) { const provider = new ScriptedProvider([{ text: "done" }]); await cli(["--non-interactive", "--wait-for-mcp", ...(denied ? ["--deny-rule", "read_connector_resource(docs)"] : []), input], ws, { provider }); expect(JSON.stringify(provider.requests[0]!.history)).not.toContain("Text resource witness"); }
});

test("TECH — published text is returned unchanged after checking its paginated publication", async () => {
  const ws = setup(), provider = new ScriptedProvider([{ toolCalls: [{ name: "read_connector_resource", input: { server: "docs", uri: "document:faq" } }] }, { text: "text read" }]);
  const result = await cli(["--non-interactive", "--wait-for-mcp", "--allow-rule", "read_connector_resource(docs)", "Read text."], ws, { provider });
  expect(result.code).toBe(0); expect(JSON.stringify(provider.requests[1]!.history)).toContain('"text":"Frequently asked witness"');
});

test("SPEC-OUT-028/CA-02 — a published image becomes image content in the actual next model request", async () => {
  const ws = setup(), provider = new ScriptedProvider([{ toolCalls: [{ name: "read_connector_resource", input: { server: "images", uri: "picture:pixel" } }] }, { text: "image read" }]);
  const result = await cli(["--non-interactive", "--wait-for-mcp", "--model", "large", "--allow-rule", "read_connector_resource(images)", "Read the image."], ws, { provider });
  expect(result.code).toBe(0);
  const results = provider.requests[1]!.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result") : []);
  expect(JSON.stringify(results)).toContain(PNG); expect(JSON.stringify(results)).toContain('"type":"image"'); expect(JSON.stringify(results)).toContain('"mediaType":"image/png"');
});

test("TECH — unpublished addresses and server-specific denials refuse resource reads", async () => {
  const ws = setup();
  for (const [uri, denied] of [["document:guide", true], ["document:missing", false]] as const) {
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_connector_resource", input: { server: "docs", uri } }] }, { text: "done" }]);
    await cli(["--non-interactive", "--wait-for-mcp", "--allow-rule", "read_connector_resource", ...(denied ? ["--deny-rule", "read_connector_resource(docs)"] : []), "Read."], ws, { provider });
    const history = JSON.stringify(provider.requests[1]!.history); expect(history).not.toContain("Text resource witness"); expect(history).toContain('"isError":true');
    expect(history).toContain(denied ? "Denied by the rule" : "non publiée");
  }
});
