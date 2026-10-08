// The history of the files within the session (lot 8, increment 4): /turn-changes (SPEC-CMD-021) and /restore
// (SPEC-CMD-061), on the snapshots of SPEC-SES-006.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace, type Workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider, type ScriptedResponse } from "./helpers/scripted-provider";

const write = (ws: Workspace, name: string, content: string) => ({ name: "write_file", input: { path: join(ws.project, name), content } });
const readTool = (ws: Workspace, name: string) => ({ name: "read_file", input: { path: join(ws.project, name) } });
const read = (ws: Workspace, name: string) => readFileSync(join(ws.project, name), "utf8");
type Run = ReturnType<typeof interactive>;
const turn = async (run: Run, message: string, answer: string) => {
  run.type(message);
  run.type(KEY.enter);
  await run.waitFor((t) => t.includes(answer), answer);
  await run.idle();
};
const command = (run: Run, line: string) => {
  run.type(line);
  run.type(KEY.enter);
};
const answer = async (run: Run, key: string) => {
  await sleep(350); // the guard of the dialogs
  run.type(key);
};
const quit = async (run: Run) => {
  await run.idle();
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  await run.done;
};

describe("SPEC-CMD-021 /turn-changes", () => {
  test("SPEC-CMD-021/CA-01 — three turns that changed files: each turn shows its own changes", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([
      { toolCalls: [write(ws, "a.txt", "un\n")] }, { text: "t1" },
      { toolCalls: [write(ws, "a.txt", "deux\n")] }, { text: "t2" },
      { toolCalls: [write(ws, "b.txt", "trois\n")] }, { text: "t3" },
    ]);
    const h = new Host(ws, { provider: p, init: {}, argv: ["--allow-rule", "write_file"] });
    for (const [message, done] of [["premier", "t1"], ["deuxième", "t2"], ["troisième", "t3"]] as const) {
      h.user(message);
      await h.waitFor((m) => m.type === "turn_completed" && JSON.stringify(m).includes(done));
    }
    const r = await h.request("invoke_command", { command: "/turn-changes" });
    h.feed.end();
    await h.finish();
    const out = String((r["result"] as Record<string, unknown>)["note"] ?? JSON.stringify(r));
    const [, t1, t2, t3] = out.split(/Tour \d — /);
    expect(t1).toContain("« premier »");
    expect(t1).toContain("créé : a.txt");
    expect(t1).toContain("+un");
    expect(t2).toContain("modifié : a.txt");
    expect(t2).toMatch(/-un[\s\S]*\+deux/);
    expect(t2).not.toContain("b.txt");
    expect(t3).toContain("créé : b.txt");
    expect(t3).not.toContain("a.txt");
  }, 30_000);
});

describe("SPEC-CMD-061 /restore", () => {
  test("SPEC-CMD-061/CA-01 — three turns of changes, back to the first message, scope « code »: the files are as before the first turn", async () => {
    const ws = workspace();
    ws.write("project/x.txt", "origine\n");
    const steps: ScriptedResponse[] = [
      { toolCalls: [write(ws, "a.txt", "1\n")] }, { text: "t1" },
      { toolCalls: [readTool(ws, "x.txt")] },
      { toolCalls: [write(ws, "a.txt", "2\n"), write(ws, "x.txt", "changé\n")] }, { text: "t2" },
      { toolCalls: [write(ws, "c.txt", "3\n")] }, { text: "t3" },
    ];
    const run = interactive(["--allow-rule", "write_file"], ws, { provider: new ScriptedProvider(steps) });
    await run.idle();
    await turn(run, "premier", "t1");
    await turn(run, "deuxième", "t2");
    await turn(run, "troisième", "t3");
    expect(read(ws, "x.txt")).toBe("changé\n");
    command(run, "/restore 1 code");
    await run.waitFor((t) => t.includes("Restaurer les fichiers selon ce plan ?"), "preview");
    expect(run.all().join("\n")).toContain("Opérations prévues");
    await answer(run, "o");
    await run.waitFor((t) => t.includes("Restaurés :"), "restored");
    expect(existsSync(join(ws.project, "a.txt"))).toBe(false);
    expect(existsSync(join(ws.project, "c.txt"))).toBe(false);
    expect(read(ws, "x.txt")).toBe("origine\n");
    await quit(run);
  }, 30_000);

  test("SPEC-CMD-061/CA-02 — a file changed by hand after the point, mode unrestricted: a confirmation of the conflict is asked despite the mode", async () => {
    const ws = workspace();
    ws.write("project/x.txt", "origine\n");
    const steps: ScriptedResponse[] = [{ toolCalls: [readTool(ws, "x.txt")] }, { toolCalls: [write(ws, "x.txt", "agent\n")] }, { text: "t1" }];
    const run = interactive(["--approval-mode", "unrestricted", "--allow-unrestricted-mode"], ws, { provider: new ScriptedProvider(steps) });
    await run.waitFor((t) => t.includes("Activer ce mode ?"), "warning of the mode");
    await answer(run, "o");
    await run.idle();
    await turn(run, "modifie", "t1");
    writeFileSync(join(ws.project, "x.txt"), "à la main\n");
    command(run, "/restore 1");
    await run.waitFor((t) => t.includes("Restaurer les fichiers selon ce plan ?"), "preview");
    await answer(run, "o");
    await run.waitFor((t) => t.includes("Confirmer pour ces conflits ?"), "conflict");
    const screen = run.all().join("\n");
    expect(screen).toContain("x.txt (modifié hors de l'agent)");
    expect(screen).toMatch(/-à la main[\s\S]*\+origine/);
    expect(read(ws, "x.txt")).toBe("à la main\n"); // nothing written before this consent
    await answer(run, "o");
    await run.waitFor((t) => t.includes("Restaurés :"), "restored");
    expect(read(ws, "x.txt")).toBe("origine\n");
    await quit(run);
  }, 30_000);

  test("SPEC-CMD-061/CA-03 — a file changed between the preview and the confirmation: a new preview instead of the old plan", async () => {
    const ws = workspace();
    ws.write("project/x.txt", "origine\n");
    const steps: ScriptedResponse[] = [{ toolCalls: [readTool(ws, "x.txt")] }, { toolCalls: [write(ws, "x.txt", "agent\n")] }, { text: "t1" }];
    const run = interactive(["--allow-rule", "write_file"], ws, { provider: new ScriptedProvider(steps) });
    await run.idle();
    await turn(run, "modifie", "t1");
    command(run, "/restore 1");
    await run.waitFor((t) => t.includes("Restaurer les fichiers selon ce plan ?"), "preview");
    writeFileSync(join(ws.project, "x.txt"), "entre-temps\n");
    await answer(run, "o");
    await run.waitFor((t) => t.includes("Les fichiers ont changé depuis l'aperçu"), "new preview");
    await run.waitFor((t) => t.includes("Restaurer les fichiers selon ce plan ?"), "asked again");
    expect(run.all().join("\n")).toContain("Conflits externes");
    expect(read(ws, "x.txt")).toBe("entre-temps\n");
    await answer(run, "n");
    await run.waitFor((t) => t.includes("Restauration abandonnée"), "cancelled");
    expect(read(ws, "x.txt")).toBe("entre-temps\n");
    await quit(run);
  }, 30_000);
});
