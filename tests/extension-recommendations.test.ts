// Supports: SPEC-EXT-017/CA-01/02/03, SPEC-EXT-018/CA-01.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { productEnv } from "./helpers/hooks";
import { ExtensionRecommendations } from "../src/extensions/recommendations";
function fixture() {
  const ws = workspace(); ws.write("home/config/catalogs/team/catalog.json", JSON.stringify({ name: "team", extensions: [{ name: "rust-support", description: "Rust language support.", source: "./rust-support", version: "1.0.0" }] }));
  return { ws, config: { extensions: { catalogs: { team: { source: join(ws.root, "catalogue") } }, languageServerRecommendations: { ".rs": { extension: "rust-support@team", binary: "missing-language-server-614", install: "Install the project's configured language server." } } } } };
}
const tag = (ref: string) => `<${loadIdentity().get("HINT_TAG")} v="1" type="extension" value="${ref}"/>`;
const shell = (ref: string) => ({ toolCalls: [{ name: "run_shell", input: { command: `printf '%s\\n' '${tag(ref)}'` } }] });
async function show(ws: ReturnType<typeof workspace>, config: Record<string, unknown>, provider: ScriptedProvider) {
  const controller = new AbortController(), run = interactive(["--approval-mode", "auto_edit", "--allow-rule", "run_shell"], ws, { provider, userConfig: config, env: productEnv(ws), signal: controller.signal });
  await run.idle(); run.type("Run the requested action.\r"); await run.waitFor(text => text.includes("Action complete.")); return { run, controller };
}
test("SPEC-EXT-017/CA-01 — a valid shell hint is removed from model results and displayed with explicit installation choices", async () => {
  const { ws, config } = fixture(), provider = new ScriptedProvider([shell("rust-support@team"), { text: "Action complete." }]), { run, controller } = await show(ws, config, provider);
  try { const screen = run.all().join("\n"); expect(screen).toContain("Extension suggérée : rust-support@team"); expect(screen).toContain("ne-plus"); const results = provider.requests[1]!.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result") : []); expect(results[0]?.isError).toBe(false); expect(JSON.stringify(results)).not.toContain(tag("rust-support@team")); }
  finally { controller.abort(); await run.done; }
}, 15_000);
test("SPEC-EXT-017/CA-02 — a hint from an unconfigured catalogue is stripped without a recommendation", async () => {
  const { ws, config } = fixture(), provider = new ScriptedProvider([shell("rust-support@unknown"), { text: "Action complete." }]), { run, controller } = await show(ws, config, provider);
  try { expect(run.all().join("\n")).not.toContain("Extension suggérée"); const results = provider.requests[1]!.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result") : []); expect(results[0]?.isError).toBe(false); expect(JSON.stringify(results)).not.toContain(tag("rust-support@unknown")); }
  finally { controller.abort(); await run.done; }
}, 15_000);
test("SPEC-EXT-017/CA-03 — permanent refusal persists across sessions and suppresses a repeated hint", async () => {
  const { ws, config } = fixture(), provider = new ScriptedProvider([shell("rust-support@team"), { text: "Action complete." }]), { run, controller } = await show(ws, config, provider);
  try { expect(run.all().join("\n")).toContain("Extension suggérée : rust-support@team"); run.type("/extensions recommandation ne-plus rust-support@team\r"); await run.waitFor(text => text.includes("Choix de recommandation enregistré.")); }
  finally { controller.abort(); await run.done; }
  const next = await show(ws, config, new ScriptedProvider([shell("rust-support@team"), { text: "Action complete." }]));
  try { expect(next.run.all().join("\n")).not.toContain("Extension suggérée"); } finally { next.controller.abort(); await next.run.done; }
}, 15_000);
test("SPEC-EXT-018/CA-01 — five distinct Rust writes without an available server recommend a configured catalogue extension", async () => {
  const { ws, config } = fixture(), provider = new ScriptedProvider([{ toolCalls: Array.from({ length: 5 }, (_, n) => ({ name: "write_file", input: { path: join(ws.project, `file${n}.rs`), content: `fn example${n}() {}\n` } })) }, { text: "Action complete." }]), { run, controller } = await show(ws, config, provider);
  try { expect(run.all().join("\n")).toContain("Extension suggérée : rust-support@team"); expect(run.all().join("\n").replace(/\s+/g, " ")).toContain("sans serveur de langage"); }
  finally { controller.abort(); await run.done; }
}, 15_000);
test("TECH — unattended shell hints are stripped and never initiate installation or recommendation", async () => {
  const { ws, config } = fixture(), provider = new ScriptedProvider([shell("rust-support@team"), { text: "Action complete." }]);
  const run = await cli(["--non-interactive", "--allow-rule", "run_shell", "Run the command."], ws, { provider, userConfig: config, env: productEnv(ws) }); expect(run.code).toBe(0); expect(run.stdout).not.toContain("Extension suggérée");
});

test("TECH — unreadable recommendation preferences do not turn a completed shell command into an error", () => {
  const ws = workspace(); let shown = 0;
  const recommendations = new ExtensionRecommendations({ stateFile: ws.project, enabled: () => true, admitted: () => true, present: () => { shown++; }, clear: () => {}, threshold: () => 5, languages: () => ({}) });
  expect(() => recommendations.recommend("rust-support@team", "Command completed.")).not.toThrow();
  expect(shown).toBe(0);
});
