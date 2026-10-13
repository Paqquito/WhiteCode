import { expect, test } from "bun:test";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { TranscriptWriter } from "../src/session/transcript";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { renderSessionStatistics } from "../src/session/statistics";

test("TECH — rounded statistics preserve one hundred percent and empty bins remain zero", () => {
  const report = renderSessionStatistics({ days: new Map(), attempts: [1, 2, 6, 7, 8, 9], sessions: 6, userMessages: 33 });
  expect(report).toContain("11 et plus : 0 sessions (0 %)");
  expect([...report.matchAll(/\((\d+) %\)/g)].reduce((sum, match) => sum + Number(match[1]), 0)).toBe(100);
});

test("SPEC-IHM-030/CA-01 — the real statistics command displays activity dates in all three months", async () => {
  const ws = workspace();
  for (const ts of ["2026-07-04T12:00:00Z", "2026-08-09T12:00:00Z", "2026-09-13T12:00:00Z"]) {
    const writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project, clock: () => new Date(ts) });
    writer.append("session_meta", {}); writer.append("user", { content: [{ type: "text", text: "PRIVATE_STATISTICS_WITNESS" }] }); writer.close();
  }
  const provider = new ScriptedProvider([]); const r = await cli(["--non-interactive", "/stats"], ws, { provider });
  expect(r.code).toBe(0); expect(r.stdout).toContain("Calendrier 2026-07"); expect(r.stdout).toContain("04:1");
  expect(r.stdout).toContain("Calendrier 2026-08"); expect(r.stdout).toContain("09:1"); expect(r.stdout).toContain("Calendrier 2026-09"); expect(r.stdout).toContain("13:1");
  expect(r.stdout).not.toContain("PRIVATE_STATISTICS_WITNESS"); expect(provider.requests).toHaveLength(0);
});

test("SPEC-IHM-031/CA-01 — ten sessions with four single attempts display forty percent in the single-attempt bin", async () => {
  const ws = workspace();
  for (let n = 0; n < 10; n++) {
    const writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project }); writer.append("session_meta", {});
    for (let attempt = 0; attempt < (n < 4 ? 1 : 3); attempt++) writer.append("user", { content: [{ type: "text", text: "attempt" }] });
    writer.close();
  }
  const r = await cli(["--non-interactive", "/stats"], ws, { provider: new ScriptedProvider([]) });
  expect(r.code).toBe(0); expect(r.stdout).toContain("1 : 4 sessions (40 %)"); expect(r.stdout).toContain("2 à 5 : 6 sessions (60 %)"); expect(r.stdout).toContain("10 sessions, 22 tentatives");
});

test("SPEC-CMD-066/CA-01 — a loading indicator appears in the terminal before the statistics result", async () => {
  const ws = workspace(); const controller = new AbortController(); const run = interactive([], ws, { provider: new ScriptedProvider([]), signal: controller.signal });
  try { await run.idle(); run.type("/stats"); run.type(KEY.enter); await run.waitFor(text => text.includes("Calcul des statistiques locales")); await run.waitFor(text => text.includes("Aucune session avec échange")); }
  finally { controller.abort(); await run.done; }
});
