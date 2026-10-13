import { expect, test } from "bun:test";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { projectSessions, readTranscript, sessionLabels } from "../src/session/sessions";
import { TranscriptWriter } from "../src/session/transcript";

test("SPEC-SES-009/CA-01 — a normalized label is appended and survives reopening", async () => {
  const ws = workspace();
  const r = await cli(["--non-interactive", "/label-session Client A"], ws);
  expect(r.code).toBe(0); expect(r.stdout).toContain("#client-a ajoutée");
  const info = projectSessions(join(ws.configHome, "sessions"), ws.project)[0]!;
  expect(sessionLabels(readTranscript(info.path).records)).toEqual(["client-a"]);
  const reopened = await cli(["--non-interactive", `--reopen=${info.id}`, "/label-session"], ws);
  expect(reopened.code).toBe(0); expect(reopened.stdout).toContain("#client-a");
});

test("SPEC-SES-009/CA-02 — SPEC-CMD-069/CA-01 — repeating a label removes it without deleting the other labels", async () => {
  const ws = workspace(); const writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project });
  writer.append("session_meta", { labels: ["client-a", "other"] }); writer.close();
  const r = await cli(["--non-interactive", `--reopen=${writer.sessionId}`, "/label-session Client A"], ws);
  expect(r.code).toBe(0); expect(r.stdout).toContain("#client-a retirée");
  expect(sessionLabels(readTranscript(writer.path).records)).toEqual(["other"]);
});

test("SPEC-SES-009/CA-03 — typing a label in the real session selector hides unmatched sessions", async () => {
  const ws = workspace();
  for (const [title, labels] of [["Chosen_session", ["client-a"]], ["Hidden_session", ["other"]]] as const) {
    const writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project });
    writer.append("session_meta", { labels }); writer.append("system", { event: "title", title }); writer.close();
  }
  const controller = new AbortController(); const provider = new ScriptedProvider([]);
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("/reopen"); run.type(KEY.enter); await run.waitFor(text => text.includes("Quelle session reprendre"));
    await new Promise(resolve => setTimeout(resolve, 380)); run.type("#client-a");
    await run.waitFor(() => run.screen().join("\n").includes("Filtre : #client-a"));
    expect(run.screen().join("\n")).toContain("Chosen_session"); expect(run.screen().join("\n")).not.toContain("Hidden_session");
    run.type(KEY.enter); run.type(KEY.escape); await run.idle();
    expect(provider.requests).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
});

test("TECH — label validation preserves existing metadata and refuses the twenty-first label", async () => {
  const ws = workspace(); const writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project });
  const labels = Array.from({ length: 20 }, (_, n) => `label-${n}`); writer.append("session_meta", { labels }); writer.close();
  for (const label of ["bad/label", "x".repeat(33), "extra"]) {
    const r = await cli(["--non-interactive", `--reopen=${writer.sessionId}`, `/label-session ${label}`], ws);
    expect(r.stdout + r.stderr).toMatch(/invalide|au plus 20/); expect(sessionLabels(readTranscript(writer.path).records)).toEqual(labels);
  }
});
