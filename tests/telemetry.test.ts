// Supports: SPEC-OBS-001/002/004/011/020, SPEC-CFG-008; real engine and actual local OTLP collector.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, loadIdentity } from "./helpers/env";
import { Identity } from "../src/identity/identity";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { productAttributes } from "../src/observability/session";
const prefix = loadIdentity().get("ENV_PREFIX");
const identity = () => { const old = loadIdentity().resolved; return new Identity({ ...old, values: { ...old.values, SERVICE_TELEMETRY: { value: "https://telemetry.fixture.example/events", origin: "provided" }, SERVICE_ERROR_REPORTING: { value: "https://errors.fixture.example/envelope", origin: "provided" } } }); };
const otel = (url: string) => ({ [`${prefix}TELEMETRY`]: "1", OTEL_METRICS_EXPORTER: "otlp", OTEL_LOGS_EXPORTER: "otlp", OTEL_TRACES_EXPORTER: "otlp", OTEL_EXPORTER_OTLP_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_ENDPOINT: url });
const bodies = () => {
  const rows: Array<{ url: string; body: string }> = [];
  const fetcher = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => { rows.push({ url: String(input), body: String(init?.body) }); return new Response("{}"); }) as typeof fetch;
  return { rows, fetcher };
};

test("TECH — explicit console exporters emit without enabling diagnostic logging or making connections", async () => {
  const ws = workspace(), calls = bodies();
  const r = await cli(["--non-interactive", "private prompt"], ws, { provider: new ScriptedProvider([{ text: "done" }]), env: { [`${prefix}TELEMETRY`]: "1", OTEL_METRICS_EXPORTER: "console", OTEL_LOGS_EXPORTER: "console", OTEL_TRACES_EXPORTER: "none" }, extra: { observabilityFetch: calls.fetcher } });
  expect(r.code).toBe(0); expect(calls.rows).toEqual([]);
  expect(r.stderr).toContain('"signal":"metrics"'); expect(r.stderr).toContain('"signal":"logs"'); expect(r.stderr).not.toContain("private prompt");
});

test("TECH — ephemeral diagnostics and failed product exports leave no persistent queue or diagnostic directory", async () => {
  const ws = workspace(), fetcher = (async (_input: Parameters<typeof fetch>[0]) => new Response("", { status: 503 })) as typeof fetch;
  const r = await cli(["--non-interactive", "--ephemeral", "private prompt"], ws, { provider: new ScriptedProvider([{ text: "done" }]), identity: identity(), userConfig: { telemetry: { enabled: true } }, extra: { observabilityFetch: fetcher } });
  expect(r.code).toBe(0); expect(existsSync(join(ws.configHome, "diagnostics"))).toBe(false); expect(existsSync(join(ws.configHome, "telemetry"))).toBe(false); expect(existsSync(join(ws.configHome, "sessions"))).toBe(false);
});

test("SPEC-OBS-001/CA-01 — all product refusal routes cut every connection for a complete session", async () => {
  for (const route of ["env", "settings", "managed", "offline"]) {
    const ws = workspace(), calls = bodies();
    if (route === "managed") ws.write("managed/policy.json", '{"telemetry":{"enabled":false}}');
    const r = await cli(["--non-interactive", "private prompt"], ws, { provider: new ScriptedProvider([{ text: "done" }]), identity: identity(), env: route === "env" ? { [`${prefix}NO_TELEMETRY`]: "1" } : route === "offline" ? { [`${prefix}OFFLINE_MINIMAL`]: "1" } : {}, userConfig: { telemetry: { enabled: route !== "settings" } }, extra: { observabilityFetch: calls.fetcher } });
    expect(r.code).toBe(0); expect(calls.rows).toEqual([]);
  }
});

test("SPEC-CFG-008/CA-02 — imposed NO_TELEMETRY overrides a user's opt-in", async () => {
  const ws = workspace(), calls = bodies(); ws.write("managed/policy.json", JSON.stringify({ environment: { variables: { [`${prefix}NO_TELEMETRY`]: "1" } } }));
  expect((await cli(["--non-interactive", "private prompt"], ws, { provider: new ScriptedProvider([{ text: "done" }]), identity: identity(), env: { [`${prefix}NO_TELEMETRY`]: "0" }, userConfig: { telemetry: { enabled: true } }, extra: { observabilityFetch: calls.fetcher } })).code).toBe(0);
  expect(calls.rows).toEqual([]);
});

test("SPEC-OBS-001/CA-02 — path-bearing and unknown attributes are removed and actual events exclude content", async () => {
  expect(productAttributes({ path: "C:/private/file", tool: "C:/private/file", length: 8, result: "ok", extra: "hidden" })).toEqual({ length: 8, result: "ok" });
  const calls = bodies(), ws = workspace(), file = ws.write("project/private.txt", "PRIVATE_CONTENT_WITNESS");
  const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "done" }]);
  expect((await cli(["--non-interactive", "PRIVATE_PROMPT_WITNESS"], ws, { provider: p, identity: identity(), userConfig: { telemetry: { enabled: true } }, extra: { observabilityFetch: calls.fetcher } })).code).toBe(0);
  const data = JSON.stringify(calls.rows); expect(calls.rows.length).toBeGreaterThan(0); expect(data).not.toContain(ws.root); expect(data).not.toContain("PRIVATE_CONTENT_WITNESS"); expect(data).not.toContain("PRIVATE_PROMPT_WITNESS");
});

test("SPEC-OBS-002/CA-01 — SPEC-OBS-002/CA-02 — SPEC-OBS-004/CA-01 — two real tools export token counters, length-only logs and parented spans to an OTLP collector", async () => {
  const rows: Array<{ path: string; data: Record<string, unknown> }> = [];
  const collector = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(req) { rows.push({ path: new URL(req.url).pathname, data: await req.json() as Record<string, unknown> }); return Response.json({}); } });
  const ws = workspace(), file = ws.write("project/read.txt", "PRIVATE_FILE_WITNESS"), p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }, { name: "find_files", input: { pattern: "*.txt" } }], usage: { input: 17, output: 2 } }, { text: "done", usage: { input: 33, output: 4 } }]);
  try {
    const r = await cli(["--non-interactive", "PRIVATE_PROMPT_WITNESS"], ws, { provider: p, env: otel(`http://127.0.0.1:${collector.port}`) });
    expect(r.code).toBe(0);
    const metrics = rows.filter(r => r.path === "/v1/metrics").flatMap(r => (r.data.resourceMetrics as any[]).flatMap(rm => rm.scopeMetrics.flatMap((sm: any) => sm.metrics)));
    expect(metrics.find(m => m.name.endsWith("tool.usage")).sum.dataPoints.reduce((n: number, p: any) => n + Number(p.asInt), 0)).toBe(2);
    expect(metrics.find(m => m.name.endsWith("token.usage")).sum.dataPoints.reduce((n: number, p: any) => n + Number(p.asInt), 0)).toBe(56);
    const logs = rows.filter(r => r.path === "/v1/logs").flatMap(r => (r.data.resourceLogs as any[]).flatMap(rm => rm.scopeLogs.flatMap((sm: any) => sm.logRecords)));
    const submitted = logs.find(l => l.body.stringValue === "message_submitted"); expect(submitted.attributes).toEqual([{ key: "length", value: { intValue: "22" } }]);
    const spans = rows.filter(r => r.path === "/v1/traces").flatMap(r => (r.data.resourceSpans as any[]).flatMap(rm => rm.scopeSpans.flatMap((sm: any) => sm.spans)));
    const interaction = spans.find(s => s.name === "interaction"); expect(interaction).toBeDefined();
    expect(spans.filter(s => s.name === "model_request")).toHaveLength(2); expect(spans.filter(s => s.name === "tool")).toHaveLength(2);
    for (const s of spans.filter(s => s !== interaction)) { expect(s.traceId).toBe(interaction.traceId); expect(s.parentSpanId).toBe(interaction.spanId); expect(BigInt(s.endTimeUnixNano)).toBeGreaterThanOrEqual(BigInt(s.startTimeUnixNano)); }
    const data = JSON.stringify(rows); expect(data).not.toContain("PRIVATE_PROMPT_WITNESS"); expect(data).not.toContain("PRIVATE_FILE_WITNESS"); expect(data).not.toContain(ws.root);
  } finally { collector.stop(true); }
});

test("SPEC-OBS-004/CA-02 — interruption closes every span, including already completed children, as cancelled", async () => {
  const ws = workspace(), c = new AbortController(), calls = bodies(), file = ws.write("project/a", "ok");
  const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { hang: true }]);
  const running = cli(["--non-interactive", "x"], ws, { provider: p, env: otel("http://127.0.0.1:1"), signal: c.signal, extra: { observabilityFetch: calls.fetcher } });
  const end = Date.now() + 5000; while (p.requests.length < 2 && Date.now() < end) await Bun.sleep(10);
  expect(p.requests).toHaveLength(2); c.abort(); await running;
  const data = JSON.parse(calls.rows.find(r => r.url.endsWith("/v1/traces"))!.body), spans = data.resourceSpans.flatMap((rm: any) => rm.scopeSpans.flatMap((sm: any) => sm.spans));
  expect(spans.length).toBeGreaterThanOrEqual(4); for (const s of spans) { expect(s.status.message).toBe("cancelled"); expect(s.endTimeUnixNano).toMatch(/^\d+$/); }
});

test("SPEC-OBS-011/CA-01 — SPEC-OBS-011/CA-02 — unexpected exceptions are scrubbed, deduplicated and suppressed by telemetry refusal", async () => {
  for (const refused of [false, true]) {
    const ws = workspace(), calls = bodies(), provider = { id: "fixture", async *stream(): AsyncIterable<never> { const e = new Error("secret-fixture-value C:/users/private/file https://private/path"); e.stack = "Error: secret-fixture-value\n at stream (C:/users/private/file:8:2)"; throw e; } };
    await cli(["--non-interactive", "x"], ws, { provider, identity: identity(), env: refused ? { [`${prefix}NO_TELEMETRY`]: "1" } : {}, userConfig: { telemetry: { enabled: true } }, extra: { observabilityFetch: calls.fetcher } });
    const errors = calls.rows.filter(r => r.url.includes("errors.fixture")); expect(errors).toHaveLength(refused ? 0 : 1);
    if (!refused) { expect(errors[0]!.body).toContain("stacktrace"); expect(errors[0]!.body).not.toContain("secret-fixture-value"); expect(errors[0]!.body).not.toContain("C:/"); expect(errors[0]!.body).not.toContain("https://private"); }
  }
});

test("SPEC-OBS-020/CA-01 — connection failure leaves a typed persistent diagnostic without URL or response content", async () => {
  const ws = workspace(), p = new ScriptedProvider([{ error: { kind: "connection", message: "https://private.example/path?secret=HIDDEN_WITNESS" } }]);
  await cli(["--non-interactive", "PRIVATE_PROMPT"], ws, { provider: p, userConfig: { api: { retry: { maxRetries: 0 } } } });
  const dir = join(ws.configHome, "diagnostics"); expect(existsSync(dir)).toBe(true);
  const data = readdirSync(dir).map(name => readFileSync(join(dir, name), "utf8")).join("\n");
  expect(data).toContain('"event":"connection_error"'); expect(data).not.toContain("https://"); expect(data).not.toContain("PRIVATE_PROMPT"); expect(data).not.toContain("HIDDEN_WITNESS");
});

test("TECH — a failed product batch is bounded on disk and retried by a subsequent session", async () => {
  const ws = workspace(), bad = (async (_input: Parameters<typeof fetch>[0]) => new Response("", { status: 503 })) as typeof fetch;
  await cli(["--non-interactive", "PRIVATE_PROMPT"], ws, { provider: new ScriptedProvider([{ text: "PRIVATE_ANSWER" }]), identity: identity(), userConfig: { telemetry: { enabled: true } }, extra: { observabilityFetch: bad } });
  const dir = join(ws.configHome, "telemetry"), saved = readdirSync(dir).filter(n => n.endsWith(".json")); expect(saved).toHaveLength(1);
  const data = readFileSync(join(dir, saved[0]!), "utf8"); expect(data).not.toContain("PRIVATE_PROMPT"); expect(data).not.toContain("PRIVATE_ANSWER"); expect(data.length).toBeLessThan(65536);
  const calls = bodies(); await cli(["--non-interactive", "next"], ws, { provider: new ScriptedProvider([{ text: "done" }]), identity: identity(), userConfig: { telemetry: { enabled: true } }, extra: { observabilityFetch: calls.fetcher } });
  expect(JSON.parse(calls.rows[0]!.body).events.filter((e: { name: string }) => e.name.endsWith("session_started"))).toHaveLength(2);
  expect(readdirSync(dir).filter(n => n.endsWith(".json"))).toEqual([]);
});

test("TECH — an exporter that never settles cannot hold shutdown indefinitely", async () => {
  const ws = workspace(), fetcher = ((_input: Parameters<typeof fetch>[0]) => new Promise<Response>(() => {})) as typeof fetch, start = Date.now();
  await cli(["--non-interactive", "x"], ws, { provider: new ScriptedProvider([{ text: "done" }]), identity: identity(), userConfig: { telemetry: { enabled: true } }, extra: { observabilityFetch: fetcher } });
  expect(Date.now() - start).toBeLessThan(3000);
}, 5000);
