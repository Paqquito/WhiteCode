// Command engine (SPEC-CMD-001), help (SPEC-CMD-030), prompts of connectors as commands (SPEC-MCP-011) and key bindings
// (SPEC-IHM-014).
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACTIONS, buildKeymap, parseCombo } from "../src/interactive/keymap";
import { cli, workspace, type Workspace } from "./helpers/env";
import { BUN, productEnv, PROJECT_DIR } from "./helpers/hooks";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const SERVER = join(import.meta.dir, "helpers", "mcp-server.ts").replace(/\\/g, "/");
const command = (description: string, body: string) => `---\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
const projectCommand = (ws: Workspace, name: string, body: string) => ws.write(`project/${PROJECT_DIR}/commands/${name}.md`, command(`Project ${name}.`, body));
const userCommand = (ws: Workspace, name: string, body: string) => ws.write(`home/config/commands/${name}.md`, command(`User ${name}.`, body));
const extension = (ws: Workspace, name: string, files: Record<string, string>) => {
  ws.write(`ext/${name}/extension.json`, JSON.stringify({ name, version: "1.0.0", description: `The ${name} extension.` }));
  for (const [p, c] of Object.entries(files)) ws.write(`ext/${name}/${p}`, c);
  return join(ws.root, "ext", name);
};
/** A connector `tickets` of the simulated server, with prompts. */
const ticketsConnector = (ws: Workspace, prompts: unknown[]) => {
  const config = join(ws.root, "tickets.json").replace(/\\/g, "/");
  writeFileSync(config, JSON.stringify({ tools: [], prompts }));
  writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers: { tickets: { transport: "stdio", command: BUN, args: [SERVER, config] } } }));
};
const automated = (ws: Workspace, provider: ScriptedProvider, args: string[], userConfig: Record<string, unknown> = {}) =>
  cli(["--non-interactive", ...args], ws, { provider, userConfig, env: productEnv(ws) });
const lastUser = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history.filter((m) => m.role === "user").pop() ?? null);
const quit = async (run: ReturnType<typeof interactive>) => {
  run.type(KEY.ctrlU);
  await run.idle();
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  return run.done;
};

describe("SPEC-CMD-001 command engine", () => {
  test("SPEC-CMD-001/CA-01 — a known display command runs and nothing is sent to the model", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    run.type("/help");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Commandes du produit") && t.includes("/exit"), "help shown");
    await run.idle();
    expect(p.requests.length).toBe(0);
    // FA-04: in an automated run, a command of the interface is refused with an explanation.
    const r = await automated(ws, new ScriptedProvider([]), ["/help"]);
    expect(r.stderr).toContain("Commande indisponible en exécution automatisée : /help.");
    await quit(run);
  });

  test("SPEC-CMD-001/CA-03 — a project command named like an internal one: the internal one wins, the masking is reported", async () => {
    const ws = workspace();
    projectCommand(ws, "help", "PROJECT HELP $ARGS");
    const p = new ScriptedProvider([{ text: "ok" }]);
    const run = interactive(["--allow-project-trust"], ws, { provider: p });
    await run.idle();
    run.type("/help");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Commandes du produit"), "internal help");
    await run.idle();
    expect(p.requests.length).toBe(0);
    // The masked command stays reachable by its qualified name (§ 5.4).
    run.type("/project:help");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● ok"), "project command");
    expect(lastUser(p, 0)).toContain("PROJECT HELP");
    const r = await quit(run);
    expect(r.stderr).toContain("La commande /help de portée project est masquée par la commande interne du même nom ; elle reste joignable par /project:help.");
  });

  test("SPEC-CMD-001/CA-04 — an extension command and a connector command with the same short name: the qualified name is asked", async () => {
    const ws = workspace();
    ticketsConnector(ws, [{ name: "triage", arguments: [{ name: "ticket", required: true }], text: "Triage {ticket}" }]);
    const ext = extension(ws, "ops", { "commands/triage.md": command("Ops triage.", "OPS TRIAGE") });
    const p = new ScriptedProvider([{ text: "a" }, { text: "b" }]);
    const r = await automated(ws, p, ["--wait-for-mcp", "--extension-dir", ext, "/triage 42"]);
    expect(r.stderr).toContain("Plusieurs commandes portent le nom triage : utilisez /cnx_tickets_triage ou /ops:triage.");
    expect(p.requests.length).toBe(0);
  });

  test("SPEC-CMD-001/CA-08 — two extensions providing deploy, in both loading orders: the qualified names are listed and nothing runs", async () => {
    const ws = workspace();
    const a = extension(ws, "a", { "commands/deploy.md": command("A.", "A") });
    const b = extension(ws, "b", { "commands/deploy.md": command("B.", "B") });
    for (const order of [
      [a, b],
      [b, a],
    ]) {
      const p = new ScriptedProvider([]);
      const r = await automated(ws, p, ["--extension-dir", order[0]!, "--extension-dir", order[1]!, "/deploy prod"]);
      expect(r.stderr).toContain("Plusieurs commandes portent le nom deploy : utilisez /a:deploy ou /b:deploy.");
      expect(p.requests.length).toBe(0);
    }
  });

  test("SPEC-CMD-001/CA-09 — a user command and a project command revue: the project one runs, /user:revue stays reachable", async () => {
    const ws = workspace();
    projectCommand(ws, "revue", "PROJECT REVIEW");
    userCommand(ws, "revue", "USER REVIEW");
    const p1 = new ScriptedProvider([{ text: "ok" }]);
    await automated(ws, p1, ["--allow-project-trust", "/revue"]);
    expect(lastUser(p1, 0)).toContain("PROJECT REVIEW");
    const p2 = new ScriptedProvider([{ text: "ok" }]);
    await automated(ws, p2, ["--allow-project-trust", "/user:revue"]);
    expect(lastUser(p2, 0)).toContain("USER REVIEW");
  });

  test("TECH — SPEC-CMD-001 § 11 — commands.allowProjectCommands false: the commands of the project are not loaded", async () => {
    const ws = workspace();
    projectCommand(ws, "revue", "PROJECT REVIEW");
    const p = new ScriptedProvider([]);
    const r = await automated(ws, p, ["--allow-project-trust", "/revue"], { commands: { allowProjectCommands: false } });
    expect(r.stderr).toContain("Commande inconnue : /revue.");
    expect(p.requests.length).toBe(0);
  });
});

describe("SPEC-MCP-011 prompts of connectors as commands", () => {
  test("SPEC-MCP-011/CA-01 — a prompt triage with an argument ticket: /cnx_tickets_triage 123 sends its content to the model", async () => {
    const ws = workspace();
    ticketsConnector(ws, [{ name: "triage", description: "Triage a ticket.", arguments: [{ name: "ticket", required: true }], text: "Please triage ticket {ticket} now." }]);
    const p = new ScriptedProvider([{ text: "triaged" }]);
    const r = await automated(ws, p, ["--wait-for-mcp", "/cnx_tickets_triage 123"]);
    expect(r.code).toBe(0);
    expect(lastUser(p, 0)).toContain("Please triage ticket 123 now.");
    // FA-01: a required argument missing gives the usage, and nothing is sent.
    const p2 = new ScriptedProvider([]);
    const r2 = await automated(ws, p2, ["--wait-for-mcp", "/cnx_tickets_triage"]);
    expect(r2.stderr).toContain("Usage : /cnx_tickets_triage <ticket>.");
    expect(p2.requests.length).toBe(0);
  });
});

describe("SPEC-CMD-030 help", () => {
  test("SPEC-CMD-030/CA-01 — a command disabled by the administrator is not in the help", async () => {
    const ws = workspace();
    userCommand(ws, "revue", "USER REVIEW");
    ws.write("managed/policy.json", JSON.stringify({ commands: { disabled: ["shortcuts", "revue"] } }));
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("/help");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Commandes du produit"), "help");
    const help = run.all().join("\n");
    expect(help).toContain("/exit");
    expect(help).not.toContain("/shortcuts");
    expect(help).not.toContain("/revue");
    await run.idle();
    run.type("/revue");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Cette commande est désactivée par la politique en vigueur."), "refused");
    await quit(run);
  });
});

describe("SPEC-IHM-014 key bindings", () => {
  test("SPEC-IHM-014/CA-01 — SPEC-IHM-014/CA-06 — the help lists every action of the contexts with its combination, and the fallbacks", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), rows: 60, columns: 200 });
    await run.idle();
    run.type("/shortcuts");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Raccourcis de la zone de saisie") && t.includes("Raccourcis des dialogues") && t.includes("Refuser"), "shortcuts");
    const help = run.all().join("\n");
    for (const a of ACTIONS) expect(help).toContain(a.label.slice(0, 30));
    expect(help).toContain("Ctrl+C");
    expect(help).toContain("Maj+Entrée : non transmise par certains terminaux ; repli : Alt+Entrée, Ctrl+J");
    await quit(run);
  });

  test("SPEC-IHM-014/CA-02 — SPEC-IHM-014/CA-03 — a valid custom binding applies and the help shows it; an invalid one is reported without stopping the others", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), rows: 60, userConfig: { ui: { keybindings: { bindings: { "draft.stash": "ctrl+g", "input.undo": "hyper+x", "nope.action": "ctrl+q" } } } } });
    await run.idle();
    run.type("à ranger");
    run.type("\u0007"); // Ctrl+G
    await run.waitFor((t) => t.includes("1 brouillon de côté"), "stashed by the custom binding");
    run.type("/shortcuts");
    run.type(KEY.enter);
    await run.waitFor((t) => /Ctrl\+G\s+Mettre le brouillon de côté \(personnalisé\)/.test(t), "custom binding in the help");
    const r = await quit(run);
    expect(r.stderr).toContain("Combinaison invalide : hyper+x.");
    expect(r.stderr).toContain("Action inconnue : nope.action.");
  });

  test("SPEC-IHM-014/CA-04 — disabling the interruption is refused", async () => {
    const { keymap, warnings } = buildKeymap({ "app.interrupt": "" }, { strictConflicts: false });
    expect(warnings).toContain("Cette action ne peut pas être désactivée : app.interrupt.");
    expect(keymap.effective("app.interrupt")).toEqual(["ctrl+c"]);
    // A combination of an essential action cannot be taken by another action either (RG-01).
    const taken = buildKeymap({ "draft.stash": "ctrl+c" }, { strictConflicts: false });
    expect(taken.keymap.effective("app.interrupt")).toEqual(["ctrl+c"]);
    expect(taken.warnings[0]).toContain("réservée à une action essentielle");
  });

  test("SPEC-IHM-014/CA-05 — two actions on the same combination in a context: a warning, and the first declared applies", async () => {
    const both = buildKeymap({ "draft.stash": "ctrl+g", "draft.restore": "ctrl+g" }, { strictConflicts: false });
    expect(both.warnings).toContain("Deux actions partagent la même combinaison : ctrl+g (draft.stash, draft.restore, input.externalEditor) ; draft.stash s'applique.");
    expect(both.keymap.effective("draft.stash")).toEqual(["ctrl+g"]);
    expect(both.keymap.effective("draft.restore")).toEqual([]);
    const strict = buildKeymap({ "draft.stash": "ctrl+k" }, { strictConflicts: true });
    expect(strict.warnings.join("\n")).toContain("Associations personnalisées refusées");
    expect(strict.keymap.effective("draft.stash")).toEqual(["ctrl+s"]);
    expect(parseCombo("Ctrl+Shift+Enter")).toBe("ctrl+shift+enter");
    expect(parseCombo("shift+a")).toBeUndefined();
  });

  test("SPEC-IHM-014/CA-07 — the reset command brings the default bindings back", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: { ui: { keybindings: { bindings: { "draft.stash": "ctrl+g" } } } } });
    await run.idle();
    run.type("/shortcuts reset");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Raccourcis par défaut rétablis."), "reset");
    expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).ui.keybindings.bindings).toBeUndefined();
    await run.idle();
    run.type("brouillon");
    run.type(KEY.ctrlS);
    await run.waitFor((t) => t.includes("1 brouillon de côté"), "default binding back");
    await sleep(10);
    await quit(run);
  });
});

describe("SPEC-CMD-023 exit", () => {
  test("TECH — SPEC-CMD-023 § 5.1, FA-01 — /exit during a turn interrupts it and quits at once", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([{ hang: true }]) });
    await run.idle();
    run.type("long");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("Échap pour interrompre"), "turn");
    run.type("/exit");
    run.type(KEY.enter);
    expect((await run.done).code).toBe(0);
  });
});
