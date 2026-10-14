import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { cli, ROOT, workspace } from "./helpers/env";
import { BUN, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const ORIGINAL_TEXT = "Original connector summary.";
const CALL_ID = "structured-display-boundary";

async function runStructuredResult(structuredContent: unknown) {
  const ws = workspace();
  const config = ws.write("server.json", JSON.stringify({
    tools: [{ name: "rows", inputSchema: { type: "object", properties: {}, additionalProperties: false } }],
    responses: { rows: { text: ORIGINAL_TEXT, structuredContent } },
  }));
  ws.write("home/config/connectors.json", JSON.stringify({
    servers: { docs: { transport: "stdio", command: BUN, args: [join(ROOT, "tests/helpers/mcp-server.ts"), config] } },
  }));
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "cnx_docs_rows", input: {}, id: CALL_ID }] },
    { text: "Table inspected." },
  ]);
  const result = await cli([
    "--non-interactive", "--wait-for-mcp", "--result-format", "jsonl", "--stream-profile", "standard",
    "--allow-rule", "cnx_docs_rows", "Read the connector table.",
  ], ws, { provider, env: productEnv(ws), signal: AbortSignal.timeout(10_000) });
  const events = result.stdout.trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
  return { result, provider, events };
}

test("TECH — complete structured MCP data reaches the user result without entering model tool content", async () => {
  const cellTail = "FIRST_CELL_TAIL_46", rowTail = "LAST_ROW_TAIL_46";
  const rows = Array.from({ length: 60 }, (_, index) => ({
    name: `row-${index}`,
    note: index === 0 ? "Long cell. ".repeat(30) + cellTail : index === 59 ? rowTail : `Note ${index}.`,
  }));

  const { result, provider, events } = await runStructuredResult(rows);

  expect(result.code).toBe(0);
  expect(provider.requests).toHaveLength(2);
  const modelResults = provider.requests[1]!.history.flatMap(message => message.role === "user" ? message.parts : [])
    .filter(part => part.type === "tool_result");
  expect(modelResults).toHaveLength(1);
  expect(modelResults[0]!.content).toEqual([{ type: "text", text: ORIGINAL_TEXT }]);
  expect(JSON.stringify(modelResults)).not.toContain(cellTail);
  expect(JSON.stringify(modelResults)).not.toContain(rowTail);

  const userResults = events.filter(event => event["type"] === "tool_result" && event["callId"] === CALL_ID);
  expect(userResults).toHaveLength(1);
  const event = userResults[0]!;
  expect(event["errored"]).toBe(false);
  expect(event["output"]).toBe(ORIGINAL_TEXT);
  const display = event["display"] as string, raw = event["displayRaw"] as string;
  expect(typeof raw).toBe("string");
  expect(JSON.parse(raw)).toEqual(rows);
  expect(typeof display).toBe("string");
  expect(display).toContain("row-0");
  expect(display).not.toContain(cellTail);
  expect(display).not.toContain(rowTail);
}, 15_000);

test("TECH — structured presentation masks sensitive field values without changing original model content", async () => {
  const secret = "synthetic-password-46", { result, events } = await runStructuredResult({ password: secret, nested: { authorization: secret }, visible: "Shown" });
  expect(result.code).toBe(0);
  const event = events.find(event => event["type"] === "tool_result" && event["callId"] === CALL_ID)!;
  expect(event["output"]).toBe(ORIGINAL_TEXT);
  expect(String(event["display"])).not.toContain(secret);
  expect(String(event["displayRaw"])).not.toContain(secret);
  expect(JSON.parse(String(event["displayRaw"])).visible).toBe("Shown");
}, 15_000);

test("TECH — structured raw detail beyond the JSONL event limit remains complete in its user file", async () => {
  const suffix = "RAW_TAIL_46", rows = [{ note: "x".repeat(1_100_000) + suffix }], { result, events } = await runStructuredResult(rows);
  expect(result.code).toBe(0);
  const event = events.find(event => event["type"] === "tool_result" && event["callId"] === CALL_ID)!;
  expect(typeof event["displayRawPath"]).toBe("string");
  expect(JSON.parse(readFileSync(String(event["displayRawPath"]), "utf8"))).toEqual(rows);
  expect(event["displayRaw"]).toBeUndefined();
  expect(event["output"]).toBe(ORIGINAL_TEXT);
}, 15_000);

test("TECH — a synthetic secret crossing a structured cell width is absent from display and raw detail", async () => {
  const prefix = "abcdefghijklmnopqrst ", secret = "sk-" + "A".repeat(32);
  const rows = [{ name: prefix + secret, note: "Safe cell content." }];

  const { result, events } = await runStructuredResult(rows);

  expect(result.code).toBe(0);
  const userResults = events.filter(event => event["type"] === "tool_result" && event["callId"] === CALL_ID);
  expect(userResults).toHaveLength(1);
  const event = userResults[0]!;
  expect(event["errored"]).toBe(false);
  const display = event["display"] as string, raw = event["displayRaw"] as string;
  expect(typeof raw).toBe("string");
  expect(typeof display).toBe("string");
  expect(display).toContain("abcdefghijklmnop");
  for (const text of [display, raw]) {
    expect(text).not.toContain("sk-");
    expect(text).not.toContain("A".repeat(8));
    expect(text).not.toContain(secret);
  }
  expect(JSON.parse(raw)[0].name).toStartWith(prefix);
  expect(JSON.parse(raw)[0].note).toBe(rows[0]!.note);
}, 15_000);
