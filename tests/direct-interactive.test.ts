import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

async function withUi(provider: ScriptedProvider, action: (ui: ReturnType<typeof interactive>, serverWorkspace: ReturnType<typeof workspace>) => Promise<void>): Promise<void> {
  const serverWorkspace = workspace(), clientWorkspace = workspace(), abort = new AbortController(), clientAbort = new AbortController();
  const token = Buffer.from("direct-ui-fixture-never-a-real-key").toString("base64url"), file = serverWorkspace.write("token", token), prefix = loadIdentity().get("ENV_PREFIX");
  let ready!: (address: string) => void; const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--credential-file", file], serverWorkspace, { provider, extra: { signal: abort.signal }, onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); } });
  let ui: ReturnType<typeof interactive> | undefined;
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited."); })]);
    ui = interactive(["direct-server", "connect", endpoint], clientWorkspace, { env: { [prefix + "SERVER_TOKEN"]: token }, signal: clientAbort.signal });
    await ui.idle(); await action(ui, serverWorkspace);
  } finally { clientAbort.abort(); await ui?.done; abort.abort(); await server; }
}

test("TECH — the direct UI releases queued input and completes local command views without another model call", async () => {
  const provider = new ScriptedProvider([{ text: "FIRST_STREAM", delayMs: 500 }, { text: "SECOND_QUEUED_COMPLETE" }]);
  await withUi(provider, async (ui, ws) => {
    ui.type("First message." + KEY.enter); await ui.waitFor(text => text.includes("FIRST_STREAM"));
    ui.type("Second queued message." + KEY.enter); await ui.waitFor(text => text.includes("SECOND_QUEUED_COMPLETE"));
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1]!.history)).toContain("Second queued message.");
    ui.type("/help" + KEY.enter); await ui.waitFor(text => text.includes("/context-usage"));
    ui.type("/switch-model test-small" + KEY.enter); await ui.waitFor(() => ui.screen().join("\n").includes("· test-small ·"));
    ui.type("/switch-model test-small default" + KEY.enter); await ui.waitFor(text => text.includes("ne modifie pas le modèle par défaut"));
    expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).models.selected).toBeUndefined(); expect(provider.requests).toHaveLength(2);
    ui.type("/exit" + KEY.enter); expect((await ui.done).code).toBe(0);
  });
}, 15000);

test("TECH — interrupting a streamed direct turn cancels the server provider and leaves the next UI turn usable", async () => {
  const provider = new ScriptedProvider([{ hang: true }, { text: "AFTER_STREAM_CANCEL" }]);
  await withUi(provider, async ui => {
    ui.type("Wait until I interrupt." + KEY.enter); await ui.waitFor(() => provider.requests.length === 1);
    ui.type(KEY.ctrlC); await ui.waitFor(text => text.includes("Interrompu par l'utilisateur"));
    ui.type("Next message." + KEY.enter); await ui.waitFor(text => text.includes("AFTER_STREAM_CANCEL"));
    expect(provider.requests).toHaveLength(2); ui.type("/exit" + KEY.enter); expect((await ui.done).code).toBe(0);
  });
}, 15000);

test("TECH — refusing a direct approval with stop cancels the server turn and clears the dialog", async () => {
  let target = "";
  const provider = new ScriptedProvider([() => ({ toolCalls: [{ name: "write_file", input: { path: target, content: "MUST_NOT_BE_WRITTEN" } }] }), { text: "AFTER_PERMISSION_CANCEL" }]);
  await withUi(provider, async (ui, ws) => {
    target = join(ws.project, "must-not-be-written.txt");
    ui.type("Request a write and stop when I refuse." + KEY.enter);
    await ui.waitFor(text => text.includes("Autorisation requise"));
    await new Promise(resolve => setTimeout(resolve, 370)); ui.type(KEY.ctrlC);
    await ui.waitFor(text => text.includes("Interrompu par l'utilisateur"), "remote approval cancellation", 2500);
    expect(existsSync(target)).toBe(false); expect(provider.requests).toHaveLength(1);
    expect(ui.screen().join("\n")).not.toContain("Autorisation requise");
    ui.type("Next permitted message." + KEY.enter); await ui.waitFor(text => text.includes("AFTER_PERMISSION_CANCEL"));
    expect(provider.requests).toHaveLength(2); ui.type("/exit" + KEY.enter); expect((await ui.done).code).toBe(0);
  });
}, 15000);
