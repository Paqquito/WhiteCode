import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { configurationWritable } from "../src/config/persistence";
import { interactive, KEY } from "./helpers/interactive";
function snapshot(folder: string): string[] { return readdirSync(folder, { recursive: true, withFileTypes: true }).filter(file => file.isFile()).map(file => { const path = join(file.parentPath, file.name); return path + ":" + readFileSync(path).toString("base64"); }).sort(); }
test("SPEC-MOD-010/CA-03 — a read-only configuration starts with a warning and no persisted session", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "READ_ONLY_SESSION_STARTED_51" }]); let before: string[] = [];
  const result = await cli(["--non-interactive", "--model=medium", "Hello"], ws, { provider, extra: { persistenceWritable: folder => { before = snapshot(folder); return false; } } });
  expect(result.code).toBe(0); expect(result.stdout).toContain("READ_ONLY_SESSION_STARTED_51"); expect(result.stderr).toContain("lecture seule"); expect(existsSync(join(ws.configHome, "sessions"))).toBe(false); expect(snapshot(ws.configHome)).toEqual(before); expect(provider.requests).toHaveLength(1);
});
test("TECH — the native configuration write probe creates no leftover file or project file", () => {
  const ws = workspace(); expect(configurationWritable(ws.configHome)).toBe(true); expect(readdirSync(ws.configHome).filter(name => name.startsWith(".write-probe-"))).toEqual([]); expect(configurationWritable(ws.write("project/ordinary.txt", "ordinary"))).toBe(false); expect(readFileSync(join(ws.project, "ordinary.txt"), "utf8")).toBe("ordinary");
});
test("TECH — an interactive read-only session also retains no input history, draft or transcript", async () => {
  const ws = workspace(); let before: string[] = [];
  const provider = new ScriptedProvider([{ text: "READ_ONLY_INTERACTIVE_FINISHED" }]);
  const run = interactive([], ws, { provider, extra: { persistenceWritable: folder => { before = snapshot(folder); return false; } } });
  try { await run.idle(); run.type("Hello"); run.type(KEY.enter); await run.waitFor(text => text.includes("READ_ONLY_INTERACTIVE_FINISHED")); await run.idle(); }
  finally { run.type(KEY.ctrlD); run.type(KEY.ctrlD); }
  expect((await run.done).code).toBe(0); expect(snapshot(ws.configHome)).toEqual(before); expect(provider.requests).toHaveLength(1);
}, 15000);
