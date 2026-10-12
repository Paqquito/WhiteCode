// Acceptance of model locks and theme previews through the real interactive driver.
import { expect, test } from "bun:test";
import { readFileSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { interactive, KEY, sleep, type InteractiveRun } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { contrast, resolveTheme, THEMES } from "../src/ui/theme";
import { bunCommand, productEnv } from "./helpers/hooks";

const styleOfInput = (run: InteractiveRun) => {
  const row = run.term.vt.grid.find((r) => /Votre message|Message à mettre en file/.test(r.map((c) => c.ch).join("")));
  return row?.find((c) => c.ch === "V" || c.ch === "M")?.sgr;
};
const exit = async (run: InteractiveRun) => { run.type(KEY.ctrlD); run.type(KEY.ctrlD); await run.done; };

test("SPEC-IHM-019/CA-01 — a managed model: alternatives stay locked and name their policy source", async () => {
  const ws = workspace(), p = new ScriptedProvider([{ text: "modèle conservé" }]);
  const policy = ws.write("managed/policy.json", JSON.stringify({ models: { selected: "large" } }));
  const run = interactive([], ws, { provider: p, rows: 40 });
  await run.idle(); run.type("/switch-model"); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("Choisir le modèle"));
  expect(run.screen().join("\n")).toContain("verrouillé");
  expect(run.screen().join("\n")).toContain(policy);
  await sleep(350); run.type(KEY.down); run.type(KEY.enter); await sleep(80);
  expect(run.screen().join("\n")).toContain("Choisir le modèle");
  run.type(KEY.escape); await sleep(80);
  run.type("/switch-model small"); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("imposé"));
  run.type("question"); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("modèle conservé"));
  expect(p.requests.map((r) => r.model.id)).toEqual(["test-large"]);
  await exit(run);
}, 20_000);

test("TECH — terminating during a theme preview cancels the dialog without persisting it", async () => {
  const ws = workspace(), controller = new AbortController();
  const run = interactive([], ws, { provider: new ScriptedProvider([]), signal: controller.signal, userConfig: { ui: { theme: "dark", colorMode: "truecolor" } } });
  await run.idle(); const original = readFileSync(join(ws.configHome, "config.json"), "utf8");
  run.type("/appearance"); run.type(KEY.enter); await run.waitFor((t) => t.includes("Choisir le thème"));
  await sleep(350); run.type(KEY.down); await sleep(80); controller.abort();
  await run.done;
  expect(readFileSync(join(ws.configHome, "config.json"), "utf8")).toBe(original);
}, 20_000);

test("TECH — theme persistence fails: preview remains active for this session with an explicit warning", async () => {
  const ws = workspace();
  const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: { ui: { theme: "dark", colorMode: "truecolor" } } });
  await run.idle(); run.type("/appearance"); run.type(KEY.enter); await run.waitFor((t) => t.includes("Choisir le thème"));
  await sleep(350); run.type(KEY.down); await sleep(80);
  const settingsPath = join(ws.configHome, "config.json"), savedPath = join(ws.configHome, "saved-config.json");
  const original = readFileSync(settingsPath, "utf8"); renameSync(settingsPath, savedPath); mkdirSync(settingsPath);
  run.type(KEY.enter); await run.waitFor((t) => t.includes("pour cette session seulement"));
  expect(styleOfInput(run)).toContain("48;2;255;255;255");
  expect(readFileSync(savedPath, "utf8")).toBe(original); await exit(run);
}, 20_000);

test("SPEC-IHM-020/CA-02, SPEC-IHM-005/CA-07 — an accessible difference approved in the terminal: blue additions, amber deletions and the exact displayed content written", async () => {
  for (const colorMode of ["truecolor", "16", "none"]) {
  const ws = workspace();
  const path = ws.write("project/code.ts", 'const value = "ancien";\n');
  const replacement = 'const value = "nouveau";\n';
  const p = new ScriptedProvider([
    { toolCalls: [{ name: "read_file", input: { path } }] },
    { toolCalls: [{ name: "write_file", input: { path, content: replacement } }] },
    { text: "modification terminée" },
  ]);
  const run = interactive([], ws, { provider: p, rows: 40, userConfig: { ui: { theme: colorMode === "16" ? "light-accessible" : "dark-accessible", colorMode } } });
  await run.idle(); run.type("change la valeur"); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("Autorisation requise"));
  const rows = run.term.vt.grid;
  const addition = rows.find((r) => r.map((c) => c.ch).join("").includes('"nouveau"'))!;
  const deletion = rows.find((r) => r.some((c) => c.ch === "-") && r.map((c) => c.ch).join("").includes('"ancien"'))!;
  const addStyle = addition.find((c) => c.ch === "+")!.sgr, delStyle = deletion.find((c) => c.ch === "-")!.sgr;
  if (colorMode === "truecolor") { expect(addStyle).toContain("38;2;115;180;255"); expect(delStyle).toContain("38;2;255;195;105"); }
  else if (colorMode === "16") { expect(addStyle.split(";")).toContain("34"); expect(delStyle.split(";")).toContain("33"); }
  else { expect(addStyle).toBe("1"); expect(delStyle).toBe("1"); }
  expect(readFileSync(path, "utf8")).toBe('const value = "ancien";\n');
  await sleep(350); run.type("1"); await run.waitFor((t) => t.includes("modification terminée"));
  expect(readFileSync(path, "utf8")).toBe(replacement); await exit(run);
  }
}, 20_000);

test("TECH — reopening an old small-model session under a large-model policy uses the imposed model", async () => {
  const ws = workspace();
  expect((await cli(["--non-interactive", "--model", "small", "premier"], ws, { provider: new ScriptedProvider([{ text: "ancienne session" }]) })).code).toBe(0);
  ws.write("managed/policy.json", JSON.stringify({ models: { selected: "large" } }));
  const p = new ScriptedProvider([{ text: "modèle imposé après reprise" }]), run = interactive(["--reopen-last"], ws, { provider: p });
  await run.idle(); run.type("question"); run.type(KEY.enter); await run.waitFor((t) => t.includes("modèle imposé après reprise"));
  expect(p.requests[0]!.model.id).toBe("test-large"); await exit(run);
}, 20_000);

test("TECH — a policy added during model persistence confirmation refuses the previous choice", async () => {
  const ws = workspace();
  const p = new ScriptedProvider([]), run = interactive([], ws, { provider: p, rows: 40 });
  await run.idle(); run.type("/switch-model"); run.type(KEY.enter); await run.waitFor((t) => t.includes("Choisir le modèle"));
  await sleep(350); run.type(KEY.enter); await run.waitFor((t) => t.includes("Enregistrer ce modèle"));
  ws.write("managed/policy.json", JSON.stringify({ models: { selected: "large" } }));
  await sleep(350); run.type("n"); await run.waitFor((t) => t.includes("Modèle imposé"));
  expect(run.all().join("\n")).not.toContain("prochaine requête");
  run.type("question"); run.type(KEY.enter); await run.waitFor((t) => t.includes("redémarrage"));
  expect(p.requests).toHaveLength(0); await exit(run);
}, 20_000);

test("TECH — a managed allow list narrowed during a selector prevents the next disallowed request", async () => {
  const ws = workspace();
  const policy = ws.write("managed/policy.json", JSON.stringify({ models: { allowList: ["medium", "small"] } }));
  const p = new ScriptedProvider([]), run = interactive([], ws, { provider: p });
  await run.idle(); run.type("/switch-model"); run.type(KEY.enter); await run.waitFor((t) => t.includes("Choisir le modèle"));
  writeFileSync(policy, JSON.stringify({ models: { allowList: ["small"] } }));
  await sleep(350); run.type(KEY.escape); await sleep(80); run.type("question"); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("n'est plus autorisé")); expect(p.requests).toHaveLength(0); await exit(run);
}, 20_000);

test("TECH — a large model list scrolls to the selected option with its navigation hint visible", async () => {
  const ws = workspace();
  const extraCatalog = Array.from({ length: 20 }, (_, i) => ({ id: `local-${i}`, provider: "openai_compatible", family: "local", label: `Local ${i}`, contextWindow: 8192, maxOutputTokens: 2048, capabilities: { toolCalling: true } }));
  const run = interactive([], ws, { provider: new ScriptedProvider([]), rows: 24, userConfig: { models: { extraCatalog } } });
  await run.idle(); run.type("/switch-model"); run.type(KEY.enter); await run.waitFor((t) => t.includes("Choisir le modèle"));
  await sleep(350); for (let i = 0; i < 22; i++) run.type(KEY.down); await sleep(80);
  const screen = run.screen().join("\n");
  expect(screen).toContain("❯ 24. local-19"); expect(screen).toContain("options"); expect(screen).toContain("Échap : sans réponse");
  run.type(KEY.escape); await sleep(80); await exit(run);
}, 20_000);

test("TECH — every foreground token and near-background brand accent has a contrast of at least 4.5", () => {
  for (const theme of THEMES) for (const brand of ["#101820", "#ffffff", "#808080", "#00ff00"]) {
    const resolved = resolveTheme(theme.id, brand);
    expect("rgb" in resolved.background).toBe(true);
    for (const color of [resolved.text, ...resolved.palette]) {
      expect("rgb" in color).toBe(true);
      if ("rgb" in color && "rgb" in resolved.background) expect(contrast(color.rgb, resolved.background.rgb)).toBeGreaterThanOrEqual(4.5);
    }
  }
});

test("SPEC-IHM-019/CA-02, SPEC-CMD-072/CA-01 — a live light preview cancelled: original dark colours and settings return", async () => {
  const ws = workspace(), p = new ScriptedProvider([]);
  const run = interactive([], ws, { provider: p, userConfig: { ui: { theme: "dark", colorMode: "truecolor" } } });
  await run.idle(); const before = styleOfInput(run), settings = readFileSync(join(ws.configHome, "config.json"), "utf8");
  expect(before).toBeDefined(); run.type("/appearance"); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("Choisir le thème"));
  await sleep(350); run.type(KEY.down); await sleep(80);
  expect(styleOfInput(run)).toContain("48;2;255;255;255");
  expect(styleOfInput(run)).not.toBe(before);
  run.type(KEY.escape); await sleep(80);
  expect(styleOfInput(run)).toBe(before);
  expect(readFileSync(join(ws.configHome, "config.json"), "utf8")).toBe(settings);
  expect(p.requests).toHaveLength(0); await exit(run);
}, 20_000);

test("TECH — the selected theme is persisted and used on the next interactive launch", async () => {
  const ws = workspace();
  const run = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: { ui: { theme: "dark", colorMode: "truecolor" } } });
  await run.idle(); run.type("/appearance"); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("Choisir le thème"));
  await sleep(350); run.type(KEY.down); await sleep(80); const preview = styleOfInput(run);
  expect(preview).toBeDefined();
  run.type(KEY.enter); await run.waitFor((t) => t.includes("Thème enregistré"));
  const config = JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8"));
  expect(config.ui.theme).toBe("light"); await exit(run);
  const next = interactive([], ws, { provider: new ScriptedProvider([]), userConfig: config });
  await next.idle(); expect(styleOfInput(next)).toBe(preview); await exit(next);
}, 20_000);

test("SPEC-MOD-001/CA-06 — leaving with an active background task: confirmation before it is stopped", async () => {
  const ws = workspace();
  const command = bunCommand(ws.write("scripts/long.ts", 'console.log("tâche prête"); await Bun.sleep(60_000);').replace(/\\/g, "/"));
  const p = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command, detached: true, description: "travail de fond" } }] }, { text: "tâche démarrée" }]);
  const run = interactive(["--allow-rule", "run_shell"], ws, { provider: p, env: productEnv(ws) });
  await run.idle(); run.type("lance le travail"); run.type(KEY.enter); await run.waitFor((t) => t.includes("tâche démarrée"));
  run.type("/exit"); run.type(KEY.enter); await run.waitFor((t) => t.includes("tâche de fond sera arrêtée"));
  expect(run.finished()).toBe(false); await sleep(350); run.type("n"); await sleep(100);
  expect(run.finished()).toBe(false);
  run.type("/exit"); run.type(KEY.enter); await sleep(350); run.type("y");
  const result = await run.done;
  expect(result.code).toBe(0); expect(result.stderr).toContain("Tâches de fond arrêtées");
}, 20_000);

test("TECH — an unlocked model selector changes only the next request and offers user persistence", async () => {
  const ws = workspace(), p = new ScriptedProvider([{ text: "avant" }, { text: "après" }]);
  const run = interactive([], ws, { provider: p, rows: 40 });
  await run.idle(); run.type("premier"); run.type(KEY.enter); await run.waitFor((t) => t.includes("avant"));
  run.type("/switch-model"); run.type(KEY.enter); await run.waitFor((t) => t.includes("Choisir le modèle"));
  await sleep(350); run.type(KEY.down); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("Enregistrer ce modèle")); await sleep(350); run.type("n");
  await run.waitFor((t) => t.includes("prochaine requête")); run.type("second"); run.type(KEY.enter);
  await run.waitFor((t) => t.includes("après"));
  expect(p.requests.map((r) => r.model.id)).toEqual(["test-medium", "test-small"]);
  expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).models?.selected).toBeUndefined();
  await exit(run);
}, 20_000);
