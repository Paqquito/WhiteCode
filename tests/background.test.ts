// Background tasks (SPEC-AGT-016 to SPEC-AGT-018), the tools of the tasks (SPEC-OUT-020), the monitor (SPEC-OUT-022),
// a detached shell command (SPEC-OUT-008 CA-05), the reminder of a task's end (SPEC-MOT-007 CA-02), a background
// agent (SPEC-OUT-016 CA-03).
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest } from "../src/providers/types";
import { cli, workspace, type Workspace } from "./helpers/env";
import { bunCommand, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { afterNativeStart } from "./helpers/native-ready";

const script = (ws: Workspace, name: string, body: string) => bunCommand(ws.write(`scripts/${name}.ts`, body).replace(/\\/g, "/"));
const call = (name: string, input: Record<string, unknown>) => ({ toolCalls: [{ name, input }] });
/** The results of the last response: the last user message, before the notes appended after it. */
const results = (r: ModelRequest | undefined) => JSON.stringify([...(r?.history ?? [])].reverse().find((m) => m.role === "user") ?? null);
const all = (r: ModelRequest | undefined) => JSON.stringify(r?.history ?? []);
const run = (ws: Workspace, p: ScriptedProvider, args: string[] = []) => cli(["--non-interactive", "--allow-rule", "run_shell", ...args, "go"], ws, { provider: p, env: productEnv(ws) });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const main = (p: ScriptedProvider) => p.requests.filter((r) => r.purpose !== "subagent");
const ready = (ws: Workspace) => `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(join(ws.root,"native-ready"))},"ready");`;

describe("SPEC-AGT-017 background commands", () => {
  test("SPEC-OUT-008/CA-05 — SPEC-AGT-017/CA-01 — a server started detached: the task id comes at once, the conversation goes on, the output is readable", async () => {
    const ws = workspace();
    const server = script(ws, "server", ready(ws)+'console.log("serveur prêt"); await Bun.sleep(30_000);');
    const p = new ScriptedProvider([
      call("run_shell", { command: server, detached: true, description: "serveur de dev" }),
      call("background_output", { task_id: "b1", timeout: 3_000 }),
      { text: "le serveur tourne" },
    ]);
    afterNativeStart(p,join(ws.root,"native-ready"));
    const started = Date.now();
    const r = await run(ws, p);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(results(p.requests[1])).toContain("Started in the background as task b1");
    const output = results(p.requests[2]);
    expect(output).toContain("serveur prêt");
    expect(output).toContain("still running");
    expect(r.stdout).toContain("le serveur tourne");
    expect(r.stderr).toContain("Tâches de fond arrêtées à la fin de la session : b1."); // SPEC-AGT-016 FA-02
  }, 30_000);

  test("SPEC-AGT-016/CA-02 — SPEC-OUT-020/CA-03 — a server with child processes stopped by the model: the process and its children stop", async () => {
    const ws = workspace();
    const pids = join(ws.root, "pids.txt").replace(/\\/g, "/");
    const child = ws.write("scripts/child.ts", "await Bun.sleep(60_000);\n").replace(/\\/g, "/");
    const parent = script(
      ws,
      "parent",
      `import {writeFileSync} from "node:fs"; const c = Bun.spawn([process.execPath, ${JSON.stringify(child)}], { stdout: "ignore" }); writeFileSync(${JSON.stringify(pids)}, process.pid + " " + c.pid); writeFileSync(${JSON.stringify(join(ws.root,"native-ready"))},"ready"); console.log("lancé"); await Bun.sleep(60_000);`,
    );
    const p = new ScriptedProvider([
      call("run_shell", { command: parent, detached: true }),
      call("background_output", { task_id: "b1", timeout: 2_500 }),
      call("background_stop", { task_id: "b1" }),
      { text: "arrêté" },
    ]);
    afterNativeStart(p,join(ws.root,"native-ready"));
    await run(ws, p);
    expect(results(p.requests[3])).toContain("Task b1 stopped");
    const [a, b] = readFileSync(pids, "utf8").split(" ").map(Number);
    await Bun.sleep(500);
    expect(alive(a!)).toBe(false);
    expect(alive(b!)).toBe(false);
  }, 30_000);

  test("SPEC-AGT-016/CA-01 — SPEC-MOT-007/CA-02 — a task ending during a turn: the next request announces it once, with how to read its output", async () => {
    const ws = workspace();
    const quick = script(ws, "quick", ready(ws)+'console.log("travail fait");');
    const p = new ScriptedProvider([
      call("run_shell", { command: quick, detached: true }),
      call("background_output", { task_id: "b1" }),
      call("find_files", { pattern: "*.nothing" }),
      { text: "fini" },
    ]);
    afterNativeStart(p,join(ws.root,"native-ready"));
    await run(ws, p);
    const notice = "The background command b1";
    expect(all(p.requests[2])).toContain(notice);
    expect(all(p.requests[2])).toContain("background_output (task_id b1)");
    expect(all(p.requests[3]).split(notice).length - 1).toBe(1); // once only
  }, 30_000);
});

describe("SPEC-OUT-022 monitor_process", () => {
  test("SPEC-OUT-022/CA-01 — SPEC-OUT-022/CA-02 — a log filtered on ERROR: the line reaches the model, then the exit code", async () => {
    const ws = workspace();
    const log = script(ws, "log", ready(ws)+'await Bun.sleep(200); console.log("ERROR disque plein"); await Bun.sleep(200);');
    const p = new ScriptedProvider([
      call("monitor_process", { command: log, description: "erreurs du journal" }),
      call("background_output", { task_id: "m1", timeout: 5_000 }),
      call("find_files", { pattern: "*.nothing" }),
      { text: "fini" },
    ]);
    afterNativeStart(p,join(ws.root,"native-ready"));
    await run(ws, p);
    expect(results(p.requests[1])).toContain("Monitor m1 started");
    const later = all(p.requests[3]);
    expect(later).toContain("The monitor m1 (erreurs du journal) reported:");
    expect(later).toContain("ERROR disque plein");
    expect(later).toContain("ended with exit code 0");
  }, 30_000);

  test("SPEC-OUT-022/CA-03 — a flood of lines: the monitor is stopped with the advice to filter", async () => {
    const ws = workspace();
    const flood = script(ws, "flood", ready(ws)+'for (let i = 0; i < 10_000; i++) console.log("ligne " + i); await Bun.sleep(5_000);');
    const p = new ScriptedProvider([call("monitor_process", { command: flood, description: "tout" }), call("background_output", { task_id: "m1", timeout: 8_000 }), call("find_files", { pattern: "*.x" }), { text: "fini" }]);
    afterNativeStart(p,join(ws.root,"native-ready"));
    await run(ws, p);
    const later = all(p.requests[3]);
    expect(later).toContain("was stopped because its output came too fast: filter the command more");
    expect(later).not.toContain("ligne 9999\\nligne"); // never the whole flood in the context
  }, 30_000);
});

describe("SPEC-OUT-020 the work items", () => {
  test("SPEC-OUT-020/CA-01 — SPEC-OUT-020/CA-02 — two claims of the same task: one owner; a blocked task cannot be claimed", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([
      { toolCalls: [{ name: "work_item_create", input: { subject: "Préparer" } }, { name: "work_item_create", input: { subject: "Publier" } }] },
      call("work_item_update", { item_id: "2", blocked_by: ["1"] }),
      { toolCalls: [{ name: "work_item_update", input: { item_id: "1", owner: "alice" } }, { name: "work_item_update", input: { item_id: "1", owner: "bob" } }, { name: "work_item_update", input: { item_id: "2", owner: "carol" } }] },
      call("work_item_list", {}),
      { text: "fini" },
    ]);
    await run(ws, p);
    const claims = results(p.requests[3]);
    expect(claims).toContain("Task #1 updated");
    expect(claims).toContain("Task 1 is already owned by alice.");
    expect(claims).toContain("Task 2 is blocked by #1: it cannot be claimed");
    expect(results(p.requests[4])).toContain("Blocked: #2");
  });

  test("SPEC-OUT-020/CA-04 — a task created by update_todo_list: work_item_list shows it with its id and status", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([call("update_todo_list", { items: [{ content: "Écrire le guide", status: "in_progress" }] }), call("work_item_list", {}), { text: "fini" }]);
    await run(ws, p);
    expect(results(p.requests[2])).toContain("[~] #1 Écrire le guide");
  });

  test("TECH — a circular dependency is refused (SPEC-OUT-020 EF-02)", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([
      { toolCalls: [{ name: "work_item_create", input: { subject: "A" } }, { name: "work_item_create", input: { subject: "B" } }] },
      call("work_item_update", { item_id: "2", blocked_by: ["1"] }),
      call("work_item_update", { item_id: "1", blocked_by: ["2"] }),
      { text: "fini" },
    ]);
    await run(ws, p);
    expect(results(p.requests[3])).toContain("Circular dependency");
  });
});

describe("SPEC-AGT-018 background agents", () => {
  test("SPEC-OUT-016/CA-03 — an agent in the background: the caller goes on, then gets a notification with the report", async () => {
    const ws = workspace();
    const p = new ScriptedProvider(
      [call("spawn_agent", { description: "recherche", prompt: "cherche", detached: true }), call("background_output", { task_id: "a1", timeout: 5_000 }), call("find_files", { pattern: "*.x" }), { text: "fini" }],
      [{ text: "rapport de fond : trouvé", delayMs: 300 }],
    );
    await run(ws, p);
    expect(results(main(p)[1])).toContain("Agent started in the background as task a1");
    const later = all(main(p)[3]);
    expect(later).toContain("The background agent a1 (recherche) ended.");
    expect(later).toContain("rapport de fond : trouvé");
  }, 30_000);

  test("SPEC-AGT-018/CA-02 — a background agent in no_prompt asking for an action: no demand, the action is refused", async () => {
    const ws = workspace();
    const target = join(ws.project, "fond.txt");
    const p = new ScriptedProvider(
      [call("spawn_agent", { description: "écriture", prompt: "écris", detached: true }), call("background_output", { task_id: "a1", timeout: 5_000 }), { text: "fini" }],
      [call("write_file", { path: target, content: "x" }), { text: "je n'ai pas pu écrire" }],
    );
    await cli(["--non-interactive", "go"], ws, { provider: p });
    expect(existsSync(target)).toBe(false);
    const agentResults = JSON.stringify(p.requests.filter((r) => r.purpose === "subagent")[1]?.history.at(-1));
    expect(agentResults).toContain("Not allowed in this run");
  }, 30_000);
});
