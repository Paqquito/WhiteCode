import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { TranscriptWriter } from "../src/session/transcript";
import { readTranscript, sessionTitle } from "../src/session/sessions";
import { allSessions, searchSessions, reindexSessions } from "../src/session/discovery";
import { workspace } from "./helpers/env";

const seed = (folder: string, project: string, message: string) => { const writer = new TranscriptWriter({ sessionsDir: folder, projectRealPath: project }); writer.append("session_meta", { formatVersion: 1, cwd: project }); writer.append("user", { content: [{ type: "text", text: message }] }); writer.close(); return writer; };
test("SPEC-SES-010/CA-01 — pagination is ranked in the first three of one hundred sessions using only short candidate summaries", async () => {
  const ws = workspace(), folder = join(ws.configHome, "sessions");
  for (let i = 0; i < 99; i++) seed(folder, ws.project, `Autre sujet ${i}`);
  const found = seed(folder, ws.project, "Nous avons corrigé la pagination des résultats"); let payload = "";
  const result = await searchSessions(allSessions(folder), "quand on a corrigé la pagination", { limit: 40, signal: new AbortController().signal, sample: async text => { payload = text; return JSON.stringify([found.sessionId, "invented"]); } });
  expect(result.slice(0, 3).map(entry => entry.session.id)).toContain(found.sessionId); expect(payload.length).toBeLessThan(32000); expect(payload).not.toContain('"records"');
});
test("SPEC-SES-010/CA-02 — failed network and disabled optional traffic preserve the full-text ranking", async () => {
  const ws = workspace(), folder = join(ws.configHome, "sessions"), wanted = seed(folder, ws.project, "pagination défectueuse"); seed(folder, ws.project, "autre sujet");
  const result = await searchSessions(allSessions(folder), "pagination", { limit: 40, signal: new AbortController().signal, sample: async () => { throw new Error("offline"); } });
  expect(result[0]?.session.id).toBe(wanted.sessionId);
  expect((await searchSessions(allSessions(folder), "pagination", { limit: 40, signal: new AbortController().signal }))[0]?.session.id).toBe(wanted.sessionId);
});
test("SPEC-CMD-082/CA-01 — one hundred untitled sessions gain titles and an interrupted reindex resumes without changing content", async () => {
  const ws = workspace(), folder = join(ws.configHome, "sessions"), files = Array.from({ length: 100 }, (_, i) => seed(folder, ws.project, `Sujet ${i}`));
  const original = files.map(file => readFileSync(file.path, "utf8")), abort = new AbortController(); let done = 0;
  await expect(reindexSessions(allSessions(folder), abort.signal, () => { if (++done === 11) abort.abort(); })).rejects.toThrow();
  await reindexSessions(allSessions(folder), new AbortController().signal);
  for (const [i, file] of files.entries()) { const records = readTranscript(file.path).records; expect(sessionTitle(records)).toBe(`Sujet ${i}`); expect(readFileSync(file.path, "utf8").startsWith(original[i]!)).toBe(true); }
});
