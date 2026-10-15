// Reopening, copying and branching sessions, concurrent sessions, sessions without persistence and recovery of an
// interrupted conversation (SPEC-SES-002 to SPEC-SES-004, SPEC-SES-011, SPEC-SES-012, SPEC-SES-015, SPEC-MOT-001 CA-08).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HistoryMessage } from "../src/providers/types";
import { INTERRUPTED_RESULT } from "../src/session/sessions";
import { projectKey, TranscriptWriter, type TranscriptRecord } from "../src/session/transcript";
import { cli, workspace, type Workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { liveSession } from "./helpers/live-session";

const sessionsDir = (ws: Workspace) => join(ws.configHome, "sessions");
const transcriptPath = (ws: Workspace, id: string) => join(sessionsDir(ws), projectKey(realpathSync(ws.project)), `${id}.jsonl`);
const records = (ws: Workspace, id: string): TranscriptRecord[] =>
  readFileSync(transcriptPath(ws, id), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as TranscriptRecord);
const texts = (history: readonly HistoryMessage[]) =>
  history.flatMap((m) => (m.role === "user" ? m.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : m.role === "assistant" ? [m.text] : []));

async function session(ws: Workspace, prompt: string, answer: string, args: string[] = []): Promise<string> {
  const r = await cli(["--non-interactive", "--result-format", "json", ...args, prompt], ws, { provider: new ScriptedProvider([{ text: answer }]) });
  expect(r.code).toBe(0);
  return JSON.parse(r.stdout).sessionId as string;
}

describe("SPEC-SES-002 reopening a session", () => {
  test("SPEC-SES-002/CA-01 — two sessions in the folder: --reopen-last reopens the most recent", async () => {
    const ws = workspace();
    const old = await session(ws, "first topic", "answer one");
    const recent = await session(ws, "second topic", "answer two");
    const t = Date.now() / 1000;
    utimesSync(transcriptPath(ws, old), t - 60, t - 60);
    const provider = new ScriptedProvider([{ text: "go on" }]);
    const r = await cli(["--non-interactive", "--result-format", "json", "--reopen-last", "and now?"], ws, { provider });
    expect(JSON.parse(r.stdout).sessionId).toBe(recent);
    expect(texts(provider.requests[0]!.history)).toEqual(["second topic", "answer two", "and now?"]);
  });

  test("SPEC-SES-002/CA-02 — a session named refonte-api: --reopen refonte-api reopens it", async () => {
    const ws = workspace();
    const id = await session(ws, "refonte-api", "noted");
    await session(ws, "something else", "ok");
    const provider = new ScriptedProvider([{ text: "resumed" }]);
    const r = await cli(["--non-interactive", "--result-format", "json", "--reopen=refonte-api", "next"], ws, { provider });
    expect(JSON.parse(r.stdout).sessionId).toBe(id);
  });

  test("SPEC-SES-002/CA-03 — SPEC-SES-002/CA-05 — --reopen <id> --non-interactive: the model sees all the previous history; the prompt runs and the output is printed", async () => {
    const ws = workspace();
    const id = await session(ws, "my name is Ada", "Hello Ada");
    const provider = new ScriptedProvider([{ text: "Your name is Ada." }]);
    const r = await cli(["--non-interactive", `--reopen=${id}`, "what is my name?"], ws, { provider });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Your name is Ada.\n");
    expect(texts(provider.requests[0]!.history)).toEqual(["my name is Ada", "Hello Ada", "what is my name?"]);
    // RG-01: the existing records are untouched; the new ones are appended to the same transcript.
    const all = records(ws, id);
    expect(all.filter((r) => r.type === "session_meta")).toHaveLength(1);
    expect(all.some((r) => r.type === "system" && r.data["event"] === "reopened")).toBe(true);
    expect(all.filter((r) => r.type === "assistant")).toHaveLength(2);
  });

  test("SPEC-SES-002/CA-04 — a session recorded in auto_edit: it is reopened in the default mode", async () => {
    const ws = workspace();
    const id = await session(ws, "edit things", "done", ["--approval-mode", "auto_edit"]);
    expect(records(ws, id)[0]!.data["permissionMode"]).toBe("auto_edit");
    await cli(["--non-interactive", `--reopen=${id}`, "more"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    const reopened = records(ws, id).find((r) => r.type === "system" && r.data["event"] === "reopened")!;
    expect(reopened.data["permissionMode"]).not.toBe("auto_edit");
  });

  test("TECH — SPEC-SES-002/ERR-01, ERR-02, FA-01 — nothing to reopen, unknown session, no picker without a terminal", async () => {
    const ws = workspace();
    const none = await cli(["--non-interactive", "--reopen-last", "x"], ws, { provider: new ScriptedProvider([{ text: "fresh" }]) });
    expect(none.code).toBe(0);
    expect(none.stderr).toContain("Aucune conversation à reprendre ici : nouvelle session.");
    const unknown = await cli(["--non-interactive", "--reopen=nope", "x"], ws, { provider: new ScriptedProvider([]) });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Session introuvable : nope.");
    const bare = await cli(["--non-interactive", "--reopen", "--", "x"], ws, { provider: new ScriptedProvider([]) });
    expect(bare.code).toBe(2);
  });

  test("TECH — SPEC-SES-005 — a session of another folder is reopened only from its own folder", async () => {
    const ws = workspace();
    const id = await session(ws, "elsewhere", "ok");
    const other = join(ws.root, "other-project");
    mkdirSync(join(other, ".pilote-dev"), { recursive: true });
    const r = await cli(["--non-interactive", `--reopen=${id}`, "--cwd", other, "x"], ws, { provider: new ScriptedProvider([]), extra: { cwd: other } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Cette session appartient au dossier");
  });
});

describe("SPEC-SES-003 copy on reopening", () => {
  test("SPEC-SES-003/CA-01 — --reopen A --reopen-as-copy: A is unchanged, B holds the history of A and the new exchanges", async () => {
    const ws = workspace();
    const a = await session(ws, "original question", "original answer");
    const before = readFileSync(transcriptPath(ws, a), "utf8");
    const provider = new ScriptedProvider([{ text: "copy answer" }]);
    const r = await cli(["--non-interactive", "--result-format", "json", `--reopen=${a}`, "--reopen-as-copy", "copy question"], ws, { provider });
    const b = JSON.parse(r.stdout).sessionId as string;
    expect(b).not.toBe(a);
    expect(readFileSync(transcriptPath(ws, a), "utf8")).toBe(before); // EF-01
    const copy = records(ws, b);
    expect(copy[0]!.data["parentSession"]).toBe(a); // EF-02
    const said = copy.flatMap((r) => (r.type === "user" ? [(r.data["content"] as Array<{ text: string }>)[0]!.text] : r.type === "assistant" ? [r.data["text"] as string] : []));
    expect(said).toEqual(["original question", "original answer", "copy question", "copy answer"]);
  });

  test("SPEC-SES-003/CA-02 — --reopen-as-copy alone: ERR-01", async () => {
    const r = await cli(["--non-interactive", "--reopen-as-copy", "x"], workspace(), { provider: new ScriptedProvider([]) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("--reopen-as-copy s'utilise avec --reopen ou --reopen-last.");
  });

  test("TECH — SPEC-SES-003/ERR-02 — --assign-session-id: a free identifier is used, an existing one is refused", async () => {
    const ws = workspace();
    const id = "0a1b2c3d-1111-4222-8333-444455556666";
    expect(await session(ws, "hello", "hi", ["--assign-session-id", id])).toBe(id);
    const again = await cli(["--non-interactive", "--assign-session-id", id, "x"], ws, { provider: new ScriptedProvider([]) });
    expect(again.code).toBe(2);
    expect(again.stderr).toContain("Cet identifiant de session existe déjà.");
    const invalid = await cli(["--non-interactive", "--assign-session-id", "my-id", "x"], ws, { provider: new ScriptedProvider([]) });
    expect(invalid.stderr).toContain("Identifiant de session invalide");
  });
});

describe("SPEC-SES-004 reopening at a message", () => {
  test("SPEC-SES-004/CA-01 — SPEC-SES-004/CA-02 — reopened at the 4th answer the model sees 4 exchanges; reopened normally afterwards, the last branch used goes on", async () => {
    const ws = workspace();
    const stdin = Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: "user", content: `question ${i + 1}` })).join("\n") + "\n";
    const provider = new ScriptedProvider(Array.from({ length: 10 }, (_, i) => ({ text: `answer ${i + 1}` })));
    const r = await cli(["--non-interactive", "--request-format", "jsonl", "--result-format", "json"], ws, { provider, stdin });
    const id = JSON.parse(r.stdout).sessionId as string;
    const fourth = records(ws, id).filter((x) => x.type === "assistant")[3]!;
    const branch = new ScriptedProvider([{ text: "branch answer" }]);
    expect((await cli(["--non-interactive", `--reopen=${id}`, "--reopen-at", fourth.id, "branch question"], ws, { provider: branch })).code).toBe(0);
    expect(texts(branch.requests[0]!.history)).toEqual(["question 1", "answer 1", "question 2", "answer 2", "question 3", "answer 3", "question 4", "answer 4", "branch question"]);
    // EF-02: the later records are kept.
    expect(records(ws, id).filter((x) => x.type === "assistant").map((x) => x.data["text"])).toContain("answer 10");
    const later = new ScriptedProvider([{ text: "ok" }]);
    await cli(["--non-interactive", `--reopen=${id}`, "and then?"], ws, { provider: later });
    expect(texts(later.requests[0]!.history).slice(-3)).toEqual(["branch question", "branch answer", "and then?"]);
  });

  test("TECH — SPEC-SES-004/ERR-01 to ERR-03 — unknown message, message of the user, --reopen-at without --reopen", async () => {
    const ws = workspace();
    const id = await session(ws, "q", "a");
    const user = records(ws, id).find((x) => x.type === "user")!;
    const missing = await cli(["--non-interactive", `--reopen=${id}`, "--reopen-at", "nope", "x"], ws, { provider: new ScriptedProvider([]) });
    expect(missing.stderr).toContain("Message introuvable dans cette session.");
    const notModel = await cli(["--non-interactive", `--reopen=${id}`, "--reopen-at", user.id, "x"], ws, { provider: new ScriptedProvider([]) });
    expect(notModel.stderr).toContain("Indiquez un message du modèle.");
    const alone = await cli(["--non-interactive", "--reopen-at", user.id, "x"], ws, { provider: new ScriptedProvider([]) });
    expect(alone.stderr).toContain("--reopen-at nécessite --reopen.");
  });
});

describe("SPEC-SES-011 concurrent sessions", () => {
  const presence = (ws: Workspace, sessionId: string, cwd: string, ageMs: number) => {
    mkdirSync(join(ws.configHome, "presence"), { recursive: true });
    const path = join(ws.configHome, "presence", `${sessionId}.json`);
    writeFileSync(path, JSON.stringify({ sessionId, pid: 999_999, cwd, heartbeat: new Date(Date.now() - ageMs).toISOString() }));
    return path;
  };

  test("SPEC-SES-011/CA-01 — a session active in the folder: a second one warns and suggests an isolated working copy", async () => {
    const ws = workspace();
    const id = await session(ws, "first", "ready"), live = await liveSession(ws, id);
    try {
    const r = await cli(["--non-interactive", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("une autre session est active dans ce dossier");
    expect(r.stderr).toContain("copie de travail isolée");
    expect(readdirSync(join(ws.configHome, "presence"))).toEqual([id+".json"]); // own presence withdrawn at exit
    } finally { await live.close(); }
  });

  test("SPEC-SES-011/CA-02 — a session already open elsewhere: reopening it is refused with ERR-01, a copy is possible", async () => {
    const ws = workspace();
    const id = await session(ws, "q", "a");
    const live = await liveSession(ws, id);
    try {
    const r = await cli(["--non-interactive", `--reopen=${id}`, "x"], ws, { provider: new ScriptedProvider([]) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Cette conversation est déjà ouverte dans une autre fenêtre");
    const copy = await cli(["--non-interactive", `--reopen=${id}`, "--reopen-as-copy", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(copy.code).toBe(0);
    } finally { await live.close(); }
  });

  test("SPEC-SES-011/CA-03 — a session killed long ago: its presence is purged without warning", async () => {
    const ws = workspace();
    const dead = presence(ws, "22222222-2222-4222-8222-222222222222", realpathSync(ws.project), 120_000);
    const r = await cli(["--non-interactive", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(r.stderr).not.toContain("une autre session est active");
    expect(existsSync(dead)).toBe(false);
  });
});

describe("SPEC-SES-012 sessions without persistence", () => {
  test("SPEC-SES-012/CA-01 — --non-interactive --ephemeral: no session file is created in the configuration folder", async () => {
    const ws = workspace();
    const before = readdirSync(ws.configHome);
    const r = await cli(["--non-interactive", "--ephemeral", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(r.code).toBe(0);
    // The user settings file is written by the test helper itself; nothing else may appear.
    expect(readdirSync(ws.configHome).filter((n) => !before.includes(n) && n !== "config.json")).toEqual([]);
    expect(existsSync(join(ws.configHome, "sessions"))).toBe(false);
  });

  test("SPEC-SES-012/CA-02 — the option in an interactive launch: ERR-01; with a reopening: ERR-02", async () => {
    const ws = workspace();
    const interactive = await cli(["--ephemeral", "x"], ws, { provider: new ScriptedProvider([]), tty: true });
    expect(interactive.code).toBe(2);
    expect(interactive.stderr).toContain("Cette option n'est disponible qu'en mode non interactif");
    const reopen = await cli(["--non-interactive", "--ephemeral", "--reopen-last", "x"], ws, { provider: new ScriptedProvider([]) });
    expect(reopen.stderr).toContain("Impossible de reprendre une session sans persistance.");
  });
});

describe("SPEC-SES-015 recovery of an interrupted conversation", () => {
  for (const accepted of [true, false]) test("SPEC-SES-015/CA-02 — an unanswered user message is proposed for relaunch and waits for the human choice", async () => {
    const ws = workspace();
    const writer = new TranscriptWriter({ sessionsDir: sessionsDir(ws), projectRealPath: realpathSync(ws.project) });
    writer.append("session_meta", { formatVersion: 1, cwd: realpathSync(ws.project), provider: "openai_compatible", model: "test-medium", permissionMode: "ask" });
    writer.append("user", { content: [{ type: "text", text: "/clear @a.txt RECOVER THIS MESSAGE" }] });
    ws.write("project/a.txt", "ATTACHMENT MUST NOT BE READ ON RELAUNCH");
    writer.close();
    const provider = new ScriptedProvider([{ text: "Recovered answer." }]);
    mkdirSync(writer.sessionDir, { recursive: true });
    writeFileSync(join(writer.sessionDir, "input-state.json"), JSON.stringify({ draft: "", queue: ["QUEUED MESSAGE MUST STAY"], stash: [] }));
    const run = interactive([`--reopen=${writer.sessionId}`], ws, { provider });
    await run.waitFor((text) => text.includes("Relancer le dernier message resté sans réponse ?"));
    expect(provider.requests).toHaveLength(0);
    await sleep(370); run.type(accepted ? "o" : "n");
    if (accepted) await run.waitFor((text) => text.includes("Recovered answer."));
    else await run.idle();
    await sleep(200);
    expect(provider.requests).toHaveLength(accepted ? 1 : 0);
    expect(run.all().join("\n")).toContain("1 message en attente");
    if (accepted) {
      const history = JSON.stringify(provider.requests[0]?.history);
      expect(history).toContain("/clear @a.txt RECOVER THIS MESSAGE");
      expect(history).not.toContain("ATTACHMENT MUST NOT BE READ ON RELAUNCH");
    }
    run.type(KEY.altX);
    run.type(KEY.ctrlD); run.type(KEY.ctrlD);
    expect((await run.done).code).toBe(0);
  }, 12000);
  test("SPEC-SES-015/CA-01 — SPEC-MOT-001/CA-08 — a transcript ending with a call without result: the call gets a synthetic result and the next request is valid", async () => {
    const ws = workspace();
    const file = ws.write("project/a.txt", "a\n");
    const writer = new TranscriptWriter({ sessionsDir: sessionsDir(ws), projectRealPath: realpathSync(ws.project) });
    writer.append("session_meta", { formatVersion: 1, cwd: realpathSync(ws.project), provider: "openai_compatible", model: "test-medium", permissionMode: "ask" });
    writer.append("user", { content: [{ type: "text", text: "read a.txt" }] });
    writer.append("assistant", { provider: "simulated", content: {}, text: "", toolCalls: [{ callId: "c1", name: "read_file", input: { path: file } }] });
    writer.close(); // the process stopped while the tool ran
    const provider = new ScriptedProvider([{ text: "resumed" }]);
    const r = await cli(["--non-interactive", `--reopen=${writer.sessionId}`, "go on"], ws, { provider });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("interrompue pendant l'exécution d'outils");
    const history = provider.requests[0]!.history;
    const results = history.flatMap((m) => (m.role === "user" ? m.parts.filter((p) => p.type === "tool_result") : []));
    expect(results).toEqual([{ type: "tool_result", callId: "c1", isError: true, content: [{ type: "text", text: INTERRUPTED_RESULT }] }]);
    expect(history.some((m) => m.role === "system_note" && m.text.includes("may have been partly carried out"))).toBe(true); // EF-03
    // EF-02: the repair is appended, never written in place.
    expect(records(ws, writer.sessionId).some((x) => x.type === "tool_result" && x.data["synthetic"] === true)).toBe(true);
  });
});
