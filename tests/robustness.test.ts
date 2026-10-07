// Retries and provider errors, idle stream, output limit, debug journal, interruption, unproductive loops.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LoopGuard, REPETITION_REMINDER } from "../src/engine/loop-guard";
import { retryDelayMs, runTurn } from "../src/engine/loop";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";
import type { HumanAnswer, LoopChoice } from "../src/permissions/resolver";
import { textOutcome } from "../src/tools/types";
import { cli, workspace } from "./helpers/env";
import { bench, probe } from "./helpers/engine";
import { startFakeOpenAI, type FakeChatServer } from "./helpers/fake-openai-server";
import { ScriptedProvider } from "./helpers/scripted-provider";

let server: FakeChatServer | undefined;
afterEach(() => server?.stop());
const signal = () => new AbortController().signal;
const noWait = async () => undefined;

describe("SPEC-API-003 retries", () => {
  test("SPEC-API-003/CA-01 — two 5xx errors then a success: the answer is obtained and the wait was shown", async () => {
    server = startFakeOpenAI([{ status: 500 }, { status: 503 }, { text: "finally" }]);
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: { api: { baseUrl: server.baseURL } } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("finally\n");
    expect(server.requests).toHaveLength(3);
    expect(r.stderr).toContain("nouvel essai dans");
    expect(r.stderr).toContain("(essai 2/9)");
    expect(r.stderr).toContain("(essai 3/9)");
  }, 30_000);

  test("SPEC-API-003/CA-02 — a 429 indicating 5 s: the new attempt waits at least 5 s", async () => {
    const waits: number[] = [];
    const b = bench([{ error: { kind: "rate_limit", retryAfterMs: 5000, status: 429 } }, { text: "ok" }], { deps: { retry: { maxRetries: 8, sleep: async (ms) => void waits.push(ms) } } });
    const r = await runTurn(b.deps, "x", signal());
    expect(r.finalText).toBe("ok");
    expect(waits).toEqual([5000]);
    // Without indication: exponential with jitter, between 0.5 s and 30 s.
    expect(retryDelayMs(0, undefined, () => 0)).toBe(500);
    expect(retryDelayMs(3, undefined, () => 0.5)).toBe(4000);
    expect(retryDelayMs(20, undefined, () => 1)).toBe(30_000);
  });

  test("SPEC-API-003/CA-03 — a 400 error: no retry", async () => {
    const b = bench([{ error: { kind: "invalid_request", status: 400 } }, { text: "never" }], { deps: { retry: { maxRetries: 8, sleep: noWait } } });
    const r = await runTurn(b.deps, "x", signal());
    expect(r.stopCause).toBe("error");
    expect(b.provider.requests).toHaveLength(1);
  });

  test("SPEC-API-003/CA-04 — a wait in progress and the user interrupts: the wait stops at once", async () => {
    const b = bench([{ error: { kind: "overloaded", retryAfterMs: 60_000 } }, { text: "never" }], { deps: { retry: { maxRetries: 8 } } });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    const r = await runTurn(b.deps, "x", controller.signal);
    expect(r.stopCause).toBe("interrupted");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(b.events.some((e) => e.type === "retry" && e.delayMs === 60_000)).toBe(true);
  });

  test("TECH — SPEC-API-003/ERR-01 and FA-01 — attempts exhausted: explicit message; a partial response is replaced, its tools never run", async () => {
    const calls: unknown[] = [];
    const b = bench(
      [{ text: "partial", toolCalls: [{ name: "look", input: { a: 1 } }], error: { kind: "connection" } }, { error: { kind: "connection" } }, { error: { kind: "connection" } }],
      { tools: [probe("look", { calls })], deps: { retry: { maxRetries: 2, sleep: noWait } } },
    );
    const r = await runTurn(b.deps, "x", signal());
    expect(r.stopCause).toBe("error");
    expect(r.message).toContain("ne répond pas après 3 essais");
    expect(b.events.some((e) => e.type === "response_restarted")).toBe(true);
    expect(b.conversation.messages.filter((m) => m.role === "assistant")).toHaveLength(0);
  });
});

describe("SPEC-API-002 client", () => {
  test("SPEC-API-002/CA-02 — a stream without event beyond the idle limit: cancelled and sent again", async () => {
    server = startFakeOpenAI([{ hang: true }, { text: "second try" }]);
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: { api: { baseUrl: server.baseURL, streamIdleTimeout: 300 } } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("second try\n");
    expect(server.requests).toHaveLength(2);
    expect(r.stderr).toContain("inactif");
  }, 30_000);

  test("D-20 — correction D-5: a server slow to send its first token is not cut by the idle limit, which runs from the first event", async () => {
    server = startFakeOpenAI([{ delayMs: 1500, text: "slow but complete" }]);
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: { api: { baseUrl: server.baseURL, streamIdleTimeout: 300 } } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("slow but complete\n");
    expect(server.requests).toHaveLength(1);
    expect(r.stderr).not.toContain("inactif");
  }, 30_000);

  test("SPEC-API-002/CA-03 — RESPONSE_TOKEN_LIMIT=2000: the answer is bounded to 2,000 tokens, then continued", async () => {
    const provider = new ScriptedProvider([{ text: "first half, ", stopReason: "max_tokens" }, { text: "second half." }]);
    const r = await cli(["--non-interactive", "x"], workspace(), { provider, env: { PILOTE_DEV_RESPONSE_TOKEN_LIMIT: "2000" } });
    expect(provider.requests[0]!.maxOutputTokens).toBe(2000);
    expect(r.stdout).toBe("first half, second half.\n");
  });

  test("SPEC-API-002/CA-04 — debug journal active: no authentication header value appears", async () => {
    const ws = workspace();
    const log = join(ws.root, "debug.log");
    await cli(["--non-interactive", "--debug", "--debug-output", log, "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]), env: { OPENAI_API_KEY: "sk-local-secret-123" } });
    const text = readFileSync(log, "utf8");
    expect(text).toContain("[api] request");
    expect(text).toContain('"authorization":"••••"');
    expect(text).not.toContain("sk-local-secret-123");
  });
});

describe("SPEC-MOT-001 truncation and interruption", () => {
  test("SPEC-MOT-001/CA-05 — a response cut by the output limit: a continuation is requested and the final text is complete", async () => {
    const b = bench([{ text: "Hello ", stopReason: "max_tokens" }, { text: "world", stopReason: "max_tokens" }, { text: "!" }]);
    const r = await runTurn(b.deps, "x", signal());
    expect(r.finalText).toBe("Hello world!");
    expect(b.provider.requests).toHaveLength(3);
    // No prefill: the continuation is a new user message after the truncated answer.
    const last = b.provider.requests[1]!.history[b.provider.requests[1]!.history.length - 1]!;
    expect(last.role).toBe("user");
  });

  test("SPEC-MOT-001/CA-06 — a tool running and the user interrupts: the tool is cancelled, a synthetic result is kept and the session remains usable", async () => {
    const slow = probe("slow", { readOnly: false, run: (_, s) => new Promise((resolve) => s.addEventListener("abort", () => resolve(textOutcome("cancelled by signal", true)))) });
    const b = bench([{ toolCalls: [{ name: "slow", input: {} }] }, { text: "back" }], { tools: [slow] });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const r = await runTurn(b.deps, "go", controller.signal);
    expect(r.stopCause).toBe("interrupted");
    expect(b.toolResults()[0]!.content[0]!.text).toMatch(/interrupted|Interrupted/);
    const next = await runTurn(b.deps, "again", signal());
    expect(next.stopCause).toBe("completed");
    expect(next.finalText).toBe("back");
  });
});

describe("SPEC-MOT-046 unproductive loops", () => {
  const read = (input: unknown = { path: "/same" }) => ({ toolCalls: [{ name: "look", input }] });

  test("SPEC-MOT-046/CA-01 — interactive session, threshold 3, the same command three times: the third is suspended and the user chooses", async () => {
    const calls: unknown[] = [];
    const choices: string[] = [];
    const human = {
      request: async (): Promise<HumanAnswer> => ({ answer: "yes" }),
      loopDetected: async (info: { toolName: string; count: number }): Promise<LoopChoice> => {
        choices.push(`${info.toolName}:${info.count}`);
        return { choice: "stop" };
      },
    };
    const cmd = { toolCalls: [{ name: "run_cmd", input: { command: "make" } }] };
    const b = bench([cmd, cmd, cmd, { text: "never" }], { tools: [probe("run_cmd", { readOnly: false, calls })], authorities: { human }, mode: "ask", executor: { loopGuard: new LoopGuard(3) } });
    const r = await runTurn(b.deps, "go", signal());
    expect(choices).toEqual(["run_cmd:3"]);
    expect(calls).toHaveLength(2);
    expect(r.stopCause).toBe("interrupted");
  });

  test("SPEC-MOT-046/CA-02 — automated run, threshold 3, the same read three times: the third is not executed and the model gets the reminder", async () => {
    const calls: unknown[] = [];
    const b = bench([read(), read(), read(), { text: "changing approach" }], { tools: [probe("look", { calls })], executor: { loopGuard: new LoopGuard(3) } });
    const r = await runTurn(b.deps, "go", signal());
    expect(calls).toHaveLength(2);
    expect(b.toolResults()[2]!.content[0]!.text).toBe(REPETITION_REMINDER(3));
    expect(r.stopCause).toBe("completed");
  });

  test("SPEC-MOT-046/CA-03 and SPEC-MOT-001/CA-10 — automated run, a new loop after the reminder: the turn stops with the unproductive loop cause", async () => {
    const b = bench([read(), read(), read(), read(), { text: "never" }], { tools: [probe("look")], executor: { loopGuard: new LoopGuard(3) } });
    const r = await runTurn(b.deps, "go", signal());
    expect(r.stopCause).toBe("unproductive_loop");
    expect(b.provider.requests).toHaveLength(4);
  });

  test("SPEC-MOT-046/CA-04 — three edits failing on the same error with different inputs: the third error carries the reminder; the next call is not blocked", async () => {
    const calls: unknown[] = [];
    const failing = probe("edit_x", { readOnly: false, calls, run: async () => textOutcome("Passage not found.", true) });
    const e = (n: number) => ({ toolCalls: [{ name: "edit_x", input: { n } }] });
    const b = bench([e(1), e(2), e(3), e(4), { text: "done" }], { tools: [failing], executor: { loopGuard: new LoopGuard(3) } });
    await runTurn(b.deps, "go", signal());
    const results = b.toolResults();
    expect(results[1]!.content).toHaveLength(1);
    expect(results[2]!.content[1]!.text).toContain("failed 3 times in a row with the same error");
    expect(calls).toHaveLength(4);
  });

  test("SPEC-MOT-046/CA-05 — repeated consultations of a background task: no loop", async () => {
    const calls: unknown[] = [];
    const poll = { toolCalls: [{ name: "background_output", input: { id: "t1" } }] };
    const b = bench([poll, poll, poll, poll, { text: "done" }], { tools: [probe("background_output", { calls })], executor: { loopGuard: new LoopGuard(3) } });
    const r = await runTurn(b.deps, "go", signal());
    expect(calls).toHaveLength(4);
    expect(r.stopCause).toBe("completed");
  });

  test("SPEC-MOT-046/CA-06 — three identical calls, the second refused by the permissions: only two are counted; no refusal enters the failures", async () => {
    const calls: unknown[] = [];
    let n = 0;
    const human = { request: async (): Promise<HumanAnswer> => (++n === 2 ? { answer: "no" } : { answer: "yes" }) };
    const cmd = { toolCalls: [{ name: "run_cmd", input: { command: "make" } }] };
    const b = bench([cmd, cmd, cmd, { text: "done" }], { tools: [probe("run_cmd", { readOnly: false, needsPermission: true, calls })], authorities: { human }, mode: "ask", executor: { loopGuard: new LoopGuard(3) } });
    await runTurn(b.deps, "go", signal());
    expect(calls).toHaveLength(2);
    expect(b.toolResults()[1]!.content[0]!.text).toContain("Action denied");
    expect(b.toolResults()[2]!.content[0]!.text).toBe("ok");
  });

  test("SPEC-MOT-046/CA-07 — interactive session, loop detected, the user chooses continue: the call goes through before_tool and the permission decision", async () => {
    const order: string[] = [];
    const hooks = { ...NEUTRAL_HOOKS, beforeTool: async () => (order.push("before_tool"), {}) };
    const human = {
      request: async (): Promise<HumanAnswer> => (order.push("permission"), { answer: "yes" }),
      loopDetected: async (): Promise<LoopChoice> => (order.push("loop"), { choice: "continue" }),
    };
    const cmd = { toolCalls: [{ name: "run_cmd", input: { command: "make" } }] };
    const b = bench([cmd, cmd, cmd, { text: "done" }], { tools: [probe("run_cmd", { readOnly: false, needsPermission: true })], authorities: { human }, hooks, mode: "ask", executor: { loopGuard: new LoopGuard(3) } });
    await runTurn(b.deps, "go", signal());
    expect(order).toEqual(["before_tool", "permission", "before_tool", "permission", "loop", "before_tool", "permission"]);
  });

  test("SPEC-MOT-046/CA-08 — a control command repeated three times, separated by wait calls: the third is not suspended", async () => {
    const calls: unknown[] = [];
    const check = { toolCalls: [{ name: "status", input: {} }] };
    const wait = { toolCalls: [{ name: "wait", input: { seconds: 1 } }] };
    const b = bench([check, wait, check, wait, check, { text: "done" }], { tools: [probe("status", { calls }), probe("wait")], executor: { loopGuard: new LoopGuard(3) } });
    await runTurn(b.deps, "go", signal());
    expect(calls).toHaveLength(3);
  });

  test("SPEC-MOT-046/CA-09 — three identical reads of a log whose content changes: the third is not suspended", async () => {
    let n = 0;
    const calls: unknown[] = [];
    const log = probe("read_log", { calls, run: async () => textOutcome(`line ${++n}`) });
    const r3 = { toolCalls: [{ name: "read_log", input: { path: "/var/log/x" } }] };
    const b = bench([r3, r3, r3, { text: "done" }], { tools: [log], executor: { loopGuard: new LoopGuard(3) } });
    await runTurn(b.deps, "go", signal());
    expect(calls).toHaveLength(3);
  });
});
