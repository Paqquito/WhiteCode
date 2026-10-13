import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Identity } from "../src/identity/identity";
import { TranscriptWriter } from "../src/session/transcript";

test("SPEC-IHM-025/CA-01 — the welcome shows the alternative identity and configured model", async () => {
  const ws = workspace(), identity = loadIdentity("identity/test-omega.identity.json"), controller = new AbortController();
  const run = interactive([], ws, { identity, provider: new ScriptedProvider([]), signal: controller.signal });
  try { await run.idle(); await run.waitFor(t => t.includes(identity.get("PRODUCT"))); expect(run.all().join("\n")).toContain("0.1.0"); expect(run.all().join("\n")).toContain("Modèle : test-medium"); }
  finally { controller.abort(); await run.done; }
});

test("SPEC-IHM-025/CA-02 — changed versions show actual installed notes once per user state", async () => {
  const ws = workspace();
  for (const [version, news] of [["0.2.0", true], ["0.2.0", false], ["0.3.0", true]] as const) {
    const identity = new Identity({ ...loadIdentity().resolved, version }), controller = new AbortController();
    const run = interactive([], ws, { identity, provider: new ScriptedProvider([]), signal: controller.signal });
    try { await run.idle(); await sleep(100); expect(run.all().join("\n").includes("Nouveautés disponibles")).toBe(news); }
    finally { controller.abort(); await run.done; }
  }
});

test("SPEC-CMD-053/CA-01 — offline release notes read the local cache without any provider call", async () => {
  const ws = workspace(), provider = new ScriptedProvider([]);
  writeFileSync(join(ws.configHome, "release-notes.json"), JSON.stringify({ text: "Cached release witness\n<script>alert(1)</script>" }));
  const result = await cli(["--non-interactive", "/release-notes"], ws, { provider });
  expect(result.code).toBe(0); expect(result.stdout).toContain("Cached release witness"); expect(result.stdout).toContain("Version installée : 0.1.0"); expect(provider.requests).toHaveLength(0);
});

test("SPEC-IHM-036/CA-01 — pending human permission changes the terminal title and cleanup restores its stack", async () => {
  const ws = workspace(), controller = new AbortController(); let output = "";
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: join(ws.project, "note.txt"), content: "note" } }] }, { text: "done" }]);
  const run = interactive([], ws, { provider, signal: controller.signal });
  const write = run.term.write; run.term.write = data => { output += data; write(data); };
  try {
    await run.idle(); run.type("write a note"); run.type(KEY.enter); await run.waitFor(t => t.includes("Autorisation requise"));
    expect(output).toMatch(/\u001b\]0;En attente [^\u0007]* — Pilote Dev\u0007/); expect(output).not.toContain("write a note —");
    await sleep(380); run.type(KEY.escape); await run.idle(); expect(output).toMatch(/\u001b\]0;Prêt [^\u0007]* — Pilote Dev\u0007/);
  } finally { controller.abort(); await run.done; }
  expect(output).toContain("\u001b[22;0t"); expect(output).toContain("\u001b[23;0t");
});

test("TECH — disabled terminal titles also suppress manual retitling", async () => {
  const ws = workspace(), controller = new AbortController(); let output = "";
  const run = interactive([], ws, { provider: new ScriptedProvider([]), signal: controller.signal, userConfig: { ui: { terminalTitle: false } } });
  const write = run.term.write; run.term.write = data => { output += data; write(data); };
  try { await run.idle(); run.type("/retitle example"); run.type(KEY.enter); await run.waitFor(t => t.includes("Titre de la session : example")); expect(output).not.toContain("\u001b]0;"); }
  finally { controller.abort(); await run.done; }
});

test("SPEC-SES-001/CA-09 — a persisted session remains readable when the provider is unavailable", async () => {
  const ws = workspace(), writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project });
  writer.append("session_meta", {}); writer.append("user", { content: [{ type: "text", text: "offline transcript witness" }] });
  writer.append("assistant", { content: [{ type: "text", text: "retained offline reply" }], text: "retained offline reply", toolCalls: [] }); writer.close();
  const provider = new ScriptedProvider([]), controller = new AbortController();
  const run = interactive([`--reopen=${writer.sessionId}`], ws, { provider, signal: controller.signal, userConfig: { ui: { replayOnResume: "full" } } });
  try { await run.idle(); await run.waitFor(t => t.includes("offline transcript witness")); expect(run.all().join("\n")).toContain("retained offline reply"); expect(provider.requests).toHaveLength(0); }
  finally { controller.abort(); await run.done; }
});
