import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { editExternally } from "../src/interactive/external-editor";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { hook, productEnv } from "./helpers/hooks";
import { Settings } from "../src/config/settings";

test("SPEC-INT-019/CA-01 — the editor closes normally, replaces the draft and removes its private temporary file", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([]); let temporary = "";
  const run = interactive([], ws, { provider, signal: controller.signal, userConfig: { ui: { externalEditor: "fixture-editor" } }, extra: { externalEditorRun: async (_program, args) => {
    temporary = args.at(-1)!; expect(readFileSync(temporary, "utf8")).toBe("brouillon"); writeFileSync(temporary, "texte final"); return 0;
  } } });
  try {
    await run.idle(); run.type("brouillon"); run.type("\u0007"); await run.waitFor(t => t.includes("texte final")); expect(temporary.endsWith(".md")).toBe(true); expect(existsSync(temporary)).toBe(false); expect(provider.requests).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
});

test("SPEC-INT-019/CA-02 — managed encryption refuses the external editor before any temporary file or launch", async () => {
  const ws = workspace(); let launched = 0;
  ws.write("managed/policy.json", JSON.stringify({ storage: { encryption: { enabled: true } } }));
  const policy = Settings.load({ sources: [{ scope: "managed", name: "policy.json", text: readFileSync(ws.managed + "/policy.json", "utf8") }], projectTrusted: true });
  const encryption = policy.get<boolean>("storage.encryption.enabled") && policy.isManaged("storage.encryption.enabled") ? "managed" : "none";
  const before = readdirSync(ws.root), notices: string[] = [];
  const result = await editExternally("protected draft", { command: "fixture-editor", encryption, temporaryRoot: ws.root, maxChars: 100_000, notify: message => notices.push(message), launch: async () => { launched++; return 0; } });
  expect(result).toBeUndefined(); expect(launched).toBe(0); expect(readdirSync(ws.root)).toEqual(before); expect(notices.join("\n")).toContain("chiffrement local est imposé");
});

test("SPEC-IHM-021/CA-02 — a footer timeout keeps the last valid display while the model turn completes", async () => {
  const ws = workspace(), controller = new AbortController(); const count = ws.write("footer-count.txt", "0");
  const command = hook(ws, "footer-timeout", `const fs = await import("node:fs"); const path = ${JSON.stringify(count)}; const calls = Number(fs.readFileSync(path, "utf8")); fs.writeFileSync(path, String(calls + 1)); if(calls) await new Promise(resolve => setTimeout(resolve, 10000)); console.log("Last valid footer");`);
  const run = interactive([], ws, { signal: controller.signal, env: productEnv(ws), provider: new ScriptedProvider([{ text: "Done despite timeout." }]), userConfig: { ui: { footerLine: { command, timeoutMs: 4000 } } } });
  try {
    await run.idle(); await run.waitFor(t => t.includes("Last valid footer")); await sleep(350); run.type("Work."); run.type(KEY.enter);
    await run.waitFor(t => t.includes("Done despite timeout.")); await run.waitFor(t => t.includes("Ligne d’état") && t.includes("délai")); expect(run.screen().join("\n")).toContain("Last valid footer");
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-IHM-024/CA-01 — an invalid binding stays visible as a status notice until its file is corrected", async () => {
  const ws = workspace(), controller = new AbortController();
  const bindings = ws.write("home/config/keybindings.json", JSON.stringify({ bindings: { "input.submit": "definitely-unknown-key" } }));
  const run = interactive([], ws, { provider: new ScriptedProvider([{ text: "A long response. ".repeat(100) }]), signal: controller.signal });
  try {
    await run.idle(); expect(run.screen().join("\n")).toContain("Avis"); run.type("Work."); run.type(KEY.enter); await run.waitFor(t => t.includes("A long response.")); await sleep(50);
    expect(run.screen().join("\n")).toContain("Avis"); writeFileSync(bindings, JSON.stringify({ bindings: {} })); await run.waitFor(() => !run.screen().join("\n").includes("Avis"));
  } finally { controller.abort(); await run.done; }
});
