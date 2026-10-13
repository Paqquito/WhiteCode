import { expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TranscriptWriter } from "../src/session/transcript";
import { purgeExpiredSessions } from "../src/session/maintenance";
import { Settings } from "../src/config/settings";
import { workspace } from "./helpers/env";

test("SPEC-CFG-013/CA-01 — forty-day expired transcripts and companion data are removed after thirty days", () => {
  const ws = workspace(), directory = join(ws.configHome, "sessions");
  const writer = new TranscriptWriter({ sessionsDir: directory, projectRealPath: ws.project }); writer.append("session_meta", {}); writer.close();
  mkdirSync(writer.sessionDir); writeFileSync(join(writer.sessionDir, "large-result.txt"), "old result");
  const old = new Date(Date.now() - 40 * 86400000); utimesSync(writer.path, old, old);
  expect(purgeExpiredSessions(directory, 30, Date.now(), new Set()).removed).toEqual([writer.sessionId]);
  expect(existsSync(writer.path)).toBe(false); expect(existsSync(writer.sessionDir)).toBe(false);
});

test("SPEC-CFG-013/CA-02 — an active forty-day session survives another session's cleanup and becomes eligible after close", () => {
  const ws = workspace(), directory = join(ws.configHome, "sessions");
  const writer = new TranscriptWriter({ sessionsDir: directory, projectRealPath: ws.project, active: true }); writer.append("session_meta", {});
  const old = new Date(Date.now() - 40 * 86400000); utimesSync(writer.path, old, old);
  try { expect(purgeExpiredSessions(directory, 30, Date.now(), new Set()).removed).toEqual([]); expect(existsSync(writer.path)).toBe(true); }
  finally { writer.close(); }
  expect(purgeExpiredSessions(directory, 30, Date.now(), new Set()).removed).toEqual([writer.sessionId]);
});

test("SPEC-CFG-013/CA-03 — managed fifteen-day retention prevails over the user's sixty-day setting", () => {
  const settings = Settings.load({ sources: [{ scope: "user", name: "user", text: JSON.stringify({ sessions: { retentionDays: 60 } }) }, { scope: "managed", name: "managed", text: JSON.stringify({ sessions: { retentionDays: 15 } }) }], projectTrusted: true });
  expect(settings.get<number>("sessions.retentionDays")).toBe(15); expect(settings.origin("sessions.retentionDays")).toBe("managed");
});

test("TECH — cleanup refuses traversal-shaped transcript names", () => {
  const ws = workspace(), directory = join(ws.configHome, "sessions"); mkdirSync(join(directory, "project"), { recursive: true });
  const malformed = join(directory, "project", "...jsonl"); writeFileSync(malformed, "{}"); const old = new Date(Date.now() - 40 * 86400000); utimesSync(malformed, old, old);
  expect(purgeExpiredSessions(directory, 30, Date.now(), new Set()).removed).toEqual([]); expect(existsSync(malformed)).toBe(true);
});
