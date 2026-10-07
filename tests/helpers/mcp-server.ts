// A simulated MCP server for the connector tests, reached through its standard input and output (one JSON-RPC message
// per line). Its behaviour comes from a JSON file whose path is the first argument.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

interface FakeTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

interface FakeConfig {
  tools: FakeTool[];
  /** Answers of `tools/call` by tool name; default: the arguments echoed as text. */
  responses?: Record<string, { text?: string; json?: unknown; repeat?: number; isError?: boolean; delayMs?: number }>;
  /** Delay before answering `initialize`; `never` leaves it unanswered. */
  initDelayMs?: number | "never";
  /** Exits with code 1 after this many calls (written to `crashMarker` so that a restart does not crash again). */
  crashAfterCalls?: number;
  crashMarker?: string;
  /** Lines written on the standard error at start. */
  stderrLines?: string[];
  /** File receiving the pid of the server, one per start. */
  pidFile?: string;
  /** File receiving each method received. */
  logFile?: string;
  /** After this delay, a tool is added and `notifications/tools/list_changed` is sent. */
  addToolAfterMs?: { ms: number; tool: FakeTool };
  /** Answers with a line that is not JSON-RPC. */
  garbage?: boolean;
}

const config = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as FakeConfig;
const tools = [...config.tools];
let calls = 0;
const send = (m: unknown) => process.stdout.write(`${JSON.stringify(m)}\n`);
const schema = (t: FakeTool) => t.inputSchema ?? { type: "object", properties: { q: { type: "string" } } };

if (config.pidFile) appendFileSync(config.pidFile, `${process.pid}\n`);
for (const l of config.stderrLines ?? []) process.stderr.write(`${l}\n`);

async function handle(msg: { id?: number; method?: string; params?: any }): Promise<void> {
  if (config.logFile && msg.method) appendFileSync(config.logFile, `${msg.method}\n`);
  if (msg.method === "initialize") {
    if (config.initDelayMs === "never") return;
    if (config.initDelayMs) await Bun.sleep(config.initDelayMs);
    if (config.garbage) {
      process.stdout.write("this is not json\n");
      return;
    }
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "fake", version: "1.0.0" } } });
    if (config.addToolAfterMs) {
      const { ms, tool } = config.addToolAfterMs;
      setTimeout(() => {
        tools.push(tool);
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }, ms);
    }
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: tools.map((t) => ({ name: t.name, description: t.description ?? `The ${t.name} tool.`, inputSchema: schema(t), ...(t.annotations ? { annotations: t.annotations } : {}) })) } });
    return;
  }
  if (msg.method === "tools/call") {
    calls++;
    const crashed = config.crashMarker !== undefined && existsSync(config.crashMarker);
    if (config.crashAfterCalls !== undefined && calls > config.crashAfterCalls && !crashed) {
      if (config.crashMarker) writeFileSync(config.crashMarker, "1");
      process.stderr.write("fatal: simulated crash\n");
      process.exit(1);
    }
    const r = config.responses?.[msg.params.name];
    if (r?.delayMs) await Bun.sleep(r.delayMs);
    const text = r?.json !== undefined ? JSON.stringify(r.json) : r?.text !== undefined ? r.text.repeat(r.repeat ?? 1) : `called ${msg.params.name} with ${JSON.stringify(msg.params.arguments)}`;
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }], isError: r?.isError === true } });
    return;
  }
  if (msg.method === "ping") {
    send({ jsonrpc: "2.0", id: msg.id, result: {} });
    return;
  }
  if (msg.id !== undefined) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
}

let buffer = "";
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8");
  let nl: number;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) void handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
