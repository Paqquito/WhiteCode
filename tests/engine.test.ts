import { describe, expect, test } from "bun:test";
import { Conversation } from "../src/engine/conversation";
import type { EngineEvent } from "../src/engine/events";
import { runTurn, type LoopDeps } from "../src/engine/loop";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";
import { currentPlatform } from "../src/platform/system";
import type { PermissionMode } from "../src/config/settings-schema";
import type { Rule } from "../src/permissions/rules";
import { ToolRegistry } from "../src/tools/registry";
import { textOutcome, type Tool, type ToolContext } from "../src/tools/types";
import { testModel, testToolFields, workspace } from "./helpers/env";
import { ScriptedProvider, type ScriptedResponse } from "./helpers/scripted-provider";

const model = testModel("default");

interface Trace {
  readonly log: string[];
}

/** Test tool: records start and end, sleeps `ms`, read-only or not. */
function probe(name: string, readOnly: boolean, trace: Trace): Tool<{ id: string; ms?: number }> {
  return {
    name,
    inputSchema: { type: "object", properties: { id: { type: "string" }, ms: { type: "integer" } }, required: ["id"], additionalProperties: false },
    description: () => `${name} probe`,
    flags: () => ({ readOnly, concurrencySafe: readOnly, destructive: false, requiresPermission: true, openWorld: false }),
    isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: (i) => `${name} ${i.id}`,
    async execute(input) {
      trace.log.push(`start ${input.id}`);
      await new Promise((r) => setTimeout(r, input.ms ?? 5));
      trace.log.push(`end ${input.id}`);
      return textOutcome(`result ${input.id}`);
    },
  };
}

function setup(script: ScriptedResponse[], options: { tools?: Tool<never>[]; toolset?: string[]; maxIterations?: number; mode?: PermissionMode; rules?: Rule[] } = {}) {
  const ws = workspace();
  const provider = new ScriptedProvider(script);
  const registry = ToolRegistry.build({ platform: currentPlatform(), home: ws.home }, { toolset: options.toolset, extraTools: options.tools?.map((tool) => ({ tool })) });
  const conversation = new Conversation([{ text: "system", cacheBoundary: true }], registry.list().map((t) => ({ name: t.name, description: t.description({ platform: currentPlatform(), home: ws.home }), inputSchema: t.inputSchema })));
  const events: EngineEvent[] = [];
  const deps: LoopDeps = {
    provider,
    model,
    conversation,
    hooks: NEUTRAL_HOOKS,
    maxOutputTokens: 1000,
    thinking: { enabled: true, mode: "adaptive", budgetTokens: 2000, showSummaries: false },
    maxIterations: options.maxIterations,
    maxOutputContinuations: 3,
    maxStopHookContinuations: 5,
    emit: (e) => events.push(e),
    executor: {
      registry,
      hooks: NEUTRAL_HOOKS,
      authorities: {},
      concurrency: 8,
      toolTimeoutMs: 5_000,
      permissionContext: () => ({ mode: options.mode ?? "no_prompt", rules: options.rules ?? [], sessionAllows: [], managedRulesOnly: false, cwd: ws.project, home: ws.home, platform: currentPlatform() }),
      toolContext: (signal): ToolContext => ({
        platform: currentPlatform(),
        home: ws.home,
        cwd: ws.project,
        allowedDirectories: [ws.project],
        signal,
        ...testToolFields(),
      }),
    },
  };
  return { deps, provider, conversation, events, ws };
}

const toolResults = (c: Conversation) =>
  c.messages.flatMap((m) => (m.role === "user" ? m.parts.filter((p) => p.type === "tool_result") : [])) as unknown as Array<{ callId: string; isError: boolean; content: Array<{ type: string; text?: string }> }>;

describe("SPEC-MOT-001 agentic loop", () => {
  test("SPEC-MOT-001/CA-01 — a response without tools is streamed and ends naturally", async () => {
    const { deps, events } = setup([{ text: "Bonjour" }]);
    const r = await runTurn(deps, "salut", new AbortController().signal);
    expect(r.stopCause).toBe("completed");
    expect(r.finalText).toBe("Bonjour");
    expect(events.some((e) => e.type === "text_delta" && e.text === "Bonjour")).toBe(true);
  });

  test("SPEC-MOT-001/CA-02 — two tools executed, results returned in call order, then the final answer", async () => {
    const trace = { log: [] };
    const { deps, conversation } = setup([{ toolCalls: [{ name: "slow", input: { id: "a", ms: 40 } }, { name: "slow", input: { id: "b", ms: 1 } }] }, { text: "fini" }], { tools: [probe("slow", true, trace) as Tool<never>] });
    const r = await runTurn(deps, "go", new AbortController().signal);
    expect(r.finalText).toBe("fini");
    expect(toolResults(conversation).map((t) => t.content[0]!.text)).toEqual(["result a", "result b"]);
  });

  test("SPEC-MOT-001/CA-03 — an unknown tool yields an error result and the turn goes on", async () => {
    const { deps, conversation } = setup([{ toolCalls: [{ name: "does_not_exist", input: {} }] }, { text: "ok" }]);
    const r = await runTurn(deps, "go", new AbortController().signal);
    expect(r.stopCause).toBe("completed");
    const [result] = toolResults(conversation);
    expect(result!.isError).toBe(true);
    expect(result!.content[0]!.text).toContain("Unknown tool");
  });

  test("SPEC-MOT-001/CA-04 — with 2 iterations max and a tool on each response, the turn stops on the iteration limit", async () => {
    const trace = { log: [] };
    const step = { toolCalls: [{ name: "probe", input: { id: "x" } }] };
    const { deps, conversation } = setup([step, step, step, step], { tools: [probe("probe", true, trace) as Tool<never>], maxIterations: 2 });
    const r = await runTurn(deps, "go", new AbortController().signal);
    expect(r.stopCause).toBe("iteration_limit");
    expect(r.iterations).toBe(2);
    expect(conversation.pendingCalls()).toEqual([]); // RG-01: every call has its result
  });
});

describe("SPEC-MOT-002 tool execution", () => {
  test("SPEC-MOT-002/CA-01 — three reads start without waiting for one another", async () => {
    const trace = { log: [] as string[] };
    const calls = ["a", "b", "c"].map((id) => ({ name: "read", input: { id, ms: 30 } }));
    const { deps } = setup([{ toolCalls: calls }, { text: "ok" }], { tools: [probe("read", true, trace) as Tool<never>] });
    await runTurn(deps, "go", new AbortController().signal);
    expect(trace.log.slice(0, 3)).toEqual(["start a", "start b", "start c"]);
  });

  test("SPEC-MOT-002/CA-02 — read, write, read: the write waits for the first read, the second read waits for the write", async () => {
    const trace = { log: [] as string[] };
    const { deps } = setup(
      [{ toolCalls: [{ name: "read", input: { id: "r1", ms: 20 } }, { name: "write", input: { id: "w", ms: 20 } }, { name: "read", input: { id: "r2", ms: 1 } }] }, { text: "ok" }],
      { tools: [probe("read", true, trace) as Tool<never>, probe("write", false, trace) as Tool<never>] },
    );
    await runTurn(deps, "go", new AbortController().signal);
    expect(trace.log).toEqual(["start r1", "end r1", "start w", "end w", "start r2", "end r2"]);
  });

  test("SPEC-MOT-002/CA-03 — the second call ends first, results keep the call order", async () => {
    const trace = { log: [] as string[] };
    const { deps, conversation } = setup([{ toolCalls: [{ name: "read", input: { id: "first", ms: 50 } }, { name: "read", input: { id: "second", ms: 1 } }] }, { text: "ok" }], { tools: [probe("read", true, trace) as Tool<never>] });
    await runTurn(deps, "go", new AbortController().signal);
    expect(trace.log.indexOf("end second")).toBeLessThan(trace.log.indexOf("end first"));
    expect(toolResults(conversation).map((t) => t.content[0]!.text)).toEqual(["result first", "result second"]);
  });

  test("SPEC-MOT-002/CA-04 — SPEC-OUT-001/CA-04 — parameters violating the schema: not executed, the model gets the deviations", async () => {
    const trace = { log: [] as string[] };
    const { deps, conversation } = setup([{ toolCalls: [{ name: "read", input: { ms: 1, extra: true } }] }, { text: "ok" }], { tools: [probe("read", true, trace) as Tool<never>] });
    await runTurn(deps, "go", new AbortController().signal);
    expect(trace.log).toEqual([]);
    const [result] = toolResults(conversation);
    expect(result!.isError).toBe(true);
    expect(result!.content[0]!.text).toContain("missing required field `id`");
    expect(result!.content[0]!.text).toContain("unexpected field `extra`");
  });

  test("E-022 — a write in a refused response is not executed; reads already received are", async () => {
    const trace = { log: [] as string[] };
    const { deps, conversation } = setup([{ toolCalls: [{ name: "read", input: { id: "r" } }, { name: "write", input: { id: "w" } }], stopReason: "refusal" }], {
      tools: [probe("read", true, trace) as Tool<never>, probe("write", false, trace) as Tool<never>],
    });
    const r = await runTurn(deps, "go", new AbortController().signal);
    expect(r.stopCause).toBe("refusal");
    expect(trace.log).toEqual(["start r", "end r"]);
    const results = toolResults(conversation);
    expect(results).toHaveLength(2);
    expect(results[1]!.content[0]!.text).toContain("Not executed");
  });
});

describe("SPEC-OUT-001 registry", () => {
  test("SPEC-OUT-001/CA-02 — --toolset \"\" presents no tool to the model", async () => {
    const { deps, provider } = setup([{ text: "ok" }], { toolset: [] });
    await runTurn(deps, "go", new AbortController().signal);
    expect(provider.requests[0]!.tools).toEqual([]);
  });
});

describe("D-12 append-only history", () => {
  test("D-12 — across iterations every request extends the previous one; assistant content is echoed verbatim", async () => {
    const trace = { log: [] as string[] };
    const step = { text: "thinking about it", toolCalls: [{ name: "probe", input: { id: "x" } }] };
    const { deps, provider, conversation } = setup([step, step, { text: "done" }], { tools: [probe("probe", true, trace) as Tool<never>] });
    const r = await runTurn(deps, "go", new AbortController().signal); // ScriptedProvider throws on any prefix violation
    expect(r.stopCause).toBe("completed");
    expect(provider.requests).toHaveLength(3);
    const firstAssistant = conversation.messages.find((m) => m.role === "assistant")!;
    expect(JSON.stringify(provider.requests[2]!.history[1])).toBe(JSON.stringify(firstAssistant));
    expect(JSON.stringify(firstAssistant)).toContain("signature");
  });

  test("TECH — an interrupted turn keeps a valid history (one result per call)", async () => {
    const trace = { log: [] as string[] };
    const controller = new AbortController();
    const { deps, conversation } = setup([{ toolCalls: [{ name: "probe", input: { id: "x", ms: 200 } }] }], { tools: [probe("probe", true, trace) as Tool<never>] });
    setTimeout(() => controller.abort(), 30);
    const r = await runTurn(deps, "go", controller.signal);
    expect(r.stopCause).toBe("interrupted");
    expect(conversation.pendingCalls()).toEqual([]);
  });
});

describe("D-21 corrections of the evaluation of 2026-10-02", () => {
  test("D-21, D-22 — correction D-9: a refusal without authority names the call and says that only this call is refused", async () => {
    const outside = workspace().write("home/notes.txt", "notes");
    const { deps, conversation } = setup([{ toolCalls: [{ name: "read_file", input: { path: outside } }] }, { text: "done" }], { mode: "no_prompt" });
    await runTurn(deps, "go", new AbortController().signal);
    const [result] = toolResults(conversation);
    expect(result!.isError).toBe(true);
    expect(result!.content[0]!.text).toContain(`Not allowed in this run: read_file(${outside}).`);
    expect(result!.content[0]!.text).toContain("Nobody can approve it during this run");
    expect(result!.content[0]!.text).toContain("Only this exact call is refused: other commands, such as the ones the task asks for, may be allowed by the rules, so still run them.");
  });

  test("D-21 — correction D-10 (E-072): a final response without text is relaunched once", async () => {
    const { deps, provider } = setup([{ text: "" }, { text: "8080" }]);
    const r = await runTurn(deps, "Which port?", new AbortController().signal);
    expect(r.stopCause).toBe("completed");
    expect(r.finalText).toBe("8080");
    expect(r.iterations).toBe(2);
    const last = provider.requests[1]!.history.at(-1)!;
    expect(last.role === "user" && last.parts[0]!.type === "text" && last.parts[0]!.text).toContain("contained no answer");
  });

  test("D-21 — correction D-10 (E-072): a response still empty after the relaunch ends the turn with a warning", async () => {
    const { deps, events, provider } = setup([{ text: "" }, { text: "" }, { text: "never asked" }]);
    const r = await runTurn(deps, "Which port?", new AbortController().signal);
    expect(r.stopCause).toBe("completed");
    expect(r.iterations).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(events.some((e) => e.type === "warning" && e.message === "Le modèle n'a produit aucune réponse.")).toBe(true);
  });
});
