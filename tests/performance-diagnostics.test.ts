import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { PerformanceRecorder } from "../src/shared/performance";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { projectSessions } from "../src/session/sessions";
import { ScriptedProvider } from "./helpers/scripted-provider";

const prefix = loadIdentity().get("ENV_PREFIX");
test("SPEC-OBS-008/CA-01 — an actual session produces a viewer-compatible JSON trace without conversation or file contents", async () => {
  const ws = workspace(); const trace = join(ws.root, "trace.json"); const path = ws.write("project/a", "PRIVATE_FILE_WITNESS_291");
  const r = await cli(["--non-interactive", "PRIVATE_PROMPT_WITNESS_292"], ws, { env: { [`${prefix}PERF_TRACE`]: trace }, provider: new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { text: "PRIVATE_REPLY_WITNESS_293" }]) });
  expect(r.code).toBe(0); expect(r.stderr).toContain(trace);
  const raw = readFileSync(trace, "utf8"), doc = JSON.parse(raw);
  expect(doc.traceEvents.length).toBeGreaterThan(0); expect(doc.traceEvents.some((event: { name: string }) => event.name === "query")).toBe(true);
  for (const event of doc.traceEvents) { expect(event.ph).toBe("X"); expect(event.ts).toBeGreaterThanOrEqual(0); expect(event.dur).toBeGreaterThan(0); expect(event.pid).toBeGreaterThan(0); expect(event.tid).toBeGreaterThan(0); }
  for (const witness of ["PRIVATE_FILE_WITNESS_291", "PRIVATE_PROMPT_WITNESS_292", "PRIVATE_REPLY_WITNESS_293", path]) expect(raw).not.toContain(witness);
});

test("SPEC-OBS-009/CA-01 — startup profiling lists the steps through initial display, with duration and memory for every step", async () => {
  const ws = workspace();
  const r = await cli(["--non-interactive", "go"], ws, { env: { [`${prefix}PROFILE`]: "startup" }, provider: new ScriptedProvider([{ text: "done" }]) });
  expect(r.code).toBe(0); const info = projectSessions(join(ws.configHome, "sessions"), ws.project)[0]!;
  const path = join(ws.configHome, "sessions", readdirSync(join(ws.configHome, "sessions"))[0]!, info.id, "performance-profile.json");
  const report = JSON.parse(readFileSync(path, "utf8")); expect(report.samples.length).toBeGreaterThanOrEqual(5);
  expect(report.samples.at(-1).name).toBe("startup.step-5");
  for (const sample of report.samples) { expect(sample.phase).toBe("startup"); expect(sample.durationMs).toBeGreaterThanOrEqual(0); expect(sample.rssBytes).toBeGreaterThan(0); expect(sample.heapUsedBytes).toBeGreaterThan(0); }
  expect(r.stderr).toContain(path);
});

test("SPEC-OBS-013/CA-01 — a forty-millisecond serialization under a ten-millisecond threshold is logged with its duration and size", async () => {
  const ws = workspace(); let clock = 0;
  const r = await cli(["--non-interactive", "--result-format", "jsonl", "go"], ws, { env: { [`${prefix}SLOW_OP_WARN_MS`]: "10" }, provider: new ScriptedProvider([{ text: "CONTENT_MUST_NOT_BE_LOGGED" }]), extra: { performanceNow: () => clock += 40 } });
  expect(r.code).toBe(0); expect(r.stderr).toMatch(/Opération lente : serialize, 40\.00 ms, \d+ octets/); expect(r.stderr).not.toContain("CONTENT_MUST_NOT_BE_LOGGED");
});

test("TECH — diagnostic rotation remains parseable, recent operations expire, and existing output files are preserved", () => {
  const ws = workspace(); const trace = ws.write("existing.json", "ORIGINAL_FILE"); const warnings: string[] = []; let clock = 0;
  const blocked = new PerformanceRecorder({ directory: ws.root, trace, warn: message => warnings.push(message), log: () => {} }); blocked.close();
  expect(readFileSync(trace, "utf8")).toBe("ORIGINAL_FILE"); expect(warnings).toHaveLength(1);
  const fresh = join(ws.root, "new-trace.json");
  const recorder = new PerformanceRecorder({ directory: ws.root, trace: fresh, slowMs: 10, now: () => clock, maxEvents: 2, warn: message => warnings.push(message), log: () => {} });
  for (let n = 0; n < 3; n++) recorder.record({ name: "serialize", phase: "query", startMs: n * 50, durationMs: 40, rssBytes: 100, heapUsedBytes: 50, sizeBytes: 123 });
  expect(recorder.recent).toHaveLength(3); clock = 5001; expect(recorder.recent).toHaveLength(0);
  recorder.close(); expect(existsSync(`${fresh}.1.json`)).toBe(true);
  expect(JSON.parse(readFileSync(fresh, "utf8")).traceEvents).toHaveLength(2); expect(JSON.parse(readFileSync(`${fresh}.1.json`, "utf8")).traceEvents).toHaveLength(1);
  expect(warnings).toHaveLength(1);
});
