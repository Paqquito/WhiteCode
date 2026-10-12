// Commands that show the state of the session (lot 8, increment 2): /status (SPEC-CMD-067), /context-usage
// (SPEC-CMD-014, SPEC-MOT-010 CA-03), /spending (SPEC-CMD-016, SPEC-MOT-008 CA-04), /background-tasks (SPEC-CMD-070),
// /skill-list (SPEC-CMD-065).
import { describe, expect, test } from "bun:test";
import { cli, workspace, type Workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { bunCommand, PROJECT_DIR, productEnv } from "./helpers/hooks";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const command = (ws: Workspace, line: string, args: string[] = [], env?: Record<string, string>) => cli(["--non-interactive", ...args, line], ws, { provider: new ScriptedProvider([]), ...(env ? { env } : {}) });
const shown = (m: Record<string, unknown>) => String((m["result"] as Record<string, unknown>)["shown"]);

describe("SPEC-CMD-067 /status", () => {
  test("SPEC-CMD-067/CA-01 — a connector in failure: it appears as failed in the list", async () => {
    const ws = workspace();
    const servers = JSON.stringify({ servers: { casse: { transport: "stdio", command: "commande-inexistante-pour-le-test" } } });
    const r = await command(ws, "/status", ["--connectors", servers, "--wait-for-mcp"], productEnv(ws));
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Connecteurs :");
    expect(r.stdout).toMatch(/casse \(cli\) : en échec/);
    expect(r.stdout).toContain("Mode de permission : no_prompt");
  });
});

describe("SPEC-CMD-014 /context-usage", () => {
  test("SPEC-CMD-014/CA-01 — SPEC-MOT-010/CA-03 — an automated run: a text table of the categories, whose sum is the total", async () => {
    const r = await command(workspace(), "/context-usage");
    expect(r.code).toBe(0);
    const rows = Object.fromEntries([...r.stdout.matchAll(/^(Instructions système|Outils|Messages|Pièces jointes|Total)\s+(\d+)/gm)].map((m) => [m[1]!, Number(m[2])]));
    expect(Object.keys(rows)).toHaveLength(5);
    expect(rows["Instructions système"]! + rows["Outils"]! + rows["Messages"]! + rows["Pièces jointes"]!).toBe(rows["Total"]!);
    expect(rows["Instructions système"]).toBeGreaterThan(0);
  });
});

describe("SPEC-CMD-016 /spending", () => {
  test("SPEC-CMD-016/CA-01 — SPEC-OBS-021/CA-01 — a session that used two models: the cost is detailed by model", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { description: "aide", prompt: "cherche", model: "small" } }] }, { text: "rapport" }, { text: "fini" }]);
    const h = new Host(ws, { provider: p, init: {} });
    h.user("délègue");
    await h.waitFor((m) => m.type === "turn_completed");
    const r = await h.request("invoke_command", { command: "/spending" });
    h.feed.end();
    await h.finish();
    const out = shown(r);
    expect(out).toContain("(estimations)");
    expect(out).toMatch(/test-medium : 2 requêtes/);
    expect(out).toMatch(/test-small : 1 requête/);
  });

  test("SPEC-MOT-008/CA-04 — /spending typed during a turn: it runs when the turn ends", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([{ text: "réponse lente", delayMs: 800 }]) });
    await run.idle();
    run.type("question");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    run.type("/spending");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("1 message en attente"), "queued");
    expect(run.all().join("\n")).not.toContain("Consommation de la session");
    await run.waitFor((t) => t.includes("Consommation de la session"), "run after the turn");
    expect(run.all().join("\n").indexOf("réponse lente")).toBeLessThan(run.all().join("\n").indexOf("Consommation de la session"));
    await run.idle();
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  });
});

describe("SPEC-CMD-070 /background-tasks and SPEC-CMD-065 /skill-list", () => {
  test("SPEC-CMD-070/CA-01 — an active task: it is listed", async () => {
    const ws = workspace();
    const server = bunCommand(ws.write("scripts/attente.ts", "await Bun.sleep(30_000);").replace(/\\/g, "/"));
    const p = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: server, detached: true, description: "serveur de test" } }] }, { text: "lancé" }]);
    const h = new Host(ws, { provider: p, init: {}, argv: ["--allow-rule", "run_shell"], env: productEnv(ws) });
    h.user("lance");
    await h.waitFor((m) => m.type === "turn_completed");
    const r = await h.request("invoke_command", { command: "/background-tasks" });
    h.feed.end();
    await h.finish();
    expect(shown(r)).toMatch(/b1\s+en cours\s+serveur de test/);
  }, 30_000);

  test("SPEC-CMD-065/CA-01 — a skill of the project: it is listed under the source « projet »", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/skills/revue/definition.md`, '---\nname: "revue"\ndescription: "Relit un changement."\n---\nRelis.\n');
    const r = await command(ws, "/skill-list", ["--allow-project-trust"]);
    expect(r.stdout).toContain("Projet :\n  revue — Relit un changement.");
  });
});

