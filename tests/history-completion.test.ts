// History of the inputs (SPEC-IHM-008) and completion (SPEC-IHM-009), in the interactive session.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InputHistory } from "../src/interactive/history";
import { detectTrigger, matchQuality } from "../src/interactive/completion";
import { containsSecret } from "../src/shared/secrets";
import { workspace, type Workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const CTRL_R = "\u0012";
const TAB = "\t";
type Run = ReturnType<typeof interactive>;
const send = async (run: Run, message: string) => {
  await run.idle();
  run.type(message);
  run.type(KEY.enter);
};
const quit = async (run: Run) => {
  run.type(KEY.ctrlU);
  await run.idle();
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  return run.done;
};
const inputLine = (run: Run) => run.screen().find((l) => l.startsWith("│ › ")) ?? "";
const answers = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `réponse ${i + 1}` }));
const store = (ws: Workspace, extra: Partial<ConstructorParameters<typeof InputHistory>[0]> = {}) =>
  new InputHistory({ path: join(ws.configHome, "input-history.jsonl"), dir: ws.project, scope: "folder", maxEntries: 5000, retentionDays: 90, enabled: true, warn: () => {}, ...extra });

describe("SPEC-IHM-008 history of the inputs", () => {
  test("SPEC-IHM-008/CA-01 — three messages sent: two presses on up bring the one before the last", async () => {
    const ws = workspace();
    const p = new ScriptedProvider(answers(3));
    const run = interactive([], ws, { provider: p });
    for (const m of ["premier", "deuxième", "troisième"]) {
      await send(run, m);
      await run.waitFor((t) => t.includes(`● réponse ${["premier", "deuxième", "troisième"].indexOf(m) + 1}`), m);
    }
    await run.idle();
    run.type(KEY.up);
    run.type(KEY.up);
    await run.waitFor(() => inputLine(run).startsWith("│ › deuxième"), "the one before the last");
    expect(run.all().join("\n")).toContain("Historique 2/3");
    await sleep(50);
    expect(p.requests.length).toBe(3); // EF-07: never sent by itself
    await quit(run);
  });

  test("SPEC-IHM-008/CA-02 — SPEC-IHM-007/CA-03 — browsing the history then coming back gives the draft back", async () => {
    const ws = workspace();
    store(ws).add("ancien message");
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("mon brouillon");
    run.type(KEY.up);
    await run.waitFor(() => inputLine(run).startsWith("│ › ancien message"), "history entry");
    run.type(KEY.down);
    await run.waitFor(() => inputLine(run).startsWith("│ › mon brouillon"), "draft back");
    await quit(run);
  });

  test("SPEC-IHM-008/CA-03 — a multiline entry comes back with its line breaks", async () => {
    const ws = workspace();
    store(ws).add("ligne un\nligne deux");
    const p = new ScriptedProvider([{ text: "ok" }]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    run.type(KEY.up);
    await run.waitFor((t) => t.includes("│ › ligne un") && t.includes("│   ligne deux"), "two lines");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("● ok"), "sent");
    expect(JSON.stringify(p.requests[0]!.history)).toContain("ligne un\\nligne deux");
    await quit(run);
  });

  test("SPEC-IHM-008/CA-04 — the same message sent twice in a row gives one entry", () => {
    const ws = workspace();
    const h = store(ws);
    h.add("bonjour");
    h.add("bonjour");
    h.add("autre");
    h.add("bonjour");
    expect(h.entries().map((e) => e.text)).toEqual(["bonjour", "autre", "bonjour"]);
  });

  test("SPEC-IHM-008/CA-05 — an incremental search proposes the most recent match, which is not sent", async () => {
    const ws = workspace();
    const h = store(ws);
    for (const m of ["lancer les tests", "corriger le bug", "lancer la compilation"]) h.add(m);
    const p = new ScriptedProvider([]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    run.type(CTRL_R);
    run.type("lancer");
    await run.waitFor((t) => t.includes("→  lancer la compilation") && t.includes("1/2"), "most recent match");
    run.type(CTRL_R);
    await run.waitFor((t) => t.includes("→  lancer les tests") && t.includes("2/2"), "older match");
    run.type(KEY.enter);
    await run.waitFor(() => inputLine(run).startsWith("│ › lancer les tests"), "placed in the input");
    await sleep(50);
    expect(p.requests.length).toBe(0);
    await quit(run);
  });

  test("SPEC-IHM-008/CA-06 — two sessions writing at the same time: both entries are kept", () => {
    const ws = workspace();
    const a = store(ws);
    const b = store(ws);
    a.add("de la session A");
    b.add("de la session B");
    a.add("encore A");
    expect(store(ws).entries().map((e) => e.text).sort()).toEqual(["de la session A", "de la session B", "encore A"]);
  });

  test("SPEC-IHM-008/CA-07 — after the clearing command, the history is empty", async () => {
    const ws = workspace();
    store(ws).add("à oublier");
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await send(run, "/history clear");
    await run.waitFor((t) => t.includes("Historique des saisies effacé."), "cleared");
    await run.idle();
    run.type(KEY.up);
    await sleep(80);
    expect(inputLine(run)).toStartWith("│ › Votre message");
    expect(store(ws).entries()).toEqual([]);
    await quit(run);
  });

  test("TECH — SPEC-IHM-008/RG-04, EF-05, ERR-02 — secrets not recorded, bounds and age, an unreadable store put aside", () => {
    const ws = workspace();
    let now = Date.now();
    const h = store(ws, { maxEntries: 2, retentionDays: 1, now: () => now });
    h.add("voici la clé sk-abcdefghijklmnopqrstuvwxyz123456");
    h.add("password=hunter2hunter2");
    expect(h.entries()).toEqual([]);
    expect(containsSecret("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(true);
    expect(containsSecret("un message ordinaire")).toBe(false);
    for (const m of ["un", "deux", "trois"]) h.add(m);
    expect(h.entries().map((e) => e.text)).toEqual(["trois", "deux"]);
    now += 2 * 86_400_000;
    expect(store(ws, { now: () => now, retentionDays: 1 }).entries()).toEqual([]);
    const ws2 = workspace();
    writeFileSync(join(ws2.configHome, "input-history.jsonl"), "pas du json\nnon plus\n");
    const warnings: string[] = [];
    const broken = store(ws2, { warn: (m) => warnings.push(m) });
    expect(warnings).toEqual(["Historique illisible : un nouvel historique a été créé."]);
    broken.add("nouveau");
    expect(broken.entries().map((e) => e.text)).toEqual(["nouveau"]);
    expect(readdirSync(ws2.configHome).some((n) => n.startsWith("input-history.jsonl.illisible-"))).toBe(true);
  });
});

describe("SPEC-IHM-009 completion", () => {
  test("SPEC-IHM-009/CA-01 — SPEC-IHM-009/CA-02 — a slash lists the commands with their descriptions; a typo keeps the expected one", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("/");
    await run.waitFor((t) => t.includes("/clear  Commence une nouvelle conversation") && t.includes("(produit)"), "commands listed");
    run.type("hlep");
    await run.waitFor((t) => t.includes("❯ /help"), "typo tolerated");
    expect(matchQuality("hlep", "help", true)).toBe(4);
    await quit(run);
  });

  test("SPEC-IHM-009/CA-03 — a file outside the allowed scope or excluded by the project is never proposed", async () => {
    const ws = workspace();
    ws.write("project/notes.txt", "n");
    ws.write("project/secret.txt", "s");
    ws.write("project/build/out.txt", "o");
    ws.write("project/.gitignore", "build/\n");
    ws.write("outside.txt", "x");
    const run = interactive(["--deny-rule", "read_file(**/secret.txt)"], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("@");
    await run.waitFor((t) => t.includes("@notes.txt"), "files listed");
    const listed = run.screen().join("\n");
    expect(listed).not.toContain("secret.txt");
    expect(listed).not.toContain("out.txt");
    run.type("../out");
    await sleep(80);
    expect(run.screen().join("\n")).not.toContain("outside.txt");
    await quit(run);
  });

  test("SPEC-IHM-009/CA-04 — SPEC-IHM-009/CA-05 — a selected proposal is inserted without sending; a folder keeps the list open inside it", async () => {
    const ws = workspace();
    ws.write("project/src/app.ts", "a");
    ws.write("project/src/util.ts", "u");
    const p = new ScriptedProvider([]);
    const run = interactive([], ws, { provider: p });
    await run.idle();
    run.type("voir @sr");
    await run.waitFor((t) => t.includes("❯ @src/"), "folder proposed");
    run.type(KEY.enter);
    await run.waitFor(() => inputLine(run).startsWith("│ › voir @src/") && run.screen().join("\n").includes("@src/app.ts"), "inside the folder");
    run.type(TAB);
    await run.waitFor(() => inputLine(run).startsWith("│ › voir @src/app.ts"), "file inserted");
    await sleep(50);
    expect(p.requests.length).toBe(0);
    await quit(run);
  });

  test("SPEC-IHM-009/CA-06 — a very large tree gives partial results quickly, with an indication", async () => {
    const ws = workspace();
    for (let i = 0; i < 60; i++) ws.write(`project/f${String(i).padStart(2, "0")}.txt`, "x");
    const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: { ui: { completion: { maxFileEntries: 20 } } } });
    await run.idle();
    const at = Date.now();
    run.type("@f");
    await run.waitFor((t) => t.includes("Résultats partiels."), "partial results");
    expect(Date.now() - at).toBeLessThan(1500);
    await quit(run);
  });

  test("SPEC-IHM-009/CA-07 — cancelling the list keeps the partial term as it is", async () => {
    const ws = workspace();
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("/he");
    await run.waitFor((t) => t.includes("❯ /help"), "list");
    run.type(KEY.escape);
    await run.waitFor((t) => !t.includes("Tab ou Entrée : insérer"), "closed");
    expect(inputLine(run)).toStartWith("│ › /he ");
    await quit(run);
  });

  test("SPEC-IHM-007/CA-09 — an address in a sentence opens no selection", async () => {
    expect(detectTrigger("écrire à nom@exemple.fr", 23)).toBeUndefined();
    expect(detectTrigger("voir @src", 9)).toEqual({ trigger: "@", start: 5, term: "src" });
    expect(detectTrigger("`code @x`", 8)).toBeUndefined();
    const ws = workspace();
    ws.write("project/exemple.fr", "x");
    const run = interactive([], ws, { provider: new ScriptedProvider([]) });
    await run.idle();
    run.type("écrire à nom@exemple");
    await sleep(100);
    expect(run.screen().join("\n")).not.toContain("Tab ou Entrée : insérer");
    expect(existsSync(join(ws.project, "exemple.fr"))).toBe(true);
    await quit(run);
  });
});
