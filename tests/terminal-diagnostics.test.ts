import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Identity } from "../src/identity/identity";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { VTerm } from "./helpers/vterm";

const prefix = loadIdentity().get("ENV_PREFIX");
test("SPEC-OBS-012/CA-03 — encrypted ephemeral mode keeps default debug output limited to technical metadata", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "SECRET_RESPONSE_WITNESS" }]);
  const result = await cli(["--ephemeral", "--non-interactive", "--debug", "api", "SECRET_REQUEST_WITNESS"], ws, { provider, userConfig: { storage: { encryption: { enabled: true } } } });
  expect(result.code).toBe(0); const log = readFileSync(join(ws.configHome, "debug.log"), "utf8");
  expect(log).toContain("[api]"); expect(log).not.toContain("SECRET_REQUEST_WITNESS"); expect(log).not.toContain("SECRET_RESPONSE_WITNESS");
});
test("SPEC-OBS-012/CA-04 — an explicit debug export in encrypted ephemeral mode is announced as unencrypted", async () => {
  const ws = workspace(), path = join(ws.root, "explicit.log");
  const result = await cli(["--ephemeral", "--non-interactive", "--debug", "api", "--debug-output", path, "Work."], ws, { provider: new ScriptedProvider([{ text: "done" }]), userConfig: { storage: { encryption: { enabled: true } } } });
  expect(result.code).toBe(0); expect(result.stderr).toContain("non chiffré"); expect(result.stderr).toContain(path); expect(existsSync(path)).toBe(true);
});

test("SPEC-IHM-023/CA-01 — a long-turn tip names the configured transcription shortcut", async () => {
  const controller = new AbortController(), provider = new ScriptedProvider([{ text: "TIP_DONE", delayMs: 1000 }]);
  const run = interactive([], workspace(), { provider, signal: controller.signal, userConfig: { ui: { keybindings: { bindings: { "view.transcript": "alt+u" } } } } });
  try { await run.idle(); run.type("Work." + KEY.enter); await run.waitFor(text => text.includes("Astuce : Alt+U pour consulter la transcription")); expect(run.screen().join("\n")).not.toContain("Astuce : Alt+T"); }
  finally { controller.abort(); await run.done; }
});

test("SPEC-OBS-016/CA-01 — session recording produces an ordered asciicast v2 replay of real terminal writes", async () => {
  const ws = workspace(), controller = new AbortController(), path = join(ws.root, "session.cast");
  const run = interactive([], ws, { provider: new ScriptedProvider([{ text: "RECORDED_ANSWER" }]), signal: controller.signal, env: { [`${prefix}SESSION_RECORDING`]: path } });
  try { await run.idle(); run.term.resize(90, 26); run.type("Recorded request." + KEY.enter); await run.waitFor(text => text.includes("RECORDED_ANSWER")); }
  finally { controller.abort(); await run.done; }
  const rows = readFileSync(path, "utf8").trimEnd().split("\n").map(row => JSON.parse(row));
  expect(rows[0]).toMatchObject({ version: 2, width: 100, height: 30 }); expect(rows.length).toBeGreaterThan(3);
  let previous = 0; for (const row of rows.slice(1)) { expect(row[0]).toBeGreaterThanOrEqual(previous); previous = row[0]; expect(["o", "r"]).toContain(row[1]); }
  expect(rows.slice(1).map(row => row[2]).join("")).toContain("RECORDED_ANSWER"); expect(rows.slice(1).some(row => row[1] === "i")).toBe(false);
  expect(rows.slice(1)).toContainEqual([expect.any(Number), "r", "90x26"]);
  const replay = new VTerm(rows[0].width, rows[0].height);
  for (const row of rows.slice(1)) { if (row[1] === "o") replay.write(row[2]); else { const [width, height] = row[2].split("x").map(Number); replay.resize(width, height); } }
  expect(replay.all().join("\n")).toContain("RECORDED_ANSWER");
});

test("TECH — terminal recording refuses to overwrite an existing destination", async () => {
  const ws = workspace(), file = ws.write("project/existing.cast", "ORIGINAL_RECORDING");
  const result = await cli(["--non-interactive", "Work."], ws, { provider: new ScriptedProvider([{ text: "DONE" }]), env: { [`${prefix}SESSION_RECORDING`]: file } });
  expect(result.code).toBe(0); expect(result.stderr).toContain("Enregistrement indisponible"); expect(readFileSync(file, "utf8")).toBe("ORIGINAL_RECORDING");
});

function serviceIdentity(values: Record<string, string>): Identity { const old = loadIdentity().resolved; return new Identity({ ...old, values: { ...old.values, ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value, origin: "provided" as const }])) } }); }
test("SPEC-CMD-008/CA-01 — an absent browser extension shows the identity-specific installation instructions", async () => {
  const result = await cli(["--non-interactive", "/browser"], workspace(), { provider: new ScriptedProvider([]), identity: serviceIdentity({ SERVICE_BROWSER_EXTENSION: "https://extensions.fixture.test/install" }) });
  expect(result.code).toBe(0); expect(result.stdout + result.stderr).toContain("Installez l’extension"); expect(result.stdout + result.stderr).toContain("https://extensions.fixture.test/install");
});
test("SPEC-CMD-036/CA-01 — install-chat-app opens the configured documentation page without sending conversation data", async () => {
  const opened: string[] = [], controller = new AbortController(), provider = new ScriptedProvider([]);
  const run = interactive([], workspace(), { provider, identity: serviceIdentity({ SERVICE_DOCS: "https://docs.fixture.test/", TEAM_CHAT_APP: "team-app" }), signal: controller.signal, extra: { openServiceUrl: url => { opened.push(url); return true; } } });
  try { await run.idle(); run.type("/install-chat-app" + KEY.enter); await run.waitFor(text => text.includes("Page d’installation ouverte"));
    expect(opened).toEqual(["https://docs.fixture.test/integrations/team-chat/install?app=team-app"]); expect(provider.requests).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
});
