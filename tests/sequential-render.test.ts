import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-IHM-038/CA-01 — sequential rendering appends a permission request and accepts keyboard approval", async () => {
  const ws = workspace(), controller = new AbortController();
  const path = join(ws.project, "new.txt");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "approved\n" } }] }, { text: "SEQUENTIAL_DONE" }]);
  const run = interactive([], ws, { provider, signal: controller.signal, userConfig: { ui: { screenReaderMode: true, terminalTitle: { enabled: false } } } });
  try {
    await run.idle(); run.type("Create the file."); run.type(KEY.enter);
    await run.waitFor(text => text.includes("write_file") && text.includes("Autorisation requise"));
    expect(existsSync(path)).toBe(false); const before = run.all().join("\n");
    await sleep(380); run.type(KEY.enter); await run.waitFor(text => text.includes("SEQUENTIAL_DONE"));
    expect(existsSync(path)).toBe(true); expect(run.all().join("\n").startsWith(before)).toBe(true);
    expect(provider.requests).toHaveLength(2);
  } finally { controller.abort(); await run.done; }
}, 15_000);
