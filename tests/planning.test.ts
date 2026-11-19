// Planning mode and plan approval (SPEC-OUT-024, SPEC-PER-003 CA-04, SPEC-MOT-007 CA-03), questions to the user
// (SPEC-OUT-033), in the interface and through a control host.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest } from "../src/providers/types";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const call = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ name, input }] });
const results = (r: ModelRequest | undefined) => JSON.stringify([...(r?.history ?? [])].reverse().find((m) => m.role === "user") ?? null);
const all = (r: ModelRequest | undefined) => JSON.stringify(r?.history ?? []);
const send = (run: ReturnType<typeof interactive>, line: string) => {
  run.type(line);
  run.type(KEY.enter);
};
const quit = async (run: ReturnType<typeof interactive>) => {
  await run.idle();
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  await run.done;
};

describe("SPEC-OUT-024 planning", () => {
  test("SPEC-OUT-024/CA-01 — the planning mode: writing a file of the project is refused", async () => {
    const ws = workspace();
    const target = join(ws.project, "a.txt");
    const p = new ScriptedProvider([call("write_file", { path: target, content: "x" }), { text: "fini" }]);
    await cli(["--non-interactive", "--approval-mode", "planning", "--allow-rule", "write_file", "go"], ws, { provider: p });
    expect(existsSync(target)).toBe(false);
    expect(results(p.requests[1])).toContain("denied");
  });

  test("SPEC-OUT-024/CA-02 — SPEC-PER-003/CA-04 — a plan edited then approved with auto_edit: the model gets the edited version, writes go without asking", async () => {
    const ws = workspace();
    const target = join(ws.project, "fait.txt");
    const p = new ScriptedProvider([call("submit_plan", { plan_text: "plan initial" }), call("write_file", { path: target, content: "x" }), { text: "terminé" }]);
    const run = interactive(["--approval-mode", "planning"], ws, { provider: p });
    await run.idle();
    send(run, "planifie");
    await run.waitFor((t) => t.includes("Que faire de ce plan ?"), "plan decision");
    await sleep(350);
    run.type("3"); // edit
    await run.waitFor((t) => t.includes("Plan modifié"), "edition");
    run.type(KEY.ctrlU);
    send(run, "plan revu par moi");
    await run.waitFor((t) => t.includes("Reprendre dans quel mode ?"), "resume mode");
    await sleep(350);
    run.type("2"); // auto_edit (ask is the default, listed first)
    await run.waitFor((t) => t.includes("terminé"), "end of the turn");
    expect(results(p.requests[1])).toContain("plan revu par moi");
    expect(results(p.requests[1])).toContain("The permission mode is now auto_edit");
    expect(existsSync(target)).toBe(true); // no confirmation asked
    await quit(run);
  });

  test("SPEC-OUT-024/CA-03 — a plan rejected with a comment: the mode stays planning and the comment is given", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([call("submit_plan", { plan_text: "plan" }), call("submit_plan", { plan_text: "plan" }), { text: "je revois" }]);
    const run = interactive(["--approval-mode", "planning"], ws, { provider: p });
    await run.idle();
    send(run, "planifie");
    await run.waitFor((t) => t.includes("Que faire de ce plan ?"), "plan decision");
    await sleep(350);
    run.type("4");
    await run.waitFor((t) => t.includes("Commentaire pour le modèle"), "comment");
    send(run, "trop risqué, découpe en deux");
    await run.waitFor((t) => (t.match(/Que faire de ce plan \?/g) ?? []).length >= 1 && p.requests.length >= 2, "second plan");
    expect(results(p.requests[1])).toContain("trop risqué, découpe en deux");
    expect(results(p.requests[1])).toContain("The planning mode stays active");
    await sleep(350);
    run.type(KEY.escape);
    await run.waitFor((t) => t.includes("je revois"), "end");
    expect(run.screen().join("\n")).toContain("mode : planning");
    await quit(run);
  });

  test("SPEC-MOT-007/CA-03 — the planning mode activated: a reminder at the activation, then at its frequency", async () => {
    const ws = workspace();
    const find = (n: number) => call("find_files", { pattern: `*.nothing${n}` }); // distinct calls, never a repetition
    const p = new ScriptedProvider([call("start_planning", { reason: "changement large" }), find(1), find(2), find(3), find(4), find(5), { text: "prêt" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "prépare");
    await run.waitFor((t) => t.includes("passer en mode planification"), "question");
    await sleep(350);
    run.type("o");
    await run.waitFor((t) => t.includes("prêt"), "end");
    expect(results(p.requests[1])).toContain("The planning mode is now active");
    expect(all(p.requests[1])).toContain("The permission mode is now planning");
    const later = p.requests.slice(2).map(all);
    expect(later.some((h) => h.includes("The planning mode is still active"))).toBe(true);
    await quit(run);
  });
});

describe("SPEC-OUT-033 request_user_choice", () => {
  const questions = [
    { question: "Quelle base ?", header: "Base", options: [{ label: "PostgreSQL" }, { label: "SQLite" }] },
    { question: "Quels formats ?", header: "Formats", options: [{ label: "JSON" }, { label: "CSV" }, { label: "XML" }], allow_multiple: true },
  ];

  test("skipping a required decision stops queued actions and the next model round", async () => {
    const ws = workspace();
    const path = join(ws.project, "dependent.txt");
    const provider = new ScriptedProvider([{ toolCalls: [
      { name: "request_user_choice", input: { questions: [{ ...questions[0], require_answer: true }] } },
      { name: "write_file", input: { path, content: "unexpected" } },
    ] }, { text: "unexpected continuation" }]);
    const host = new Host(ws, { provider, init: { demands: ["request_user_choice"] }, answers: { request_user_choice: () => ({ answers: [] }) } });
    host.user("choisis");
    await host.waitFor(m => m.type === "turn_completed");
    host.feed.end();
    await host.finish();
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(host.messages)).toContain("Not executed: the turn was stopped.");
    expect(existsSync(path)).toBe(false);
  });

  test.skipIf(process.platform !== "win32")("an interactive PowerShell command waits for a choice and releases only its selected receipt", async () => {
    const command = "@{choiceNonce=$env:TOOL_CHOICE_NONCE; question=@{question='Which slot?';options=@(@{label='Earlier'},@{label='Later'})}; receipts=@('earlier-receipt','later-receipt')} | ConvertTo-Json -Compress -Depth 5";
    const provider = new ScriptedProvider([call("run_powershell", { command }), { text: "done" }]);
    let asked = 0;
    const host = new Host(workspace(), { provider, init: { decisionAuthority: true, demands: ["approval_request", "request_user_choice"] }, answers: {
      approval_request: () => ({ decision: "allow" }),
      request_user_choice: () => { asked++; return { answers: [{ labels: ["Later"] }] }; },
    } });
    host.user("choose");
    await host.waitFor(m => m.type === "turn_completed");
    host.feed.end();
    await host.finish();
    expect(asked).toBe(1);
    expect(results(provider.requests[1])).toContain("later-receipt");
    expect(results(provider.requests[1])).not.toContain("earlier-receipt");
  });

  test("SPEC-OUT-033/CA-01 — two questions, one with several answers: the model gets both, the second as a list", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([call("request_user_choice", { questions }), { text: "noté" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "configure");
    await run.waitFor((t) => t.includes("Quelle base ?"), "first question");
    await sleep(350);
    run.type("2");
    await run.waitFor((t) => t.includes("Quels formats ?"), "second question");
    await sleep(350);
    run.type(" ");
    run.type(KEY.down);
    run.type(KEY.down);
    run.type(" ");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("noté"), "answer");
    const r = results(p.requests[1]);
    expect(r).toContain("Quelle base ?: SQLite");
    expect(r).toContain('Quels formats ?: [\\"JSON\\", \\"XML\\"]');
    await quit(run);
  });

  test("SPEC-OUT-033/CA-02 — a question answered with « Other » and a text: the text is returned", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([call("request_user_choice", { questions: [questions[0]] }), { text: "noté" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "configure");
    await run.waitFor((t) => t.includes("Quelle base ?"), "question");
    await sleep(350);
    run.type("3"); // other
    await run.waitFor((t) => t.includes("votre réponse"), "free answer");
    send(run, "MariaDB, déjà en production");
    await run.waitFor((t) => t.includes("noté"), "answer");
    expect(results(p.requests[1])).toContain("(free answer) MariaDB, déjà en production");
    await quit(run);
  });

  test("SPEC-OUT-033/CA-03 — a control host without the question capability: the tool is not offered; with it, the host answers", async () => {
    const without = new ScriptedProvider([{ text: "ok" }]);
    const h1 = new Host(workspace(), { provider: without, init: { demands: [] } });
    h1.user("bonjour");
    await h1.waitFor((m) => m.type === "turn_completed");
    h1.feed.end();
    await h1.finish();
    expect(without.requests[0]!.tools.map((t) => t.name)).not.toContain("request_user_choice");

    const withIt = new ScriptedProvider([call("request_user_choice", { questions: [questions[0]] }), { text: "noté" }]);
    const h2 = new Host(workspace(), { provider: withIt, init: { demands: ["request_user_choice"] }, answers: { request_user_choice: () => ({ answers: [{ labels: ["PostgreSQL"] }] }) } });
    h2.user("choisis");
    await h2.waitFor((m) => m.type === "turn_completed");
    h2.feed.end();
    await h2.finish();
    expect(withIt.requests[0]!.tools.map((t) => t.name)).toContain("request_user_choice");
    expect(results(withIt.requests[1])).toContain("Quelle base ?: PostgreSQL");
  });
});
