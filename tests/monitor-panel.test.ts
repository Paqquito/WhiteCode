import { expect, test } from "bun:test";
import { workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { bunCommand, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { join } from "node:path";
import { afterNativeStart } from "./helpers/native-ready";
test("SPEC-AGT-024/CA-01 — a live monitor shows its delivered event count and most recent event in the task panel", async () => {
  const ws = workspace(), ready=join(ws.root,"monitor-ready"), source = ws.write("project/events.ts", `import{writeFileSync}from"node:fs";writeFileSync(${JSON.stringify(ready)},"ready");console.log("ERROR_OBSERVED_48"); await Bun.sleep(30000);`), controller = new AbortController();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "monitor_process", input: { command: bunCommand(source.replace(/\\/g, "/")), description: "surveillance témoin" } }] }, { toolCalls: [{ name: "background_output", input: { task_id: "m1", timeout: 1500 } }] }, { text: "MONITOR_READY_48" }]);
  afterNativeStart(provider,ready);
  const run = interactive(["--allow-rule", "run_shell"], ws, { provider, env: productEnv(ws), signal: controller.signal });
  try { await run.idle(); run.type("Monitor the events.\r"); await run.waitFor(text => text.includes("MONITOR_READY_48")); expect(JSON.stringify(provider.requests.at(-1)!.history)).toContain("ERROR_OBSERVED_48"); run.type("\u001bk"); await run.waitFor(text => text.includes("Tâches de fond — choisir")); const screen = run.screen().join("\n"); expect(screen).toContain("surveillance"); expect(screen).toContain("1 événements"); expect(screen).toContain("ERROR_OBSERVED_48"); }
  finally { controller.abort(); await run.done; }
}, 30000);
