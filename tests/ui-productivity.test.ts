import { expect, test } from "bun:test";
import { join } from "node:path";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { InputHistory } from "../src/interactive/history";
import { hook, productEnv } from "./helpers/hooks";
import { KeyParser } from "../src/ui/keys";
import { buildKeymap } from "../src/interactive/keymap";

const quick = "\u001b[112;6u", search = "\u001b[102;6u";
const input = (run: ReturnType<typeof interactive>) => run.screen().filter(line => line.includes("› ")).join("\n");

test("TECH — command and shifted control shortcuts remain distinct and customizable", () => {
  const parser = new KeyParser(), events = parser.feed("\u001b[112;10u\u001b[102;6u"), map = buildKeymap({ "app.quickOpen": "ctrl+shift+x" }, { strictConflicts: false }).keymap;
  expect(events[0]).toMatchObject({ kind: "key", name: "p", super: true, shift: true, ctrl: false });
  const custom = parser.feed("\u001b[120;6u")[0]!;
  expect(custom.kind === "key" ? map.action(custom, ["app"]) : undefined).toBe("app.quickOpen");
  expect(events[1]!.kind === "key" ? map.action(events[1]!, ["app"]) : undefined).toBe("app.globalSearch");
});

test("TECH — quick-open secondary action launches only the selected permitted file and preserves the draft", async () => {
  const ws = workspace(), controller = new AbortController(); const path = ws.write("project/selected.ts", "const selected = 1;\n"), launches: readonly string[][] = [];
  const run = interactive([], ws, { signal: controller.signal, provider: new ScriptedProvider([]), userConfig: { ui: { externalEditor: "fixture-editor" } }, extra: { externalEditorRun: async (_program, args) => { (launches as string[][]).push([...args]); return 0; } } });
  try { await run.idle(); run.type("existing draft"); run.type(quick); await run.waitFor(text => text.includes("Ouverture rapide")); await sleep(380); run.type("selected"); run.type("\u0007"); await run.waitFor(() => launches.length === 1); expect(launches[0]).toEqual([path]); expect(input(run)).toContain("existing draft"); expect(input(run)).not.toContain("@selected"); }
  finally { controller.abort(); await run.done; }
});

test("SPEC-CFG-011/CA-01 — one managed announcement is shown with its origin and never sent to the model", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ text: "Done." }]);
  ws.write("managed/policy.json", JSON.stringify({ ui: { announcements: ["First organisation witness", "Second organisation witness", "Third organisation witness"] } }));
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); const shown = run.all().join("\n");
    expect(shown).toContain("Message de votre organisation"); expect(shown.match(/(?:First|Second|Third) organisation witness/g)).toHaveLength(1);
    run.type("Work."); run.type(KEY.enter); await run.waitFor(t => t.includes("Done."));
    expect(JSON.stringify(provider.requests)).not.toContain("organisation witness");
  } finally { controller.abort(); await run.done; }
});

test("SPEC-CFG-011/CA-02 — user announcements are ignored without preventing startup", async () => {
  const controller = new AbortController(), run = interactive([], workspace(), { signal: controller.signal, provider: new ScriptedProvider([]), userConfig: { ui: { announcements: ["Unmanaged announcement witness"] } } });
  try { await run.idle(); expect(run.all().join("\n")).not.toContain("Unmanaged announcement witness"); }
  finally { controller.abort(); await run.done; }
});

test("SPEC-IHM-015/CA-01 — quick open cancellation preserves the complete draft and consumes no model request", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([]); ws.write("project/note.ts", "const note = 1;\n");
  const run = interactive([], ws, { signal: controller.signal, provider });
  try {
    await run.idle(); run.type("draft migration"); run.type(quick); await run.waitFor(t => t.includes("Ouverture rapide"));
    await sleep(380); run.type(KEY.escape); await run.waitFor(() => input(run).includes("draft migration")); expect(provider.requests).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
});

test("SPEC-IHM-015/CA-02 — a pending permission prevents the global quick-open shortcut", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: join(ws.project, "new.txt"), content: "new" } }] }, { text: "Stopped." }]);
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("Write."); run.type(KEY.enter); await run.waitFor(t => t.includes("Autorisation requise")); run.type(quick); await sleep(50);
    expect(run.screen().join("\n")).not.toContain("Ouverture rapide"); expect(run.screen().join("\n")).toContain("Autorisation requise");
  } finally { controller.abort(); await run.done; }
});

test("SPEC-IHM-018/CA-01 — validating a global match inserts its file and exact line without sending", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([]); ws.write("project/source.ts", "const first = 1;\nconst migrationWitness = first;\n");
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type(search); await run.waitFor(t => t.includes("Recherche globale")); await sleep(380); run.type("migrationWitness");
    await run.waitFor(t => t.includes("source.ts:2")); run.type(KEY.enter); await run.waitFor(() => input(run).includes("source.ts:2")); expect(input(run)).toContain("@"); expect(provider.requests).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
});

test("SPEC-IHM-018/CA-02 — ignored and denied files are absent from the actual quick-open results", async () => {
  const ws = workspace(), controller = new AbortController(); ws.write("project/.gitignore", "ignored.ts\n"); ws.write("project/ignored.ts", "hidden"); ws.write("project/denied.ts", "denied"); ws.write("project/visible.ts", "visible");
  const run = interactive([], ws, { provider: new ScriptedProvider([]), signal: controller.signal, userConfig: { permissions: { denyRules: ["read_file(denied.ts)"] } } });
  try { await run.idle(); run.type(quick); await run.waitFor(t => t.includes("visible.ts")); const screen = run.screen().join("\n"); expect(screen).not.toMatch(/\d+\.\s*ignored\.ts/); expect(screen).not.toMatch(/\d+\.\s*denied\.ts/); }
  finally { controller.abort(); await run.done; }
});

test("SPEC-IHM-016/CA-01 — the existing input filters the history selector and selection inserts a full multiline entry", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([]);
  const history = new InputHistory({ path: join(ws.configHome, "input-history.jsonl"), dir: ws.project, scope: "folder", maxEntries: 5000, retentionDays: 90, enabled: true, warn: () => {} });
  history.add("unrelated change"); history.add("migration first\nsecond line");
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("migration"); run.type("\u001b[114;6u"); await run.waitFor(t => t.includes("Filtrer mes saisies"));
    expect(run.screen().join("\n")).not.toContain("unrelated change"); await sleep(380); run.type(KEY.enter); await run.waitFor(t => t.includes("second line")); expect(provider.requests).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
});

test("SPEC-IHM-021/CA-01 — the footer command receives model data after a turn and shows its first line", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ text: "Done." }]);
  const command = hook(ws, "footer", 'console.log("Custom model: " + payload.model.id + (payload.durationMs > 0 ? " — completed" : " — initial")); console.log("ignored second line");');
  const run = interactive([], ws, { provider, signal: controller.signal, env: productEnv(ws), userConfig: { ui: { footerLine: { command } } } });
  try {
    await run.idle(); run.type("Work."); run.type(KEY.enter); await run.waitFor(t => t.includes("Custom model: test-medium — completed"));
    expect(provider.requests).toHaveLength(1);
    expect(run.screen().join("\n")).toContain("mode : ask"); expect(run.screen().join("\n")).not.toContain("ignored second line");
  } finally { controller.abort(); await run.done; }
}, 15_000);
