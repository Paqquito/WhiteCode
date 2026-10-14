// Supports: SPEC-INT-020/CA-01/02 and SPEC-OUT-036/CA-01/02.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-IHM-020/CA-01 — automatic theme follows a terminal background change without restarting the session", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([]);
  const run = interactive([], ws, { provider, signal: controller.signal, userConfig: { ui: { theme: "auto", colorMode: "truecolor" } } });
  try {
    await run.idle(); run.raw("\u001b]11;rgb:ffff/ffff/ffff\u001b\\");
    const inputBackground = (rgb: string) => { const row = run.screen().findIndex(line => line.includes("Votre message")); return row >= 0 && run.term.vt.styleAt(row, 0).includes(rgb); };
    await run.waitFor(() => inputBackground("48;2;255;255;255"), "light palette", 1500);
    run.raw("\u001b]11;rgb:0000/0000/0000\u0007");
    await run.waitFor(() => inputBackground("48;2;16;24;32"), "dark palette", 1500);
    expect(provider.requests).toHaveLength(0); expect(run.finished()).toBe(false);
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-INT-020/CA-01 — a permission requested after focus loss emits one generic notification", async () => {
  const ws = workspace(), controller = new AbortController(), notifications: string[] = [];
  const provider = new ScriptedProvider([{ delayMs: 150, toolCalls: [{ name: "write_file", input: { path: join(ws.project, "focus.txt"), content: "written" } }] }, { text: "finished" }]);
  const run = interactive(["--approval-mode", "ask"], ws, { provider, signal: controller.signal, extra: { notifyLocal: async (title, message) => { notifications.push(title + ":" + message); return true; } } });
  try {
    await run.idle(); run.type("Write the file."); run.type(KEY.enter); await run.waitFor(() => provider.requests.length === 1); run.raw("\u001b[O");
    await run.waitFor(text => text.includes("Autorisation requise")); await run.waitFor(() => notifications.length === 1, "notification emitted", 1500);
    expect(notifications).toHaveLength(1); expect(notifications[0]).not.toContain(ws.project); expect(notifications[0]).not.toContain("written");
    await sleep(380); run.type(KEY.escape); await run.waitFor(text => text.includes("finished"));
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-INT-020/CA-02 — a permission requested with reported focus emits no notification", async () => {
  const ws = workspace(), controller = new AbortController(); let notifications = 0;
  const provider = new ScriptedProvider([{ delayMs: 150, toolCalls: [{ name: "write_file", input: { path: join(ws.project, "focus.txt"), content: "written" } }] }, { text: "finished" }]);
  const run = interactive(["--approval-mode", "ask"], ws, { provider, signal: controller.signal, extra: { notifyLocal: async () => { notifications++; return true; } } });
  try {
    await run.idle(); run.raw("\u001b[I"); run.type("Write the file."); run.type(KEY.enter);
    await run.waitFor(text => text.includes("Autorisation requise")); await sleep(400); expect(notifications).toBe(0);
    run.type(KEY.escape); await run.waitFor(text => text.includes("finished"));
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-OUT-036/CA-01 — disabled agent notifications return not sent without error or an external call", async () => {
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "notify_device", input: { message: "Action required: review the change." } }] }, { text: "done" }]); let sent = 0;
  const result = await cli(["--non-interactive", "Notify me."], workspace(), { provider, userConfig: { ui: { notifications: { agentEnabled: false } } }, extra: { notifyLocal: async () => { sent++; return true; } } });
  expect(result.code).toBe(0); expect(sent).toBe(0); const results = JSON.stringify(provider.requests[1]!.history);
  expect(results).toContain("not sent"); expect(results).toContain('"isError":false');
});

test("SPEC-OUT-036/CA-02 — six notifications are sent in the same hour and the seventh is suppressed", async () => {
  const provider = new ScriptedProvider([{ toolCalls: Array.from({ length: 7 }, (_, i) => ({ name: "notify_device", input: { message: `Action required ${i + 1}.` } })) }, { text: "done" }]), sent: string[] = [];
  const result = await cli(["--non-interactive", "Notify me."], workspace(), { provider, extra: { notifyLocal: async (_title, message) => { sent.push(message); return true; } } });
  expect(result.code).toBe(0); expect(sent).toHaveLength(6); expect(sent.at(-1)).toBe("Action required 6.");
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("hourly limit");
});
