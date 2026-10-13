// Supports: SPEC-OUT-049, SPEC-OBS-005/007/010/021; real execution and local exports.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { permissionTestTool } from "../src/tools/permission-test";
import { runTurn } from "../src/engine/loop";
import { parseRule } from "../src/permissions/rules";
import { SessionObserver, type ObserverOptions } from "../src/observability/session";
import { collaborationMetadata } from "../src/observability/collaboration";
import { Identity } from "../src/identity/identity";
import { bench } from "./helpers/engine";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const prefix = loadIdentity().get("ENV_PREFIX");
const signal = () => new AbortController().signal;

test("SPEC-OUT-049/CA-01 — the public CLI excludes the permission probe even when environment variables request it", async () => {
  const provider = new ScriptedProvider([{ text: "done" }]);
  const result = await cli(["--non-interactive", "hello"], workspace(), { provider, env: { [`${prefix}BUILD_PROFILE`]: "test", [`${prefix}PERMISSION_TEST`]: "1" } });
  expect(result.code).toBe(0); expect(provider.requests[0]?.tools.some(t => t.name === "permission_test")).toBe(false);
});

test("SPEC-OUT-049/CA-02 — an ask-mode probe reaches the human authority before returning its deterministic result", async () => {
  let requests = 0;
  const b = bench([{ toolCalls: [{ name: "permission_test", input: { label: "witness" } }] }, { text: "done" }], {
    mode: "ask", tools: [permissionTestTool as never], authorities: { human: { request: async request => { requests++; expect(request.toolName).toBe("permission_test"); return { answer: "yes" }; } } },
  });
  await runTurn(b.deps, "probe", signal());
  expect(requests).toBe(1); expect(b.toolResults()[0]?.isError).toBe(false); expect(JSON.stringify(b.toolResults())).toContain("witness");
});

test("SPEC-OUT-049/CA-03 — an explicit allow rule suppresses the probe dialogue through the ordinary executor", async () => {
  let requests = 0;
  const rule = parseRule("permission_test", "allow", "user", process.cwd()); if (!("decision" in rule)) throw new Error("Invalid fixture rule.");
  const b = bench([{ toolCalls: [{ name: "permission_test", input: { label: "allowed" } }] }, { text: "done" }], {
    mode: "ask", rules: [rule], tools: [permissionTestTool as never], authorities: { human: { request: async () => { requests++; return { answer: "no" }; } } },
  });
  await runTurn(b.deps, "probe", signal()); expect(requests).toBe(0); expect(b.toolResults()[0]?.isError).toBe(false);
});

function observer(extra: Partial<ObserverOptions> = {}) {
  const ws = workspace(), rows: string[] = [];
  const o = new SessionObserver({ slug: "fixture", eventPrefix: "fixture", version: "1.0.0", configDir: ws.configHome, platform: "test", persist: false, sessionId: () => "session", entrypoint: "non-interactive", productEnabled: () => true, otelEnabled: () => true, errorEnabled: () => false, includePrompts: false, includeSessionId: false, environment: name => name.endsWith("EXPORTER") ? "console" : undefined, fetch, warn: () => {}, console: value => rows.push(value), diagnosticRetentionDays: 1, secrets: [], ...extra });
  return { o, rows };
}

test("SPEC-OBS-005/CA-01 — enhanced spans report actual tool byte sizes without input or output content", async () => {
  const { o, rows } = observer({ enhanced: true, includeToolContent: false }); o.start();
  await o.interaction("private request", signal(), async () => {
    o.event({ type: "tool_call", callId: "one", name: "read_file", input: { path: "PRIVATE_INPUT_WITNESS" } });
    o.event({ type: "tool_result", callId: "one", isError: false, durationMs: 2, output: "PRIVATE_OUTPUT_WITNESS" });
  });
  await o.close(); const output = rows.join("\n");
  expect(output).toContain("tool.input.bytes"); expect(output).toContain("tool.output.bytes");
  expect(output).not.toContain("PRIVATE_INPUT_WITNESS"); expect(output).not.toContain("PRIVATE_OUTPUT_WITNESS");
});

test("SPEC-OBS-005/CA-01 — a real file tool exports sizes through the CLI while dedicated content consent is absent", async () => {
  const ws = workspace(), file = ws.write("project/private.txt", "PRIVATE_TOOL_OUTPUT_WITNESS"), rows: string[] = [];
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "done" }]);
  const result = await cli(["--non-interactive", "read it"], ws, { provider, env: { [`${prefix}TELEMETRY`]: "1", [`${prefix}DETAILED_TELEMETRY`]: "1", OTEL_TRACES_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "none", OTEL_LOGS_EXPORTER: "none", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" }, extra: { observabilityFetch: (async (_url, init) => { rows.push(String(init?.body)); return new Response("{}"); }) as typeof fetch } });
  expect(result.code).toBe(0); expect(rows.join()).toContain("tool.input.bytes"); expect(rows.join()).toContain("tool.output.bytes"); expect(rows.join()).not.toContain("PRIVATE_TOOL_OUTPUT_WITNESS"); expect(rows.join()).not.toContain(file); expect(rows.join()).not.toContain("tool.input.content");
});

test("TECH — enhanced content requires its own consent, is scrubbed and is bounded, while malformed roles are ignored", async () => {
  expect(collaborationMetadata("role\nprivate")).toEqual({}); expect(collaborationMetadata("a".repeat(100)).commonProductAttributes?.orchestrator_role).toHaveLength(64);
  const { o, rows } = observer({ enhanced: true, includeToolContent: true, secrets: ["fixture-secret-value"] }); o.start();
  await o.interaction("request", signal(), async () => { o.event({ type: "tool_call", callId: "x", name: "read_file", input: { key: "fixture-secret-value" } }); o.event({ type: "tool_result", callId: "x", isError: false, durationMs: 1, output: "fixture-secret-value" + "x".repeat(10_000) }); });
  await o.close(); const trace = JSON.parse(rows.find(row => JSON.parse(row).signal === "traces")!);
  const spans = trace.data.resourceSpans[0].scopeSpans[0].spans, attributes = spans.find((span: { name: string }) => span.name === "tool").attributes;
  const content = attributes.find((attribute: { key: string }) => attribute.key === "tool.output.content").value.stringValue;
  expect(content).toHaveLength(4096); expect(content).not.toContain("fixture-secret-value"); expect(content).toContain("[redacted]");
});

test("TECH — an explicit telemetry refusal prevents enriched exports despite all consent variables", async () => {
  const ws = workspace(), file = ws.write("project/private.txt", "PRIVATE_WITNESS"); let exports = 0;
  const result = await cli(["--non-interactive", "read it"], ws, { provider: new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "done" }]), env: { [`${prefix}NO_TELEMETRY`]: "1", [`${prefix}TELEMETRY`]: "1", [`${prefix}DETAILED_TELEMETRY`]: "1", [`${prefix}TELEMETRY_INCLUDE_CONTENT`]: "1", OTEL_TRACES_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "none", OTEL_LOGS_EXPORTER: "none", OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:9" }, extra: { observabilityFetch: (async (_url, _init) => { exports++; return new Response("{}"); }) as typeof fetch } });
  expect(result.code).toBe(0); expect(exports).toBe(0); expect(result.stderr).not.toContain("exportent les entrées");
});

test("SPEC-OBS-007/CA-01 — a validated reviewer role labels product events and trace resources", async () => {
  const rows: string[] = []; const { o } = observer({ ...collaborationMetadata("relecteur"), productUrl: "https://fixture.example/events", fetch: (async (_url, init) => { rows.push(String(init?.body)); return new Response("{}"); }) as typeof fetch, console: value => rows.push(value) });
  o.start(); await o.interaction("private", signal(), async () => {}); await o.close();
  expect(rows.some(row => row.includes('"orchestrator_role":"relecteur"'))).toBe(true);
  expect(rows.some(row => row.includes('"key":"orchestrator.role"'))).toBe(true); expect(rows.join()).not.toContain("private");
});

test("SPEC-OBS-010/CA-01 — closing an actual interactive session exports measured frame statistics", async () => {
  const run = interactive([], workspace(), { provider: new ScriptedProvider([{ text: "done" }]), env: { [`${prefix}TELEMETRY`]: "1", OTEL_METRICS_EXPORTER: "console", OTEL_LOGS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "none" } });
  await run.idle(); run.type("hello" + KEY.enter); await run.waitFor(text => text.includes("done")); run.type("/exit" + KEY.enter);
  const result = await run.done; expect(result.code).toBe(0); expect(result.stderr).toContain("render.frames"); expect(result.stderr).toContain("render.duration");
});

test("SPEC-IHM-039/CA-01 — a public interactive session records a slow operation without displaying an internal development bar", async () => {
  const controller = new AbortController(), provider = new ScriptedProvider([{ text: "slow response", delayMs: 700 }]);
  const run = interactive([], workspace(), { provider, signal: controller.signal, env: { [`${prefix}SLOW_OP_WARN_MS`]: "1", [`${prefix}BUILD_PROFILE`]: "internal" } });
  try { await run.idle(); run.type("hello" + KEY.enter); await run.waitFor(text => text.includes("slow response")); await run.waitFor(text => text.includes("Opération lente")); expect(run.all().join("\n")).not.toContain("Développement ·"); }
  finally { controller.abort(); await run.done; }
});

test("SPEC-OBS-021/CA-03 — reopening with changed prices retains the previous tariff and its fingerprint", async () => {
  const ws = workspace(), old = { inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 1, cacheWritePerMTok: 1, effectiveDate: "2026-01-01", source: "fixture-old", currency: "USD" };
  const initial = await cli(["--non-interactive", "--model", "large", "--result-format", "json", "first"], ws, { provider: new ScriptedProvider([{ text: "done", usage: { input: 1000, output: 100 } }]), userConfig: { models: { pricingOverrides: { "test-large": old } } } });
  expect(initial.code).toBe(0); const first = JSON.parse(initial.stdout);
  const resumed = await cli(["--non-interactive", `--reopen=${first.sessionId}`, "--result-format", "json", "next"], ws, { identity: new Identity({ ...loadIdentity().resolved, version: "0.2.0" }), provider: new ScriptedProvider([{ text: "done", usage: { input: 1000, output: 100 } }]), userConfig: { models: { pricingOverrides: { "test-large": { ...old, inputPerMTok: 10, source: "fixture-new", effectiveDate: "2026-10-01" } } } } });
  expect(resumed.code).toBe(0); expect(JSON.parse(resumed.stdout).cost.confirmed).toBeCloseTo(0.0114);
  const files = readdirSync(join(ws.configHome, "sessions"), { recursive: true }).filter(file => String(file).endsWith(".jsonl"));
  const records = files.flatMap(file => readFileSync(join(ws.configHome, "sessions", String(file)), "utf8").trim().split("\n").map(line => JSON.parse(line)));
  const tariffs = records.filter(record => record.data?.tariff).map(record => record.data.tariff);
  expect(tariffs.map(t => t.pricing.effectiveDate)).toContain("2026-01-01"); expect(tariffs.map(t => t.pricing.effectiveDate)).toContain("2026-10-01");
  const past = tariffs.find(t => t.pricing.effectiveDate === "2026-01-01"); expect(past.pricing.inputPerMTok).toBe(1); expect(past.version).toMatch(/^sha256:[a-f0-9]{64}$/);
  const charges = records.filter(record => record.data?.event === "priced_usage"); expect(charges).toHaveLength(2); expect(charges.map(record => record.data.tariff.distributionVersion)).toEqual(["0.1.0", "0.2.0"]);
});
