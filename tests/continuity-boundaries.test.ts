import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TranscriptWriter } from "../src/session/transcript";
import { allSessions, searchSessions } from "../src/session/discovery";
import { LoopGuard } from "../src/engine/loop-guard";
import { runFileWorker } from "../src/engine/file-worker";
import { bench } from "./helpers/engine";
import { workspace, cli } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("TECH — a resume-here copy accepts a new id despite the original lease and preserves its warning after another restart", async () => {
  const ws = workspace(), folder = join(ws.configHome, "sessions"), original = new TranscriptWriter({ sessionsDir: folder, projectRealPath: ws.project, active: true }); original.append("session_meta", { formatVersion: 1 }); original.append("user", { content: [{ type: "text", text: "ancien projet" }] }); original.flush();
  const bytes = readFileSync(original.path, "utf8"), project = join(ws.root, "other"); mkdirSync(project); const id = randomUUID();
  try { const copied = await cli(["--non-interactive", `--reopen=${original.sessionId}`, "--reopen-here", `--assign-session-id=${id}`, "suite"], { ...ws, project }, { provider: new ScriptedProvider([{ text: "copié" }]) }); expect(copied.code).toBe(0); expect(readFileSync(original.path, "utf8")).toBe(bytes);
    const p = new ScriptedProvider([{ text: "repris" }]), resumed = await cli(["--non-interactive", `--reopen=${id}`, "encore"], { ...ws, project }, { provider: p }); expect(resumed.code).toBe(0); expect(JSON.stringify(p.requests[0]?.history)).toContain("explicitly resumed a copy");
  } finally { original.close(); }
});
test("TECH — search keeps both projects when their session UUIDs coincide", async () => {
  const ws = workspace(), folder = join(ws.configHome, "sessions"), id = randomUUID();
  for (const project of [ws.project, join(ws.root, "other")]) { const writer = new TranscriptWriter({ sessionsDir: folder, projectRealPath: project, sessionId: id }); writer.append("user", { content: [{ type: "text", text: "pagination" }] }); writer.close(); }
  const result = await searchSessions(allSessions(folder), "pagination", { limit: 40, signal: new AbortController().signal, sample: async text => JSON.stringify([JSON.parse(text).candidates[1].id]) }); expect(result).toHaveLength(2); expect(new Set(result.map(entry => entry.session.path)).size).toBe(2);
});
test("TECH — an explicit source project disambiguates equal UUIDs before a resume-here copy", async () => {
  const ws = workspace(), folder = join(ws.configHome, "sessions"), id = randomUUID(), source = join(ws.root, "source"), project = join(ws.root, "target"); mkdirSync(source); mkdirSync(project);
  for (const [origin, marker] of [[ws.project, "WRONG_CONVERSATION"], [source, "RIGHT_CONVERSATION"]]) { const writer = new TranscriptWriter({ sessionsDir: folder, projectRealPath: origin!, sessionId: id }); writer.append("user", { content: [{ type: "text", text: marker }] }); writer.close(); }
  const p = new ScriptedProvider([{ text: "copied" }]), result = await cli(["--non-interactive", `--reopen=${id}`, `--reopen-project=${source}`, "--reopen-here", "continue"], { ...ws, project }, { provider: p }); expect(result.code).toBe(0); expect(JSON.stringify(p.requests[0]?.history)).toContain("RIGHT_CONVERSATION"); expect(JSON.stringify(p.requests[0]?.history)).not.toContain("WRONG_CONVERSATION");
});
test("TECH — a private read-only worker neither clears nor feeds the caller's loop guard", async () => {
  const guard = new LoopGuard(3), b = bench([{ text: "annexe" }], { executor: { loopGuard: guard } }); guard.check("read_file", { path: "x" }); guard.check("read_file", { path: "x" });
  await runFileWorker({ parent: b.deps, id: "aside", directive: "Answer separately.", model: b.deps.model, owns: () => true, readOnly: true, signal: new AbortController().signal }); expect(guard.check("read_file", { path: "x" }).suspend).toBe(true);
});
test("TECH — replacing and closing an aside prevents late answers from reopening its panel", async () => {
  const p = new ScriptedProvider([{ text: "main", delayMs: 2200 }, { text: "old aside", delayMs: 300 }, { text: "new aside", delayMs: 1200 }]), run = interactive([], workspace(), { provider: p }); await run.idle();
  const send = (text: string) => { run.type(text); run.type(KEY.enter); }; send("long"); while (p.requests.length < 1) await sleep(10); send("/aside first"); while (p.requests.length < 2) await sleep(10); send("/aside second"); while (p.requests.length < 3) await sleep(10); run.type(KEY.escape); await sleep(1500); expect(run.screen().join("\n")).not.toContain("Question annexe"); expect(run.screen().join("\n")).not.toContain("old aside"); await run.idle(); run.type(KEY.ctrlD); run.type(KEY.ctrlD); await run.done;
}, 10000);
