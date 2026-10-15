import { expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/store";
import { MemoryConsolidation } from "../src/memory/consolidation";
import { BackgroundTasks } from "../src/engine/background";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { projectKey } from "../src/session/transcript";
const fact = (body: string) => `---\nname: Convention\ndescription: Project convention\ntype: project\n---\n${body}\n`;
function setup(work: ConstructorParameters<typeof MemoryConsolidation>[0]["work"]) {
  const ws = workspace(), store = new MemoryStore(join(ws.configHome, "memory"), { indexFile: "index.md", maxLines: 200, maxBytes: 30000, redact: text => text }); store.put("fact.md", fact("initial"));
  const background = new BackgroundTasks({ dir: join(ws.root, "tasks"), maxOutputBytes: 10000, monitorMaxLinesPerMinute: 100, monitorWindowMs: 1 });
  const options = { store, background, work, signal: new AbortController().signal, denied: () => false, enabled: () => true, minHours: 48, minSessions: 1, now: () => 200000000 };
  return { ws, store, background, options, consolidation: new MemoryConsolidation(options) };
}
test("SPEC-MOT-039/CA-01 — due completed sessions start visible background consolidation once per session", async () => {
  const b = setup(async staged => { staged.put("fact.md", fact("consolidated")); return true; });
  const id = b.consolidation.sessionCompleted()!; expect(id).toBeTruthy(); expect(b.consolidation.sessionCompleted()).toBeUndefined();
  await b.background.wait(id, 1000); expect(b.store.read("fact.md").text).toContain("consolidated"); expect(b.background.tasks[0]!.status).toBe("completed");
  const next = new MemoryConsolidation(b.options); expect(next.sessionCompleted()).toBeUndefined();
});
test("SPEC-MOT-039/CA-02 — another live consolidation lock prevents a second task", async () => {
  let finish!: () => void; const b = setup(async () => { await new Promise<void>(resolve => { finish = resolve; }); return true; });
  const id = b.consolidation.start()!; await Promise.resolve(); expect(new MemoryConsolidation(b.options).start()).toBeUndefined(); expect(b.background.tasks).toHaveLength(1); finish(); await b.background.wait(id, 1000);
});
test("SPEC-AGT-022/CA-01 — a running consolidation exposes actual starting and write states in the task panel model", async () => {
  let change!: () => void, finish!: () => void; const b = setup(async (_staged, _signal, changed) => { change = changed; await new Promise<void>(resolve => { finish = resolve; }); return true; });
  const id = b.consolidation.start()!; expect(b.background.tasks[0]!.activity).toBe("démarrage"); await Promise.resolve(); change(); expect(b.background.tasks[0]!.activity).toBe("mise à jour"); finish(); await b.background.wait(id, 1000);
});
test("SPEC-AGT-022/CA-02 — stopping after a staging write preserves the exact original memory and index", async () => {
  const b = setup(async (staged, signal, changed) => { staged.put("fact.md", fact("partial")); changed(); await new Promise(resolve => signal.addEventListener("abort", resolve, { once: true })); return true; });
  const original = b.store.read("fact.md").text, index = b.store.index(), id = b.consolidation.start()!; await Promise.resolve();
  expect(b.background.tasks[0]!.activity).toBe("mise à jour"); await b.background.stop(id);
  expect(b.store.read("fact.md").text).toBe(original); expect(b.store.index()).toBe(index); expect(b.background.tasks[0]!.status).toBe("stopped");
});
test("TECH — concurrent human edits and existing user feedback cannot be overwritten by consolidation", async () => {
  const b = setup(async staged => { staged.put("fact.md", fact("worker")); b.store.put("fact.md", fact("human")); return true; });
  const id = b.consolidation.start()!; await b.background.wait(id, 1000); expect(b.background.tasks[0]!.status).toBe("failed"); expect(b.store.read("fact.md").text).toContain("human");
  const feedback = fact("Keep tests").replace("type: project", "type: feedback"); b.store.put("feedback.md", feedback);
  const expected = new Map(b.store.entries().map(entry => [entry.file, b.store.read(entry.file).text]));
  expect(() => b.store.publish(expected, new Map([["feedback.md", feedback.replace("Keep tests", "Remove tests")]]))).toThrow("feedback"); expect(b.store.read("feedback.md").text).toBe(feedback);
});
test("SPEC-EXT-035/CA-01 — invoking the built-in skill starts a visible consolidation through its ordinary tool", async () => {
  const ws = workspace(), key = projectKey(realpathSync(ws.project)); ws.write(`home/config/memory/${key}/fact.md`, fact("original"));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "consolidate_memory", input: {} }] }, request => { expect(JSON.stringify(request.history)).toContain("task_id"); return { text: "Task started." }; }], [{ text: "No changes needed.", delayMs: 500 }]);
  const host = new Host(ws, { provider, userConfig: { memory: { automatic: { enabled: true }, autoExtraction: { enabled: false }, recall: { enabled: false }, consolidation: { minSessions: 100 } } } });
  try { host.user("/memory-consolidation"); await host.waitFor(message => message.type === "turn_completed"); expect(JSON.stringify(provider.requests.at(-1)?.history)).toContain("task_id"); const state = await host.request("get_state", {}); expect(JSON.stringify(state)).toContain("Consolidation de la mémoire"); expect(JSON.stringify(provider.requests[0]!.history)).toContain("consolidate_memory"); }
  finally { host.feed.end(); await host.finish(); }
}, 15000);
test("TECH — automatic consolidation starts on actual session closure after the configured session count", async () => {
  const ws = workspace(), key = projectKey(realpathSync(ws.project)); ws.write(`home/config/memory/${key}/fact.md`, fact("original"));
  const provider = new ScriptedProvider([{ text: "Work completed." }], [{ text: "No changes needed." }]);
  const result = await cli(["--non-interactive", "Work."], ws, { provider, userConfig: { memory: { automatic: { enabled: true }, recall: { enabled: false }, autoExtraction: { enabled: false }, consolidation: { minSessions: 1, minHours: 0 } } } });
  expect(result.code).toBe(0); expect(result.stderr).toContain("Consolidation de la mémoire"); expect(provider.requests.filter(request => request.agent === "internal-memory-consolidation")).toHaveLength(1);
});
