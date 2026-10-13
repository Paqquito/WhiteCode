import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { workspace, cli } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { sleep } from "./helpers/interactive";
import { parseLoop } from "../src/schedule/loop";
import { readKeybindingsFile } from "../src/interactive/keybindings-file";
import { buildKeymap } from "../src/interactive/keymap";
async function requests(provider: ScriptedProvider, count: number) { const end = Date.now() + 6000; while (provider.requests.length < count && Date.now() < end) await sleep(20); expect(provider.requests).toHaveLength(count); }
test("SPEC-EXT-024/CA-01 — the actual loop command submits three ordinary iterations over fifteen clock minutes", async () => {
  const ws = workspace(); let time = 0;
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "schedule_create", input: { intervalSeconds: 300, prompt: "vérifie le statut", durable: false } }] }, { text: "boucle installée" }, { text: "itération 1" }, { text: "itération 2" }, { text: "itération 3" }]);
  const host = new Host(ws, { provider, argv: ["--allow-project-trust"], extra: { scheduleNow: () => time } });
  try { host.user("/loop 5m vérifie le statut"); await host.waitFor(m => m.type === "turn_completed" && JSON.stringify(m).includes("boucle installée")); expect(JSON.stringify(provider.requests[0]?.history)).toContain("Requested intervalSeconds: 300");
    for (let n = 1; n <= 3; n++) { time = n * 300_000; await host.waitFor(m => m.type === "turn_completed" && JSON.stringify(m).includes(`itération ${n}`)); }
    expect(provider.requests).toHaveLength(5); expect(JSON.stringify(provider.requests[4]?.history)).toContain("Scheduled prompt");
  } finally { host.feed.end(); await host.finish(); }
}, 15_000);
test("SPEC-EXT-024/CA-02 — a running iteration skips the next deadline and resumes at the following one", async () => {
  let time = 0; const provider = new ScriptedProvider([{ toolCalls: [{ name: "schedule_create", input: { intervalSeconds: 300, prompt: "long check" } }] }, { text: "ready" }, { text: "long iteration", delayMs: 2500 }, { text: "following iteration" }]);
  const host = new Host(workspace(), { provider, argv: ["--allow-project-trust"], extra: { scheduleNow: () => time } });
  try { host.user("/loop 5m check"); await host.waitFor(m => m.type === "turn_completed" && JSON.stringify(m).includes("ready")); time = 300_000; await requests(provider, 3); time = 600_000; await sleep(1200); expect(provider.requests).toHaveLength(3); await host.waitFor(m => m.type === "turn_completed" && JSON.stringify(m).includes("long iteration")); time = 900_000; await host.waitFor(m => m.type === "turn_completed" && JSON.stringify(m).includes("following iteration")); expect(provider.requests).toHaveLength(4);
  } finally { host.feed.end(); await host.finish(); }
}, 15_000);
test("SPEC-EXT-023/CA-01 — the model loads the actual action catalogue before an approved valid shortcut write", async () => {
  const ws = workspace(), path = ws.write("home/config/keybindings.json", '{"bindings":{"input.submit":"ctrl+s"}}'), provider = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "shortcut-help" } }] }, { toolCalls: [{ name: "read_file", input: { path } }] }, { toolCalls: [{ name: "write_file", input: { path, content: '{"bindings":{"input.submit":"ctrl+enter"}}' } }] }, { text: "shortcut saved" }]);
  let approvals = 0; const host = new Host(ws, { provider, argv: ["--approval-mode", "ask"], init: { decisionAuthority: true }, answers: { approval_request: () => { approvals++; return { decision: "allow" }; } } });
  try { host.user("Change the send key to ctrl+enter."); await host.waitFor(m => m.type === "turn_completed" && JSON.stringify(m).includes("shortcut saved"));
    const context = JSON.stringify(provider.requests[1]?.history); expect(context).toContain("Current action catalogue"); expect(context).toContain("input.submit"); expect(context).toContain("ctrl+s"); expect(context).not.toContain("{%KEYBINDINGS"); expect(approvals).toBe(1); const parsed = readKeybindingsFile(path); expect(parsed.error).toBeUndefined(); expect(buildKeymap(parsed.bindings, { strictConflicts: false }).keymap.effective("input.submit")).toEqual(["ctrl+enter"]); expect(readFileSync(path, "utf8")).toContain("ctrl+enter");
  } finally { host.feed.end(); await host.finish(); }
});
test("TECH — loop syntax is bounded, invalid requests create no trigger, and shortcut help stays model-only", async () => {
  expect(parseLoop("check").seconds).toBe(600); expect(parseLoop("30s check").seconds).toBe(30); for (const value of ["", "1s check", "25h check", "5m"]) expect(() => parseLoop(value)).toThrow();
  const ws = workspace(), provider = new ScriptedProvider([]); const result = await cli(["--non-interactive", "--allow-project-trust", "/loop 1s check"], ws, { provider }); expect(result.code).not.toBe(0); expect(provider.requests).toHaveLength(0); expect(existsSync(join(ws.project, "schedules.json"))).toBe(false);
  const hidden = await cli(["--non-interactive", "/shortcut-help"], workspace(), { provider: new ScriptedProvider([]) }); expect(hidden.stdout + hidden.stderr).toContain("inconnue");
  const absent = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "shortcut-help" } }] }, { text: "done" }]); await cli(["--non-interactive", "hello"], workspace(), { provider: absent, userConfig: { ui: { keybindings: { enabled: false } } } }); expect(JSON.stringify(absent.requests[1]?.history)).toContain("Unknown skill");
});
