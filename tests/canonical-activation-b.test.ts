// Supports: SPEC-BLD-002, SPEC-OUT-017, SPEC-MOT-039 (canonical capability boundaries).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { capabilityProbe } from "./helpers/capability-probe";
const FILE = join(import.meta.dir, "fixtures", "canonical-b-probe.ts");
const OFF = Object.fromEntries(["browser_embedded", "contribution_attribution", "deep_links", "user_file_delivery", "process_monitor", "memory_initial_state", "ui_native_clipboard_image", "ui_attempt_stats", "output_file_persistence", "return_summary", "performance_tracing", "diagnostics_slow_ops", "local_session_messaging", "memory_consolidation"].map(name => [name, false]));
const ERRORS = ["browserError", "contributionError", "linkParseError", "linkResolveError", "linkRegistrationError", "linkLaunchError", "deliveryToolError", "deliveryReceiverError", "fileCardError", "snapshotError", "clipboardError", "outputError", "consolidationError", "traceError", "slowError"];
const MARKERS = ["Control an isolated browser using accessibility references", "permissionRequests", "URL Protocol", "Deliver existing local files as user-visible artifacts", "Runs a command in the background and turns each line", ".snapshot-sync.json", "Windows.Forms.Clipboard", "Tentatives par session", "Output file count limit reached", "Summarize recent work, checks", "performance-trace.json", "expiresMs", "List other live sessions of this system user", "Start a visible background consolidation of project memory"];
test("TECH — canonical B exclusion preserves team messages while refusing local sessions and manual consolidation", async () => {
  const { data } = await capabilityProbe(FILE, OFF);
  expect(data.browserError).toContain("unavailable in this build"); expect(data.peerNames).toEqual(["message_agent"]); expect(data.teamSends).toBe(1); expect(data.peerReads).toBe(0); expect(data.localError).toBe(true); expect(data.consolidationError).toContain("unavailable in this build"); expect(data.starts).toBe(0);
}, 30000);
test("TECH — internal development bar retains recent measurements without the excluded slow-operation logger", async () => {
  const { data } = await capabilityProbe(FILE, { diagnostics_slow_ops: false }, "internal");
  expect(data.slowError).toContain("unavailable in this build"); expect(data.defaultLogs).toBe(0); expect(data.defaultRecent).toEqual([{ name: "probe.measurement", durationMs: 60, sizeBytes: 0 }]);
}, 30000);
test("TECH — canonical B capabilities reject explicit activation before effects and remove their compiled bodies", async () => {
  const { data, source } = await capabilityProbe(FILE, OFF);
  for (const key of ERRORS) expect(data[key], key).toContain("unavailable in this build");
  expect(data.emittedDelivery).toBe(false); expect(data.deliveryNegotiation).toHaveProperty("error"); expect(data.delivered).toBe(0); expect(data.monitorEnabled).toBe(false); expect(data.monitorResult).toHaveProperty("isError", true);
  expect(data.uploads).toBe(0); expect(data.traceExists).toBe(false); expect(data.slowLogs).toBe(0); expect(data.purposes).toEqual(["input_suggestion"]); expect(data.textClipboardRetained).toBe(true);
  expect(data.statistics).toContain("Calendrier 2026-10"); expect(data.statistics).not.toContain("tentatives"); expect(data.statistics).not.toContain("Tentatives par session");
  for (const marker of MARKERS) expect(source.includes(marker), marker).toBe(false);
}, 30000);
test("TECH — canonical B defaults retain output persistence, attempt histogram, performance and ordinary suggestions", async () => {
  const { data, source } = await capabilityProbe(FILE, {});
  for (const key of ["browserError", "linkParseError", "linkResolveError", "linkRegistrationError", "linkLaunchError", "deliveryToolError", "deliveryReceiverError", "fileCardError", "snapshotError", "clipboardError", "outputError", "consolidationError", "traceError", "slowError"]) expect(data[key], key).toBeUndefined();
  expect(data.emittedDelivery).toBe(true); expect(data.deliveryNegotiation).toHaveProperty("type", "control_init"); expect(data.monitorEnabled).toBe(true); expect(data.uploads).toBe(1); expect(data.traceExists).toBe(true); expect(data.slowLogs).toBe(1); expect(data.purposes).toEqual(["return_recap", "input_suggestion"]); expect(data.textClipboardRetained).toBe(true);
  expect(data.peerNames).toEqual(["list_peers", "message_agent"]); expect(data.teamSends).toBe(1); expect(data.statistics).toContain("Tentatives par session"); expect(data.statistics).toContain("Calendrier 2026-10");
  for (const marker of MARKERS) expect(source.includes(marker), marker).toBe(true);
}, 30000);
