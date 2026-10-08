// Commands of the session (lot 8, increment 1): /clear (SPEC-CMD-009), /duplicate-session (SPEC-CMD-006), /reopen
// (SPEC-CMD-059), /retitle (SPEC-CMD-058), /save-transcript (SPEC-CMD-024), /exit with a background task (SPEC-CMD-023).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectSessions, readTranscript, sessionTitle } from "../src/session/sessions";
import { cli, workspace, type Workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { bunCommand, productEnv } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const sessions = (ws: Workspace) => projectSessions(join(ws.configHome, "sessions"), realpathSync(ws.project));
const send = (run: ReturnType<typeof interactive>, line: string) => {
  run.type(line);
  run.type(KEY.enter);
};
const quit = async (run: ReturnType<typeof interactive>) => {
  await run.idle();
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  return run.done;
};
const history = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history ?? []);

describe("SPEC-CMD-009 /clear and SPEC-CMD-006 /duplicate-session", () => {
  test("SPEC-CMD-009/CA-01 — a conversation in progress and /clear: the context is empty and the old session can still be reopened", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "réponse un" }, { text: "réponse deux" }]);
    const run = interactive(["--approval-mode", "auto_edit"], ws, { provider: p });
    await run.idle();
    send(run, "premier message");
    await run.waitFor((t) => t.includes("réponse un"), "first answer");
    await run.idle();
    send(run, "/clear");
    await sleep(300);
    await run.idle();
    send(run, "second message");
    await run.waitFor((t) => t.includes("réponse deux"), "second answer");
    await run.idle();
    expect(run.screen().join("\n")).toContain("mode : auto_edit"); // the settings of the session are kept
    const r = await quit(run);
    expect(r.code).toBe(0);
    expect(history(p, 1)).toContain("second message");
    expect(history(p, 1)).not.toContain("premier message");
    expect(sessions(ws)).toHaveLength(2);
  }, 30_000);

  test("SPEC-CMD-006/CA-01 — a conversation and /duplicate-session: the new session holds the exchanges, the original stays reopenable", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "réponse A" }, { text: "réponse B" }, { text: "réponse C" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "échange un");
    await run.waitFor((t) => t.includes("réponse A"), "A");
    await run.idle();
    send(run, "échange deux");
    await run.waitFor((t) => t.includes("réponse B"), "B");
    await run.idle();
    send(run, "/duplicate-session variante");
    await sleep(300);
    await run.idle();
    send(run, "dans la copie");
    await run.waitFor((t) => t.includes("réponse C"), "C");
    await quit(run);
    const copied = history(p, 2);
    for (const m of ["échange un", "réponse A", "échange deux", "réponse B", "dans la copie"]) expect(copied).toContain(m);
    const all = sessions(ws);
    expect(all).toHaveLength(2);
    const titles = all.map((s) => sessionTitle(readTranscript(s.path).records));
    expect(titles).toContain("variante");
    const original = all.find((s) => sessionTitle(readTranscript(s.path).records) !== "variante")!;
    expect(JSON.stringify(readTranscript(original.path).records)).not.toContain("dans la copie"); // EF-01
  }, 30_000);
});

describe("SPEC-CMD-059 /reopen", () => {
  test("SPEC-CMD-059/CA-01 — three sessions of the project and one chosen: it is shown again and the conversation goes on", async () => {
    const ws = workspace();
    for (const word of ["alpha", "bravo", "charlie"]) await cli(["--non-interactive", `sujet ${word}`], ws, { provider: new ScriptedProvider([{ text: `vu ${word}` }]) });
    const p = new ScriptedProvider([{ text: "on reprend bravo" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "/reopen");
    await run.waitFor((t) => t.includes("Quelle session reprendre ?"), "choice");
    const row = run.screen().find((l) => l.includes("sujet bravo"))!;
    const n = /(\d)\. sujet bravo/.exec(row)![1]!;
    await sleep(350);
    run.type(n);
    await run.waitFor((t) => t.includes("vu bravo"), "replayed");
    await run.idle();
    send(run, "et donc ?");
    await run.waitFor((t) => t.includes("on reprend bravo"), "continued");
    await quit(run);
    expect(history(p, 0)).toContain("sujet bravo");
    expect(history(p, 0)).toContain("et donc ?");
  }, 30_000);
});

describe("SPEC-CMD-058 /retitle, SPEC-CMD-024 /save-transcript, SPEC-CMD-023 /exit", () => {
  test("SPEC-CMD-058/CA-01 — a manual title: the conversation goes on, the title is not changed automatically", async () => {
    const ws = workspace();
    const h = new Host(ws, { provider: new ScriptedProvider([{ text: "ok" }]), init: {} });
    h.user("/retitle Migration de la base");
    await h.waitFor((m) => m.type === "error" || m.type === "turn_completed" || m.type === "session");
    h.user("commençons la migration");
    await h.waitFor((m) => m.type === "turn_completed");
    h.feed.end();
    await h.finish();
    expect(sessionTitle(readTranscript(sessions(ws)[0]!.path).records)).toBe("Migration de la base");
  });

  test("SPEC-CMD-024/CA-01 — a conversation holding a key, exported: the key is masked in the file", async () => {
    const ws = workspace();
    const h = new Host(ws, { provider: new ScriptedProvider([{ text: "noté" }]), init: {} });
    h.user("ma clé est sk-abcdefghijklmnopqrstuvwxyz123456, garde-la");
    await h.waitFor((m) => m.type === "turn_completed");
    const done = await h.request("invoke_command", { command: "/save-transcript export.txt" });
    h.feed.end();
    await h.finish();
    expect(String((done["result"] as Record<string, unknown>)["shown"])).toContain("Conversation enregistrée");
    const saved = readFileSync(join(ws.project, "export.txt"), "utf8");
    expect(saved).toContain("garde-la");
    expect(saved).toContain("noté");
    expect(saved).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    // EF-02: an existing file is not replaced without a confirmation.
    const again = new Host(ws, { provider: new ScriptedProvider([]), init: {} });
    const refused = await again.request("invoke_command", { command: "/save-transcript export.txt" });
    again.feed.end();
    await again.finish();
    expect(String((refused["result"] as Record<string, unknown>)["refused"])).toContain("Fichier existant, non remplacé");
  });

  test("SPEC-CMD-023/CA-01 — a command in the background and /exit: a confirmation is asked and the command is stopped", async () => {
    const ws = workspace();
    const pidFile = join(ws.root, "pid.txt").replace(/\\/g, "/");
    const server = bunCommand(ws.write("scripts/serveur.ts", `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); await Bun.sleep(60_000);`).replace(/\\/g, "/"));
    const p = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: server, detached: true } }] }, { text: "lancé" }]);
    const run = interactive(["--allow-rule", "run_shell"], ws, { provider: p, env: productEnv(ws) });
    await run.idle();
    send(run, "lance le serveur");
    await run.waitFor((t) => t.includes("lancé"), "started");
    while (!existsSync(pidFile)) await sleep(50);
    await run.idle();
    send(run, "/exit");
    await run.waitFor((t) => t.includes("1 tâche de fond sera arrêtée"), "confirmation");
    await sleep(350);
    run.type("o");
    const r = await run.done;
    expect(r.code).toBe(0);
    await sleep(500);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(() => process.kill(pid, 0)).toThrow();
  }, 30_000);
});
