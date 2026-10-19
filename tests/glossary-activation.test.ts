// Supports: SPEC-CAD-003, SPEC-BLD-002, SPEC-MOT-029, SPEC-MOT-032, SPEC-PER-015.
import { beforeAll, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { BUILD_OPTIONS, BUILD_PROFILES, resolveBuildOptions } from "../src/extension-points/build-options";
import { SETTINGS } from "../src/config/settings-schema";
import { compileProfileProbe } from "./helpers/profiled-test";
import { ROOT } from "./helpers/env";
import { BUN } from "./helpers/hooks";
import { runToCompletion } from "../src/platform/process";

const general = ["telemetry_otel_export", "telemetry_trace_export", "diagnostics_profiling", "diagnostics_debug_log", "diagnostics_terminal_recording"] as const;
const restricted = ["diagnostics_api_replay", "planning_progress_check", "tools_terminal_session", "tools_code_runtime"] as const;
const approved = [...general, ...restricted];

test("TECH — the three approved build options are present in every profile and remain inactive at runtime", () => {
  for (const profile of BUILD_PROFILES) {
    const values = resolveBuildOptions(profile);
    for (const name of ["engine_speculation", "memory_living_docs", "sandbox_commands"] as const) expect(values[name]).toBe(true);
    expect(values).not.toHaveProperty("living_docs");
  }
  for (const key of ["engine.speculation.enabled", "memory.livingDocs.enabled", "sandbox.enabled"]) expect(SETTINGS.find(setting => setting.key === key)?.default).toBe(false);
  expect(() => resolveBuildOptions("public", { living_docs: true })).toThrow("Option de build inconnue");
});

test("TECH — all nine approved options have their exact profile presence and public overrides cannot enable the four internal functions", () => {
  for (const profile of BUILD_PROFILES) {
    const values = resolveBuildOptions(profile);
    for (const flag of general) expect(values[flag]).toBe(true);
    for (const flag of restricted) expect(values[flag]).toBe(profile !== "public");
  }
  for (const flag of restricted) expect(() => resolveBuildOptions("public", { [flag]: true })).toThrow("réservée");
  expect(() => resolveBuildOptions("public", { script_mode: true })).toThrow("inconnue");
  for (const key of ["tools.scriptMode.enabled", "tools.terminalSession.enabled"]) expect(SETTINGS.find(setting => setting.key === key)?.default).toBe(false);
});

const probes = new Map<string, ReturnType<typeof compileProfileProbe>>();
beforeAll(() => {
  const entry = join(ROOT, "tests/fixtures/activation-nine-probe.ts");
  for (const [name, profile, overrides] of [
    ["public", "public", {}], ["test", "test", {}],
    ["none", "public", Object.fromEntries(approved.map(flag => [flag, false]))],
    ["no-otel", "public", { telemetry_otel_export: false }],
    ["no-trace", "public", { telemetry_trace_export: false }],
  ] as const) probes.set(name, compileProfileProbe(profile, entry, overrides));
  probes.set("main-none", compileProfileProbe("public", join(ROOT, "src/main.ts"), Object.fromEntries(approved.map(flag => [flag, false]))));
}, 120000);
function run(name: string, mode: string): { profile: string; result: { code: number; stdout: string; stderr: string }; requests: number; tools: string[][]; files: string[]; references: string[] } {
  const f = probes.get(name)!, r = runToCompletion(BUN, ["--no-env-file", f.output, mode], { cwd: f.root, env: f.environment, timeoutMs: 10000 });
  if (r.code !== 0) throw Error(r.stderr + r.stdout);
  const result = JSON.parse(r.stdout);
  writeFileSync(join(dirname(f.output), "probe-" + mode + ".json"), JSON.stringify(result, null, 2));
  return result;
}

test("TECH — compiled public entry points cannot restore internal tools or API references through settings, variables or the legacy port", () => {
  const tools = run("public", "tools"), script = run("public", "script"), api = run("public", "api");
  expect(tools.profile).toBe("public"); expect(tools.result.code).toBe(0); expect(tools.tools.flat()).not.toContain("terminal_session"); expect(tools.tools.flat()).not.toContain("check_plan_progress");
  expect(script.result.code).toBe(0); expect(script.tools.flat()).not.toContain("run_code");
  expect(api.result.code).toBe(2); expect(api.requests).toBe(0); expect(api.references).toHaveLength(0); expect(api.files.some(file => file.startsWith("references/"))).toBe(false);
  for (const flag of restricted) for (const marker of BUILD_OPTIONS[flag].absentMarkers) expect(probes.get("public")!.source.includes(marker), flag + ": " + marker).toBe(false);
});

test("TECH — an actual included test-profile bundle exposes the selected tools and records only after explicit activation", () => {
  const tools = run("test", "tools"), script = run("test", "script"), api = run("test", "api"), defaults = run("test", "default");
  expect(tools.profile).toBe("test"); expect(tools.tools.flat()).toContain("terminal_session"); expect(tools.tools.flat()).toContain("check_plan_progress");
  expect(script.tools).toEqual([["run_code"]]); expect(api.result.code).toBe(0); expect(api.references).toHaveLength(1);
  expect(defaults.result.code).toBe(0); expect(defaults.references).toHaveLength(0); expect(defaults.tools.flat()).not.toContain("terminal_session"); expect(defaults.tools.flat()).not.toContain("check_plan_progress"); expect(defaults.tools.flat()).not.toContain("run_code");
  for (const flag of restricted) for (const marker of BUILD_OPTIONS[flag].absentMarkers) expect(probes.get("test")!.source.includes(marker), flag + ": " + marker).toBe(true);
});

test("TECH — explicit diagnostic variables cannot reactivate code omitted from an actual reduced public bundle", () => {
  const disabled = run("none", "diagnostics"), defaults = run("public", "default");
  expect(disabled.result.code).toBe(0); expect(disabled.files.some(file => /explicit-debug|explicit-terminal|performance-profile/.test(file))).toBe(false);
  expect(disabled.result.stderr).not.toContain("resourceMetrics"); expect(disabled.result.stderr).not.toContain("resourceLogs"); expect(disabled.result.stderr).not.toContain("resourceSpans");
  for (const flag of approved) for (const marker of BUILD_OPTIONS[flag].absentMarkers) expect(probes.get("none")!.source.includes(marker), flag + ": " + marker).toBe(false);
  for (const flag of approved) for (const marker of BUILD_OPTIONS[flag].absentMarkers) expect(probes.get("main-none")!.source.includes(marker), "main: " + flag + ": " + marker).toBe(false);
  expect(defaults.files.some(file => /explicit-debug|explicit-terminal|performance-profile/.test(file))).toBe(false); expect(defaults.result.stderr).not.toContain("resourceSpans");
});

test("TECH — OpenTelemetry metrics/logs and session traces are independently removed while included diagnostics retain their runtime opt-in", () => {
  const enabled = run("public", "diagnostics"), noOtel = run("no-otel", "diagnostics"), noTrace = run("no-trace", "diagnostics");
  expect(enabled.files.some(file => file.endsWith("explicit-debug.log"))).toBe(true); expect(enabled.files.some(file => file.endsWith("explicit-terminal.cast"))).toBe(true); expect(enabled.files.some(file => file.endsWith("performance-profile.json"))).toBe(true);
  for (const marker of ["resourceMetrics", "resourceLogs", "resourceSpans"]) expect(enabled.result.stderr).toContain(marker);
  expect(noOtel.result.stderr).not.toContain("resourceMetrics"); expect(noOtel.result.stderr).not.toContain("resourceLogs"); expect(noOtel.result.stderr).toContain("resourceSpans");
  expect(noTrace.result.stderr).toContain("resourceMetrics"); expect(noTrace.result.stderr).toContain("resourceLogs"); expect(noTrace.result.stderr).not.toContain("resourceSpans");
  for (const marker of BUILD_OPTIONS.telemetry_otel_export.absentMarkers) expect(probes.get("no-otel")!.source.includes(marker), marker).toBe(false);
  for (const marker of BUILD_OPTIONS.telemetry_trace_export.absentMarkers) expect(probes.get("no-trace")!.source.includes(marker), marker).toBe(false);
});
