// Supports: SPEC-MCP-015/CA-01/02 (terminal presentation and faithful model content).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { cli, ROOT, workspace } from "./helpers/env";
import { BUN } from "./helpers/hooks";
import { interactive } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { connectorDisplay, connectorDisplayRaw } from "../src/connectors/display";
import { connectorResultView } from "../src/interactive/views";
import { layoutNode } from "../src/ui/layout";
function fixture() {
  const ws = workspace(), config = ws.write("server.json", JSON.stringify({ tools: [{ name: "rows", inputSchema: { type: "object", properties: {}, additionalProperties: false } }], responses: { rows: { text: "ORIGINAL_CONNECTOR_TEXT_815", structuredContent: [{ name: "Alpha", count: 42 }, { name: "Beta", count: 7 }] } } }));
  ws.write("home/config/connectors.json", JSON.stringify({ servers: { docs: { command: BUN, args: [join(ROOT, "tests/helpers/mcp-server.ts"), config] } } })); return ws;
}
const script = [{ toolCalls: [{ name: "cnx_docs_rows", input: {} }] }, { text: "Table inspected." }];
test("SPEC-MCP-015/CA-01 — a structured connector result displays columns in the live terminal", async () => {
  const controller = new AbortController(), run = interactive(["--wait-for-mcp", "--allow-rule", "cnx_docs_rows"], fixture(), { provider: new ScriptedProvider(script), signal: controller.signal });
  try { await run.idle(); run.type("Show the connector table.\r"); await run.waitFor(text => text.includes("Table inspected.")); const screen = run.screen().join("\n"); expect(screen).toContain("Alpha"); expect(screen).toContain("Beta"); expect(screen).toMatch(/name\s+\|\s+count/); expect(screen).toContain("42"); }
  finally { controller.abort(); await run.done; }
}, 15_000);
test("SPEC-MCP-015/CA-02 — the model receives the original connector text independently of its structured display", async () => {
  const provider = new ScriptedProvider(script); const result = await cli(["--non-interactive", "--wait-for-mcp", "--allow-rule", "cnx_docs_rows", "Read the table."], fixture(), { provider });
  expect(result.code).toBe(0); const parts = provider.requests[1]!.history.flatMap(message => message.role === "user" ? message.parts : []).filter(part => part.type === "tool_result");
  expect(parts).toHaveLength(1); expect(parts[0]!.content).toEqual([{ type: "text", text: "ORIGINAL_CONNECTOR_TEXT_815" }]);
});

test("TECH — structured display masks sensitive patterns before clipping and preserves the complete redacted raw detail", () => {
  const secret = "sk-" + "A".repeat(32), long = "Original scalar. ".repeat(20) + "RAW_STRUCTURED_TAIL_815";
  const value = [{ name: "abcdefghijklmnopqrst " + secret, note: long }], display = connectorDisplay(value, 40, text => text)!;
  expect(display).not.toContain("sk-"); expect(display).not.toContain("A".repeat(8));
  const raw = connectorDisplayRaw(value, text => text); expect(raw).not.toContain(secret); expect(raw).toContain("RAW_STRUCTURED_TAIL_815"); expect(JSON.parse(raw)[0].note).toBe(long);
});

test("TECH — a wide thousand-row table remains under forty physical lines in an eighty-column terminal", () => {
  const rows = Array.from({ length: 1000 }, (_, row) => Object.fromEntries(Array.from({ length: 12 }, (_, column) => [`column-${column}`, `${row}:` + "v".repeat(40)])));
  const display = connectorDisplay(rows, 40)!; expect(display).toContain("963 lignes supplémentaires");
  const laid = layoutNode(connectorResultView(display), 80, { unicode: "full", narrow: false }); expect(laid.lines.length).toBeLessThanOrEqual(40); expect(laid.lines.every(line => line.length === 80)).toBe(true);
});
