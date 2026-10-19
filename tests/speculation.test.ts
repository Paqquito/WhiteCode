import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SpeculativeTurn } from "../src/engine/speculation";
import { runTurn } from "../src/engine/loop";
import { bench, probe } from "./helpers/engine";
import { ScriptedProvider, type ScriptStep } from "./helpers/scripted-provider";
import { sleep } from "./helpers/interactive";
import type { ToolContext } from "../src/tools/types";
import type { RecordType } from "../src/session/transcript";
import { readStateKey } from "../src/tools/text-file";

async function until(check: () => boolean): Promise<void> { for (let n = 0; n < 200; n++) { if (check()) return; await sleep(5); } throw Error("Speculation condition timed out"); }
function fixture(script: (path: string) => ScriptStep[], options: Parameters<typeof bench>[1] = {}) {
  const b = bench([], options), path = b.ws.write("project/source.txt", "ORIGINAL\n"), provider = new ScriptedProvider(script(path));
  const readState: ToolContext["readState"] = new Map(), context = b.deps.executor.toolContext;
  const records: Array<{ type: RecordType; data: Record<string, unknown> }> = [];
  const deps = { ...b.deps, provider, transcript: { append: (type: RecordType, data: Record<string, unknown>) => { records.push({ type, data }); return "real-" + records.length; }, flush: () => {} }, executor: { ...b.deps.executor, toolContext: (signal: AbortSignal) => ({ ...context(signal), readState }) } };
  const stop = new AbortController();
  return { ...b, path, provider, deps, records, stop, draft: () => new SpeculativeTurn("Improve the source", deps, { tempDir: join(b.ws.root, "overlays"), key: "settings", valid: () => true, signal: stop.signal }) };
}
const readThenWrite = (path: string): ScriptStep[] => [{ toolCalls: [{ name: "read_file", input: { path } }] }, { toolCalls: [{ name: "write_file", input: { path, content: "STAGED\n" } }] }, { text: "Staged answer" }];

test("SPEC-MOT-029/CA-01 — ignoring an actual speculative write removes its overlay and leaves project, conversation and transcript unchanged", async () => {
  const f = fixture(readThenWrite), draft = f.draft();
  try {
    expect((await draft.result)?.stopCause).toBe("completed");
    expect([...draft.entries.values()].find(entry => entry.written)).toBeDefined();
    expect(readFileSync(f.path, "utf8")).toBe("ORIGINAL\n"); expect(f.conversation.messages).toEqual([]); expect(f.records).toEqual([]);
    expect(f.events.filter(event => event.type !== "usage")).toEqual([]);
    draft.discard(); await until(() => readdirSync(join(f.ws.root, "overlays")).length === 0);
    expect(readFileSync(f.path, "utf8")).toBe("ORIGINAL\n"); expect(draft.counters.discarded).toBe(1);
  } finally { f.stop.abort(); }
});

test("SPEC-MOT-029/CA-02 — a real permission request is suspended before its authority and presented only after acceptance", async () => {
  let asked = 0;
  const f = fixture(path => [{ toolCalls: [{ name: "write_file", input: { path: path + ".new", content: "APPROVED" } }] }, { text: "After approval" }], { mode: "ask", authorities: { human: { request: async () => { asked++; return { answer: "yes" }; } } } });
  const draft = f.draft();
  try {
    await until(() => f.provider.requests.length >= 1); await sleep(40);
    expect(asked).toBe(0); expect(existsSync(f.path + ".new")).toBe(false); expect(f.records).toEqual([]);
    const result = await draft.accept("Improve the source", f.deps, "settings", f.stop.signal);
    expect(result?.stopCause).toBe("completed"); expect(asked).toBe(1); expect(readFileSync(f.path + ".new", "utf8")).toBe("APPROVED");
    expect(f.records.some(record => record.type === "user")).toBe(true); expect(f.events.some(event => event.type === "assistant_message")).toBe(true);
  } finally { f.stop.abort(); }
});

test("TECH — accepting a finished speculative file turn applies the actual bytes with backups and no second model execution", async () => {
  const backups: string[][] = [], after: string[][] = [];
  const f = fixture(readThenWrite, { executor: { fileHistory: { beforeWrite: paths => { backups.push([...paths]); return undefined; }, afterWrite: paths => { after.push([...paths]); } } } }), draft = f.draft();
  try {
    await draft.result; expect(backups).toEqual([]);
    expect((await draft.accept("Improve the source", f.deps, "settings", f.stop.signal))?.finalText).toBe("Staged answer");
    expect(readFileSync(f.path, "utf8")).toBe("STAGED\n"); expect(backups).toEqual([[f.path]]); expect(after).toEqual([[f.path]]);
    expect(f.provider.requests).toHaveLength(3); expect(f.conversation.messages).toHaveLength(6);
    expect(JSON.stringify(f.conversation.messages)).not.toContain("overlays"); expect(JSON.stringify(f.records)).not.toContain("speculation-");
  } finally { f.stop.abort(); }
});

test("TECH — a same-size external file change invalidates the speculative layer before any application", async () => {
  const f = fixture(readThenWrite), draft = f.draft();
  try { await draft.result; writeFileSync(f.path, "CHANGED!\n"); expect(await draft.accept("Improve the source", f.deps, "settings", f.stop.signal)).toBeUndefined(); expect(readFileSync(f.path, "utf8")).toBe("CHANGED!\n"); expect(f.records).toEqual([]); expect(f.conversation.messages).toEqual([]); }
  finally { f.stop.abort(); }
});

test("TECH — even an explicitly permitted read-only external tool waits for acceptance and does not run when discarded", async () => {
  const calls: unknown[] = [], tool = probe("outside_effect", { calls });
  const f = fixture(() => [{ toolCalls: [{ name: tool.name, input: {} }] }, { text: "After effect" }], { tools: [tool] }), draft = f.draft();
  try { await until(() => f.provider.requests.length === 1); await sleep(30); expect(calls).toEqual([]); draft.discard(); await draft.result; expect(calls).toEqual([]); expect(f.records).toEqual([]); }
  finally { f.stop.abort(); }
});

test("TECH — a changed permission context and a different input discard a draft without asking or applying it", async () => {
  let mode: "unrestricted" | "planning" = "unrestricted";
  const f = fixture(readThenWrite, { mode: () => mode }), draft = f.draft();
  try { await draft.result; mode = "planning"; expect(await draft.accept("Improve the source", f.deps, "settings", f.stop.signal)).toBeUndefined(); expect(readFileSync(f.path, "utf8")).toBe("ORIGINAL\n"); }
  finally { f.stop.abort(); }
  const g = fixture(readThenWrite), second = g.draft();
  try { await second.result; expect(await second.accept("Other input", g.deps, "settings", g.stop.signal)).toBeUndefined(); expect(g.records).toEqual([]); }
  finally { g.stop.abort(); }
});

test("TECH — a partial speculative read keeps its partial-read precondition after acceptance", async () => {
  const f = fixture(path => [{ toolCalls: [{ name: "read_file", input: { path, offset: 1, limit: 1 } }] }, { text: "Read one line" }]);
  f.ws.write("project/source.txt", "FIRST\nSECOND\n"); const draft = f.draft();
  try { await draft.result; await draft.accept("Improve the source", f.deps, "settings", f.stop.signal); expect(f.deps.executor.toolContext(f.stop.signal).readState.get(readStateKey(f.path, f.deps.executor.toolContext(f.stop.signal).platform))?.complete).toBe(false); }
  finally { f.stop.abort(); }
});

test("TECH — checkpoints precede promoted backups and continued approved writes retain ordinary file-history callbacks", async () => {
  const order: string[] = [];
  const f = fixture(path => [...readThenWrite(path).slice(0, 2), { toolCalls: [{ name: "write_file", input: { path: path + ".next", content: "CONTINUED" } }] }, { text: "Finished continuation" }], {
    mode: "auto_edit", executor: { fileHistory: { beforeWrite: paths => { order.push("backup:" + paths.join()); return undefined; }, afterWrite: paths => { order.push("after:" + paths.join()); } } },
  });
  let asked = 0; const originalContext = f.deps.executor.toolContext;
  const deps = { ...f.deps, onUserMessage: () => order.push("checkpoint"), executor: { ...f.deps.executor,
    authorities: { human: { request: async () => { asked++; return { answer: "yes" as const }; } } },
    toolContext: (signal: AbortSignal) => { const ctx = originalContext(signal); return { ...ctx, protectedLocations: { ...ctx.protectedLocations, files: [f.path + ".next"] } }; },
  } };
  const draft = new SpeculativeTurn("Improve the source", deps, { tempDir: join(f.ws.root, "overlays"), key: "settings", valid: () => true, signal: f.stop.signal });
  try {
    await until(() => f.provider.requests.length === 3); await sleep(20); expect(order).toEqual([]); expect(asked).toBe(0); await draft.accept("Improve the source", deps, "settings", f.stop.signal);
    expect(order[0]).toBe("checkpoint"); expect(order[1]).toContain("backup:"); expect(order.filter(value => value.startsWith("backup:"))).toHaveLength(2); expect(asked).toBe(1); expect(readFileSync(f.path + ".next", "utf8")).toBe("CONTINUED");
  } finally { f.stop.abort(); }
});

test("TECH — accepted prepared turns reduce perceived latency by at least half against the same actual delayed provider loop", async () => {
  let preparedMs = 0, ordinaryMs = 0;
  for (let n = 0; n < 3; n++) {
    const steps = (path: string) => readThenWrite(path).map(step => ({ ...step, delayMs: 100 }));
    const f = fixture(steps), draft = f.draft();
    try { await draft.result; let start = performance.now(); expect((await draft.accept("Improve the source", f.deps, "settings", f.stop.signal))?.stopCause).toBe("completed"); preparedMs += performance.now() - start; }
    finally { f.stop.abort(); }
    const normal = fixture(steps);
    try { const start = performance.now(); expect((await runTurn(normal.deps, "Improve the source", normal.stop.signal)).stopCause).toBe("completed"); ordinaryMs += performance.now() - start; }
    finally { normal.stop.abort(); }
  }
  expect(ordinaryMs).toBeGreaterThan(500); expect(preparedMs / ordinaryMs).toBeLessThanOrEqual(0.5);
});
