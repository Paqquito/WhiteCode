// Criteria of functions delivered by earlier lots, proved here or completed (lot 7, increment 1): messages typed during
// the work (SPEC-MOT-008), interruption (SPEC-MOT-009), reminders (SPEC-MOT-007), paths (SPEC-PER-010), trust of the
// workspace (SPEC-PER-016), the `unrestricted` mode (SPEC-PER-003, SPEC-PER-017), the task list (SPEC-OUT-021).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { PROJECT_DIR, productEnv, record } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const send = (run: ReturnType<typeof interactive>, line: string) => {
  run.type(line);
  run.type(KEY.enter);
};
const history = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history ?? []);

describe("SPEC-MOT-008 messages typed during the work", () => {
  test("SPEC-MOT-008/CA-01 — a message typed while tools run: it reaches the model at the end of the iteration, without interruption", async () => {
    const ws = workspace();
    const file = ws.write("project/a.txt", "contenu\n");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }], delayMs: 600 }, { text: "compris, la v2" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "lis le fichier");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    send(run, "utilise plutôt la v2");
    await run.waitFor((t) => t.includes("compris, la v2"), "answer");
    await run.idle();
    expect(p.requests).toHaveLength(2); // no turn of its own, no interruption
    const second = history(p, 1);
    expect(second.indexOf("utilise plutôt la v2")).toBeGreaterThan(second.indexOf("tool_result")); // after the results (EF-03)
    expect(second).toContain("while you were working");
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });

  test("SPEC-MOT-008/CA-02 — a queued message and the up arrow: it comes back to the input and leaves the queue", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([{ hang: true }]) });
    await run.idle();
    send(run, "longue tâche");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    send(run, "à modifier");
    await run.waitFor((t) => t.includes("1 message en attente"), "queued");
    run.type(KEY.up);
    await run.waitFor((t) => !t.includes("message en attente"), "queue emptied");
    expect(run.screen().join("\n")).toContain("à modifier");
    run.type(KEY.escape);
    await run.waitFor((t) => !t.includes("Échap pour interrompre"), "turn interrupted");
    run.type(KEY.ctrlU);
    await run.idle();
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });
});

describe("SPEC-MOT-009 interruption", () => {
  test("SPEC-MOT-009/CA-01 — a response being shown and Échap: the display stops within 300 ms and the input comes back", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([{ text: "une réponse qui ne finit pas", delayMs: 10_000 }]) });
    await run.idle();
    send(run, "parle");
    await run.waitFor((t) => t.includes("une réponse qui ne finit pas"), "streaming");
    const pressed = Date.now();
    run.type(KEY.escape);
    await run.idle();
    expect(Date.now() - pressed).toBeLessThan(300);
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });

  test("SPEC-MOT-009/CA-02 — SPEC-MOT-009/CA-05 — a long shell command interrupted: the process stops, the model sees « interrupted » and learns it at the next turn", async () => {
    const ws = workspace();
    const sleeper = ws.write("scripts/sleep.ts", "await Bun.sleep(20_000);\n").replace(/\\/g, "/");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: `bun "${sleeper}"` } }] }, { text: "suite" }]);
    const h = new Host(ws, { provider: p, init: {}, argv: ["--allow-rule", "run_shell(bun *)"] });
    h.user("lance");
    await h.waitFor((m) => m.type === "tool_call");
    await sleep(500);
    const started = Date.now();
    await h.request("cancel_turn");
    await h.waitFor((m) => m.type === "turn_completed");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(h.messages.some((m) => m.type === "tool_result" && String(m["output"]).toLowerCase().includes("interrupted"))).toBe(true);
    h.user("et alors ?");
    await h.waitFor((m) => m.type === "turn_completed" && m["turn"] === 2);
    h.feed.end();
    await h.finish();
    expect(history(p, 1)).toContain("The user interrupted the previous turn");
  }, 30_000);
});

describe("SPEC-MOT-007 reminders", () => {
  test("SPEC-MOT-007/CA-04 — a reminder inserted: it never appears as a message of the user in the conversation", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ hang: true }, { text: "d'accord" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    send(run, "première");
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    run.type(KEY.escape);
    await run.idle();
    send(run, "seconde");
    await run.waitFor((t) => t.includes("d'accord"), "answer");
    expect(history(p, 1)).toContain("system-reminder"); // the model got it
    const shown = run.all().join("\n");
    expect(shown).not.toContain("system-reminder");
    expect(shown).not.toContain("interrupted the previous turn");
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });
});

describe("SPEC-PER-010 paths", () => {
  test("SPEC-PER-010/CA-01 — a link of the project to a folder of keys: reading it asks", async () => {
    const ws = workspace();
    const keys = join(ws.home, ".ssh");
    mkdirSync(keys, { recursive: true });
    writeFileSync(join(keys, "id_test"), "clé");
    symlinkSync(keys, join(ws.project, "liens"), "junction");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "liens", "id_test") } }] }, { text: "fini" }]);
    const h = new Host(ws, { provider: p, init: { decisionAuthority: true }, answers: { approval_request: () => ({ decision: "deny", reason: "non" }) } });
    h.user("lis");
    await h.waitFor((m) => m.type === "turn_completed");
    h.feed.end();
    await h.finish();
    expect(h.demands("approval_request")).toHaveLength(1);
    expect(history(p, 1)).not.toContain("clé");
  });

  test("SPEC-PER-010/CA-03 — a path with .. leaving the project: writing asks", async () => {
    const ws = workspace();
    const outside = join(ws.project, "..", "dehors.txt");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: outside, content: "x" } }] }, { text: "fini" }]);
    const h = new Host(ws, { provider: p, argv: ["--approval-mode", "auto_edit"], init: { decisionAuthority: true }, answers: { approval_request: () => ({ decision: "deny", reason: "non" }) } });
    h.user("écris");
    await h.waitFor((m) => m.type === "turn_completed");
    h.feed.end();
    await h.finish();
    expect(h.demands("approval_request")).toHaveLength(1);
    expect(existsSync(join(ws.root, "dehors.txt"))).toBe(false);
  });
});

describe("SPEC-PER-016 trust of the workspace", () => {
  const projectWithHook = () => {
    const ws = workspace();
    const marker = record(ws, "opened");
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ hooks: { session_opened: [{ id: "start", actions: [{ type: "command", command: marker.command }] }] } }));
    return { ws, marker };
  };

  test("SPEC-PER-016/CA-01 — a repository with a start-up hook opened for the first time: the hook does not run before the trust decision", async () => {
    const { ws, marker } = projectWithHook();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), env: productEnv(ws) });
    await run.waitFor((t) => t.includes("n'a pas encore été évalué"), "trust question");
    expect(run.all().join("\n")).toContain("Crochets : session_opened");
    await sleep(500);
    expect(marker.read()).toHaveLength(0);
    run.type("2"); // trust
    await run.idle();
    await run.waitFor(() => marker.read().length === 1, "hook after the decision");
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
    // The decision is kept: the next launch asks nothing.
    const again = interactive([], ws, { provider: new ScriptedProvider([]), env: productEnv(ws) });
    await again.idle();
    expect(again.all().join("\n")).not.toContain("n'a pas encore été évalué");
    again.type(KEY.ctrlD);
    again.type(KEY.ctrlD);
    await again.done;
  }, 30_000);

  test("SPEC-PER-016/CA-02 — a refusal in restricted mode: the session starts without any active element of the project", async () => {
    const { ws, marker } = projectWithHook();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), env: productEnv(ws) });
    await run.waitFor((t) => t.includes("n'a pas encore été évalué"), "trust question");
    run.type("1"); // restricted
    await run.idle();
    await sleep(500);
    expect(marker.read()).toHaveLength(0);
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
    expect(marker.read()).toHaveLength(0);
  }, 30_000);
});

describe("SPEC-PER-003 and SPEC-PER-017 the unrestricted mode", () => {
  test("SPEC-PER-017/CA-01 — the switch of the organisation on: the mode is refused", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ permissions: { disableUnrestrictedMode: true } }));
    const r = await cli(["--non-interactive", "--allow-unrestricted-mode", "--approval-mode", "unrestricted", "x"], ws, { provider: new ScriptedProvider([{ text: "non" }]) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Ce mode est désactivé par votre administrateur.");
  });

  test("SPEC-PER-003/CA-02 — SPEC-PER-017/CA-02 — with --allow-unrestricted-mode, the cycle reaches unrestricted after its warning, accepted once", async () => {
    const ws = workspace();
    const run = interactive(["--allow-unrestricted-mode"], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    for (let i = 0; i < 3; i++) {
      run.type(KEY.shiftTab);
      await sleep(80);
    }
    // ask → auto_edit → planning → (auto_approve unavailable) → unrestricted: the warning comes first.
    await run.waitFor((t) => t.includes("Mode unrestricted : les actions s'exécutent sans confirmation"), "warning");
    await sleep(400);
    run.type("n");
    await run.waitFor((t) => /\bask\b/.test(run.screen().join("\n")), "refused: next mode");
    run.type(KEY.shiftTab);
    await sleep(80);
    run.type(KEY.shiftTab);
    await sleep(80);
    run.type(KEY.shiftTab);
    await run.waitFor((t) => t.includes("Activer ce mode ?"), "warning again");
    await sleep(400);
    run.type("o");
    await run.waitFor(() => run.screen().join("\n").includes("unrestricted"), "mode active");
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
    // Accepted once on the machine: a launch in this mode asks nothing more.
    const again = interactive(["--allow-unrestricted-mode", "--approval-mode", "unrestricted"], ws, { provider: new ScriptedProvider([]) });
    await again.idle();
    expect(again.all().join("\n")).not.toContain("Activer ce mode ?");
    again.type(KEY.ctrlD);
    again.type(KEY.ctrlD);
    await again.done;
  }, 30_000);
});

describe("SPEC-OUT-021 the task list", () => {
  test("SPEC-OUT-021/CA-01 — a list of three items: it is shown above the input area", async () => {
    const ws = workspace();
    const items = [
      { content: "Lire le code", status: "completed" },
      { content: "Écrire les tests", progress_label: "Écriture des tests", status: "in_progress" },
      { content: "Publier", status: "pending" },
    ];
    const run = interactive([], ws, { provider: new ScriptedProvider([{ toolCalls: [{ name: "update_todo_list", input: { items } }] }, { hang: true }]) });
    await run.idle();
    send(run, "planifie");
    await run.waitFor((t) => t.includes("Publier"), "list");
    const screen = run.screen();
    const input = screen.findIndex((l) => l.includes("Message à mettre en file") || l.includes("Votre message"));
    const listed = ["Lire le code", "Écriture des tests", "Publier"].map((s) => screen.findIndex((l) => l.includes(s)));
    expect(input).toBeGreaterThan(0);
    for (const row of listed) expect(row).toBeGreaterThanOrEqual(0);
    expect(Math.max(...listed)).toBeLessThan(input); // the in-progress task shows its progressive form
    run.type(KEY.escape);
    await run.idle();
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });
});
