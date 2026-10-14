import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./helpers/env";
import { interactive, sleep } from "./helpers/interactive";
import { bunCommand, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("TECH — proactive wake must stay suspended while an external editor holds an empty draft", async () => {
  const ws = workspace(), controller = new AbortController();
  const provider = new ScriptedProvider([{ text: "UNEXPECTED_EDITOR_WAKE_48" }]);
  let now = Date.now(), temporary = "", releaseEditor!: () => void;
  const editorClosed = new Promise<void>(resolve => { releaseEditor = resolve; });
  const run = interactive([], ws, {
    provider, signal: controller.signal,
    userConfig: { modes: { proactive: { intervalMinutes: 1 } }, ui: { externalEditor: "fixture-editor" } },
    extra: { now: () => new Date(now), externalEditorRun: async (_program, args) => {
      temporary = args.at(-1)!;
      expect(readFileSync(temporary, "utf8")).toBe("");
      writeFileSync(temporary, "UNSENT_EXTERNAL_DRAFT_48");
      await editorClosed;
      return 0;
    } },
  });
  try {
    await run.idle(); run.type("/proactive\r");
    await run.waitFor(text => text.includes("Mode proactif activé"));
    run.type("\u0007");
    await run.waitFor(() => temporary !== "", "the real temporary draft is open");
    expect(existsSync(temporary)).toBe(true);
    await sleep(350); now += 60001; await sleep(650);
    expect(provider.requests).toHaveLength(0);
  } finally { releaseEditor(); await sleep(30); controller.abort(); await run.done; }
}, 15000);

test("TECH — a batch from a still-running monitor must wake the main wait with notification", async () => {
  const ws = workspace(), controller = new AbortController();
  const trigger = join(ws.project, "emit-event"), emitted = join(ws.project, "event-emitted");
  const source = ws.write("project/monitor-wait-source.ts", `
    const fs = await import("node:fs");
    while (!fs.existsSync(${JSON.stringify(trigger)})) await Bun.sleep(10);
    console.log("MONITOR_EVENT_DURING_WAIT_48");
    fs.writeFileSync(${JSON.stringify(emitted)}, "emitted");
    await Bun.sleep(30000);
  `);
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "monitor_process", input: { command: bunCommand(source.replace(/\\/g, "/")), description: "monitor notification witness" } }] },
    { toolCalls: [{ name: "wait", input: { duration: 600 } }] },
    request => {
      const history = JSON.stringify(request.history);
      expect(history).toContain('\\"cause\\":\\"notification\\"');
      expect(history).toContain("MONITOR_EVENT_DURING_WAIT_48");
      return { text: "MONITOR_NOTIFICATION_WAKE_48" };
    },
  ]);
  const run = interactive(["--allow-rule", "run_shell"], ws, {
    provider, signal: controller.signal, env: productEnv(ws),
    userConfig: { engine: { autonomous: { tickInterval: "10m" } } },
  });
  try {
    await run.idle(); run.type("/proactive\r");
    await run.waitFor(text => text.includes("Mode proactif activé"));
    run.type("Monitor events and wait until one arrives.\r");
    await run.waitFor(() => run.screen().join("\n").includes("en veille jusqu’à"), "main wait started");
    expect(provider.requests).toHaveLength(2);
    writeFileSync(trigger, "emit now");
    await run.waitFor(() => existsSync(emitted), "the real monitored process emitted its event");
    await sleep(1200);
    expect(provider.requests).toHaveLength(3);
    expect(run.all().join("\n")).toContain("MONITOR_NOTIFICATION_WAKE_48");
  } finally { controller.abort(); await run.done; }
}, 15000);
