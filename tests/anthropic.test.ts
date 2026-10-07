// Optional Anthropic adapter (decision D-11): configured explicitly, fictitious models of the test catalogue.
import { afterEach, describe, expect, test } from "bun:test";
import { AnthropicProvider, buildParams, toMessageParams } from "../src/providers/anthropic";
import type { ModelEvent, ModelRequest } from "../src/providers/types";
import { cli, loadIdentity, testModel, workspace } from "./helpers/env";
import { startFakeAnthropic, type FakeServer } from "./helpers/fake-anthropic-server";

const identity = loadIdentity();
const vendor = (id: string) => testModel(id, "anthropic");
const ANTHROPIC = { api: { provider: "anthropic" } };

function request(model = "vendor-always", overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: vendor(model),
    system: [{ text: "stable", cacheBoundary: true }, { text: "variable" }],
    tools: [
      { name: "zeta_tool", description: "z", inputSchema: { type: "object", properties: {} } },
      { name: "read_file", description: "r", inputSchema: { type: "object", properties: {} } },
    ],
    history: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    maxOutputTokens: 64_000,
    thinking: { enabled: true, mode: "adaptive", budgetTokens: 16_000, showSummaries: false },
    effort: "high",
    ...overrides,
  };
}

let server: FakeServer | undefined;
afterEach(() => server?.stop());

describe("Anthropic adapter: request built from the catalogue capabilities", () => {
  test("D-11 — tool input streaming, no forced tool choice, no prefill, explicit effort, sorted tools", () => {
    const p = buildParams(request());
    expect(p.tools?.map((t) => (t as { name: string }).name)).toEqual(["read_file", "zeta_tool"]);
    for (const t of p.tools ?? []) expect((t as { eager_input_streaming?: boolean }).eager_input_streaming).toBe(true);
    expect(p.tool_choice).toBeUndefined();
    expect(p.output_config).toEqual({ effort: "high" });
    expect(p.thinking).toEqual({ type: "adaptive" });
    expect(p.messages[p.messages.length - 1]!.role).toBe("user");
    expect((p.system as Array<{ cache_control?: unknown }>)[0]!.cache_control).toEqual({ type: "ephemeral" });
  });

  test("SPEC-API-002/CA-01 — the user agent sent to the provider is the resolved USER_AGENT", async () => {
    server = startFakeAnthropic([{ text: "Bonjour" }]);
    const r = await cli(["--non-interactive", "--model", "vendor-always", "salut"], workspace(), { userConfig: ANTHROPIC, env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "test-key-not-a-secret" } });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("Bonjour\n");
    const headers = server.requests[0]!.headers;
    expect(headers["user-agent"]).toBe(identity.get("USER_AGENT"));
    expect(headers[`${identity.get("HTTP_HEADER_PREFIX")}entrypoint`]).toBe("non-interactive");
    expect(server.requests[0]!.body["stream"]).toBe(true);
  });

  test("TECH — end to end through the SDK: tool call streamed, executed, result sent after the verbatim assistant content", async () => {
    const ws = workspace();
    const file = ws.write("project/hello.txt", "HELLO WORLD\n");
    server = startFakeAnthropic([{ toolUses: [{ id: "toolu_1", name: "read_file", input: { path: file } }] }, { text: "Le fichier dit bonjour." }]);
    const r = await cli(["--non-interactive", "--model", "vendor-always", "--result-format", "json", "lis hello.txt"], ws, { userConfig: ANTHROPIC, env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "k" } });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ result: "Le fichier dit bonjour.", haltReason: "completed", iterations: 2 });
    const second = server.requests[1]!.body["messages"] as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(second[1]!.content[0]).toMatchObject({ type: "thinking", signature: "sig-abc" });
    expect(second[2]!.content[0]).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: false });
    const first = server.requests[0]!.body["messages"] as unknown[];
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
  });

  test("TECH — a refusal ends the turn with the refusal cause", async () => {
    server = startFakeAnthropic([{ text: "", stopReason: "refusal", stopDetails: { type: "refusal", category: "cyber", explanation: "x" } }]);
    const r = await cli(["--non-interactive", "--model", "vendor-always", "--result-format", "json", "x"], workspace(), { userConfig: ANTHROPIC, env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "k" } });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ haltReason: "refusal", refusalCategory: "cyber" });
  });

  test("TECH — the adapter needs the user's own key", async () => {
    const r = await cli(["--non-interactive", "--model", "vendor-always", "x"], workspace(), { userConfig: ANTHROPIC });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ANTHROPIC_API_KEY");
  });

  test("TECH — provider errors are classified from the SDK error classes (overloaded) and idle streams are aborted", async () => {
    server = startFakeAnthropic([{ status: 529 }, { hang: true }]);
    const provider = new AnthropicProvider({ apiKey: "k", baseURL: server.url, timeoutMs: 5000, idleTimeoutMs: 150, headers: {} });
    const kindOf = async () => {
      try {
        for await (const _ of provider.stream(request(), new AbortController().signal) as AsyncIterable<ModelEvent>) void _;
      } catch (e) {
        return (e as { kind: string }).kind;
      }
      return "";
    };
    expect(await kindOf()).toBe("overloaded");
    expect(await kindOf()).toBe("idle_timeout");
  });
});

describe("SPEC-MOT-023 thinking from the `thinking` capability (D-13)", () => {
  test("SPEC-MOT-023/CA-01 — a model without thinking capability gets no thinking configuration", () => {
    const p = buildParams(request("vendor-always", { model: testModel("test-medium") }));
    expect(p.thinking).toBeUndefined();
    expect(p.output_config).toBeUndefined();
  });

  test("SPEC-MOT-023/CA-02 — signed thinking blocks of the previous turn are sent back unchanged", () => {
    const native = [{ type: "thinking", thinking: "", signature: "sig-xyz" }, { type: "text", text: "a" }];
    const p = buildParams(request("vendor-always", { history: [{ role: "user", parts: [{ type: "text", text: "q" }] }, { role: "assistant", text: "a", toolCalls: [], native: { provider: "anthropic", content: native } }, { role: "user", parts: [{ type: "text", text: "q2" }] }] }));
    expect(p.messages[1]).toEqual({ role: "assistant", content: native as never });
  });

  test("SPEC-MOT-023/CA-03 — thinking disabled on an `optional` model: no thinking requested", () => {
    const off = { enabled: false, mode: "adaptive" as const, budgetTokens: 16_000, showSummaries: false };
    expect(buildParams(request("vendor-optional", { thinking: off })).thinking).toEqual({ type: "between_tools" });
    expect(buildParams(request("vendor-budget", { thinking: off, effort: undefined })).thinking).toBeUndefined();
  });

  test("E-024 — `always`: thinking stays on and the user is warned; a budget model gets a budget and no effort", async () => {
    const off = { enabled: false, mode: "adaptive" as const, budgetTokens: 16_000, showSummaries: false };
    expect(buildParams(request("vendor-always", { thinking: off })).thinking).toEqual({ type: "adaptive" });
    const budget = buildParams(request("vendor-budget"));
    expect(budget.thinking).toEqual({ type: "enabled", budget_tokens: 16_000 });
    expect(budget.output_config).toBeUndefined();
    server = startFakeAnthropic([{ text: "ok" }]);
    const r = await cli(["--non-interactive", "--model", "vendor-always", "x"], workspace(), { userConfig: { ...ANTHROPIC, thinking: { enabled: false } }, env: { ANTHROPIC_BASE_URL: server.url, ANTHROPIC_API_KEY: "k" } });
    expect(r.stderr).toContain("ne peut pas être désactivée");
  });
});

describe("D-21 corrections of the evaluation of 2026-10-02", () => {
  test("D-21 — E-073: correction D-11 withdrawn, an empty text block is sent back verbatim with the tool call", () => {
    const native = [{ type: "text", text: "" }, { type: "tool_use", id: "t1", name: "read_file", input: { path: "a" } }];
    const messages = toMessageParams(
      [
        { role: "user", parts: [{ type: "text", text: "q" }] },
        { role: "assistant", text: "", toolCalls: [{ callId: "t1", name: "read_file", input: { path: "a" } }], native: { provider: "anthropic", content: native } },
        { role: "user", parts: [{ type: "tool_result", callId: "t1", isError: false, content: [{ type: "text", text: "x" }] }] },
      ],
      false,
    );
    expect(messages[1]).toEqual({ role: "assistant", content: native as never });
  });
});
