import { expect, test } from "bun:test";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "../src/providers/types";
import type { EngineEvent } from "../src/engine/events";
import {LiveSessions} from "../src/interactive/live-sessions";
import {fakeTerminal} from "./helpers/vterm";

test("TECH — handing the foreground keyboard to a native client releases the physical input subscription", async () => {
  const terminal = fakeTerminal();
  const readers: number[] = [];
  const host = new LiveSessions(terminal, async port => {
    const stop = port.terminal.onInput(() => {});
    const stopDialog = port.terminal.onInput(() => {});
    readers.push(terminal.inputListenerCount);
    stopDialog();
    readers.push(terminal.inputListenerCount);
    stop();
    readers.push(terminal.inputListenerCount);
    port.terminal.onInput(() => {});
    readers.push(terminal.inputListenerCount);
    return 0;
  });
  expect(await host.run([], ".")).toBe(0);
  expect(readers).toEqual([1, 1, 0, 1]);
  expect(terminal.inputListenerCount).toBe(0);
});

test("TECH — a terminal listener installed during consent receives only the following input, never the consumed agreement",async()=>{
  const terminal=fakeTerminal(),first:string[]=[],later:string[]=[];
  const host=new LiveSessions(terminal,async(port)=>{
    const unsubscribe=port.terminal.onInput(data=>{first.push(data);unsubscribe();port.terminal.onInput(value=>later.push(value));});
    await new Promise<void>(resolve=>host.signal.addEventListener("abort",()=>resolve(),{once:true}));return 0;
  });
  const running=host.run([],workspace().project);
  try{terminal.type("o");expect(first).toEqual(["o"]);expect(later).toEqual([]);terminal.type("next");expect(later).toEqual(["next"]);}
  finally{host.close();await running;}
});

const route = (first: ScriptedProvider, second: ScriptedProvider): ModelProvider => ({ id: "simulated", stream: (request, signal) => (JSON.stringify(request.history).includes("premier contexte") ? first : second).stream(request, signal) });
async function detach(run: ReturnType<typeof interactive>) {
  run.type("\u001bj"); await run.waitFor(t => t.includes("Appuyer à nouveau")); run.type("\u001bj"); await sleep(100); await run.idle();
}

test("SPEC-AGT-021/CA-01 — an in-flight main request survives the double shortcut, a distinct conversation runs and the original context resumes", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([{ text: "PREMIER RETARDE", delayMs: 1800 }, { text: "SECOND TERMINE" }, { text: "PREMIER REPRIS" }]);
  const life = new AbortController();
  const events: Array<{ type: string; sessionId?: string }> = [];
  const run = interactive([], ws, { provider, signal: life.signal, extra: { onEvent: event => events.push(event) } });
  try {
    await run.idle(); run.type("premier contexte unique"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("PREMIER RETARDE"));
    run.type("\u001bj"); await run.waitFor(t => t.includes("Appuyer à nouveau"));
    expect(provider.requests).toHaveLength(1);
    run.type("\u001bj");
    await sleep(100); await run.idle();
    run.type("deuxieme contexte separe"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("SECOND TERMINE"));
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.conversationId).not.toBe(provider.requests[0]!.conversationId);
    expect(JSON.stringify(provider.requests[1]!.history)).not.toContain("premier contexte unique");
    expect(events.filter(e => e.type === "turn_completed")).toHaveLength(1);
    await run.waitFor(t => t.includes("résultat disponible"));
    run.type("\u001bk"); await run.waitFor(t => t.includes("Tâches de fond — conversations"));
    await sleep(380); run.type(KEY.enter);
    await run.waitFor(t => t.includes("Reprendre la conversation"));
    await sleep(380); run.type(KEY.enter);
    await run.waitFor(t => t.includes("conversation 1 reprise"));
    run.type("reprends le premier"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("PREMIER REPRIS"));
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests[2]!.conversationId).toBe(provider.requests[0]!.conversationId);
    expect(JSON.stringify(provider.requests[2]!.history)).toContain("premier contexte unique");
    expect(JSON.stringify(provider.requests[2]!.history)).not.toContain("deuxieme contexte separe");
  } finally { life.abort(); await run.done; }
  expect(run.term.vt.raw).toBe(false);
}, 15_000);

test("TECH — background permissions remain labelled and a refusal in one conversation does not grant its peer", async () => {
  const ws = workspace(), rejected = join(ws.project, "rejected.txt"), accepted = join(ws.project, "accepted.txt");
  const first = new ScriptedProvider([{ text: "ATTENTE PERMISSION", delayMs: 2200, toolCalls: [{ name: "write_file", input: { path: rejected, content: "NO" } }] }, { text: "REFUS OBSERVE" }]);
  const second = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: accepted, content: "YES" } }] }, { text: "ECRITURE SEPAREE" }]);
  const life = new AbortController(), events: EngineEvent[] = [];
  const run = interactive([], ws, { provider: route(first, second), signal: life.signal, extra: { onEvent: e => events.push(e) } });
  try {
    await run.idle(); run.type("premier contexte permission"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("ATTENTE PERMISSION")); await detach(run);
    run.type("second contexte permission"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("Demandé par : conversation 2"));
    await sleep(380); run.type("1");
    await run.waitFor(t => t.includes("ECRITURE SEPAREE"));
    expect(readFileSync(accepted, "utf8")).toBe("YES");
    await run.waitFor(t => t.includes("Tâche s1 — session principale — conversation 1"));
    expect(existsSync(rejected)).toBe(false);
    await sleep(380); run.type(KEY.escape);
    await run.waitFor(t => t.includes("résultat disponible"));
    expect(existsSync(rejected)).toBe(false);
    expect(events.some(e => e.type === "permission" && e.decision === "deny")).toBe(true);
    expect(first.requests).toHaveLength(2); expect(second.requests).toHaveLength(2);
    expect(JSON.stringify(first.requests[1]!.history)).toContain("denied");
  } finally { life.abort(); await run.done; }
}, 15_000);

test("TECH — the background context cannot overwrite the peer's intervening write using its old read", async () => {
  const ws = workspace(), path = ws.write("project/shared.txt", "ORIGINAL");
  const first = new ScriptedProvider([
    { toolCalls: [{ name: "read_file", input: { path } }] },
    { text: "LECTURE PREMIER TERMINEE", delayMs: 2500, toolCalls: [{ name: "write_file", input: { path, content: "OLD SNAPSHOT" } }] },
    { text: "CONFLIT OBSERVE" },
  ]);
  const second = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { toolCalls: [{ name: "write_file", input: { path, content: "PEER WRITE" } }] }, { text: "SECOND ECRIT" }]);
  const life = new AbortController(), events: EngineEvent[] = [];
  const run = interactive(["--allow-rule=read_file", "--allow-rule=write_file"], ws, { provider: route(first, second), signal: life.signal, extra: { onEvent: e => events.push(e) } });
  try {
    await run.idle(); run.type("premier contexte fichier"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("LECTURE PREMIER TERMINEE")); await detach(run);
    run.type("second contexte fichier"); run.type(KEY.enter); await run.waitFor(t => t.includes("SECOND ECRIT"));
    expect(readFileSync(path, "utf8")).toBe("PEER WRITE");
    await run.waitFor(t => t.includes("résultat disponible"));
    expect(readFileSync(path, "utf8")).toBe("PEER WRITE");
    expect(events.some(e => e.type === "tool_result" && e.isError && /changed|modified/i.test(e.output))).toBe(true);
    expect(JSON.stringify(first.requests.at(-1)!.history)).toMatch(/changed|modified/i);
  } finally { life.abort(); await run.done; }
}, 15_000);

test("TECH — concurrent conversations share the original global iteration counter", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "RESERVATION EN COURS", delayMs: 1600 }, { text: "MUST NOT RUN" }]);
  const life = new AbortController(), events: EngineEvent[] = [];
  const run = interactive(["--model=large", "--max-cost=0.90", "--max-iterations=1"], ws, { provider, signal: life.signal, extra: { onEvent: e => events.push(e) } });
  try {
    await run.idle(); run.type("premier contexte budget"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("RESERVATION EN COURS")); await detach(run);
    run.type("second contexte budget"); run.type(KEY.enter);
    await run.waitFor(() => events.some(e => e.type === "turn_completed" && e.result.stopCause === "iteration_limit"));
    expect(provider.requests).toHaveLength(1);
    await run.waitFor(t => t.includes("résultat disponible"));
    expect(provider.requests).toHaveLength(1);
  } finally { life.abort(); await run.done; }
}, 15_000);

test("TECH — a second conversation cannot spend the reservation still held by the first request", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "BUDGET RESERVE", delayMs: 2200 }, { text: "MUST NOT RUN" }]);
  const life = new AbortController(), events: EngineEvent[] = [];
  const run = interactive(["--model=large", "--max-cost=0.90"], ws, { provider, signal: life.signal, extra: { onEvent: e => events.push(e) } });
  try {
    await run.idle(); run.type("premier contexte budget"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("BUDGET RESERVE")); await detach(run);
    run.type("second contexte budget"); run.type(KEY.enter);
    await run.waitFor(() => events.some(e => e.type === "turn_completed" && e.result.stopCause === "budget_limit"));
    expect(provider.requests).toHaveLength(1);
    expect(events.filter(e => e.type === "turn_completed")).toHaveLength(1);
    await run.waitFor(t => t.includes("résultat disponible"));
    expect(provider.requests).toHaveLength(1);
  } finally { life.abort(); await run.done; }
}, 15_000);

test("TECH — closing the host aborts both real turns, joins their cleanup and prevents delayed writes", async () => {
  const ws = workspace(), path = join(ws.project, "late.txt");
  const script = new ScriptedProvider([{ text: "PREMIER LONG", delayMs: 30_000, toolCalls: [{ name: "write_file", input: { path, content: "LATE" } }] }, { text: "SECOND LONG", delayMs: 30_000 }]);
  const signals: AbortSignal[] = [], provider: ModelProvider = { id: "simulated", stream: (request, signal) => { signals.push(signal); return script.stream(request, signal); } };
  const life = new AbortController(), run = interactive(["--allow-rule=write_file"], ws, { provider, signal: life.signal });
  try {
    await run.idle(); run.type("premier contexte long"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("PREMIER LONG")); await detach(run);
    run.type("second contexte long"); run.type(KEY.enter); await run.waitFor(t => t.includes("SECOND LONG"));
    const started = Date.now(); life.abort(); await run.done;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(signals).toHaveLength(2); expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(existsSync(path)).toBe(false); expect(run.term.vt.raw).toBe(false);
  } finally { life.abort(); await run.done; }
}, 15_000);

test("TECH — successive backgroundings preserve both pending turns and every retained conversation remains reachable", async () => {
  const ws = workspace(), script = new ScriptedProvider([{ text: "LONG A", delayMs: 30_000 }, { text: "LONG B", delayMs: 30_000 }, { text: "THIRD DISTINCT" }, { text: "FOURTH DISTINCT" }]);
  const signals: AbortSignal[] = [], provider: ModelProvider = { id: "simulated", stream: (request, signal) => { signals.push(signal); return script.stream(request, signal); } };
  const life = new AbortController(), run = interactive([], ws, { provider, signal: life.signal, userConfig: { ui: { keybindings: { bindings: { "session.background": ["alt+q"] } } } } });
  const move = async () => { run.type("\u001bq"); await run.waitFor(t => t.includes("Appuyer à nouveau")); run.type("\u001bq"); await sleep(150); };
  try {
    await run.idle(); run.type("context A"); run.type(KEY.enter); await run.waitFor(t => t.includes("LONG A"));
    await move(); run.type("context B"); run.type(KEY.enter); await run.waitFor(t => t.includes("LONG B"));
    await move(); run.type("context C"); run.type(KEY.enter); await run.waitFor(t => t.includes("THIRD DISTINCT"));
    expect(new Set(script.requests.map(request => request.conversationId)).size).toBe(3);
    expect(signals.slice(0, 2).some(signal => signal.aborted)).toBe(false);
    run.type("\u001bk"); await run.waitFor(t => t.includes("Tâches de fond — conversations"));
    expect(run.screen().join("\n")).toContain("conversation 2"); expect(run.screen().join("\n")).toContain("conversation 3");
    await sleep(380); run.type(KEY.enter); await run.waitFor(t => t.includes("Reprendre la conversation"));
    await sleep(380); run.type(KEY.enter); await run.waitFor(t => t.includes("conversation 1 reprise"));
    await move(); run.type("context D"); run.type(KEY.enter); await run.waitFor(t => t.includes("FOURTH DISTINCT"));
    expect(script.requests).toHaveLength(4);
    expect(new Set(script.requests.map(request => request.conversationId)).size).toBe(4);
    expect(signals.slice(0, 2).some(signal => signal.aborted)).toBe(false);
  } finally { life.abort(); await run.done; }
}, 15_000);

test("TECH — the adopted output file and task summary use the origin's exact credential redactor", async () => {
  const ws = workspace(), credential = "fixture_value_without_a_known_secret_shape_5137";
  const path = ws.write("project/source.txt", credential);
  const first = new ScriptedProvider([{ text: `PARTIAL ${credential}`, delayMs: 1700, toolCalls: [{ name: "read_file", input: { path } }] }, { text: `FINAL ${credential}` }]);
  const second = new ScriptedProvider([{ text: "SECOND SAFE" }]);
  const life = new AbortController(), run = interactive(["--allow-rule=read_file"], ws, { provider: route(first, second), signal: life.signal, env: { AZURE_API_KEY: credential } });
  try {
    await run.idle(); run.type("premier contexte secret"); run.type(KEY.enter);
    await run.waitFor(t => t.includes("PARTIAL")); await detach(run);
    run.type("second contexte"); run.type(KEY.enter); await run.waitFor(t => t.includes("SECOND SAFE"));
    await run.waitFor(t => t.includes("résultat disponible"));
    const logs = readdirSync(ws.configHome, { recursive: true }).filter((path): path is string => typeof path === "string" && path.endsWith("s1.log"));
    expect(logs).toHaveLength(1);
    const log = readFileSync(join(ws.configHome, logs[0]!), "utf8");
    expect(log).not.toContain(credential); expect(log).toContain("[redacted credential]");
    run.type("\u001bk"); await run.waitFor(t => t.includes("Tâches de fond — conversations"));
    expect(run.screen().join("\n")).not.toContain(credential);
    expect(run.screen().join("\n")).toContain("[redacted credential]");
  } finally { life.abort(); await run.done; }
}, 15_000);
