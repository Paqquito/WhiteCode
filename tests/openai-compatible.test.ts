// Reference provider `openai_compatible` (decision D-10). Local fake server; optional integration test on a real local server.
import { afterEach, describe, expect, test } from "bun:test";
import { runTurn } from "../src/engine/loop";
import { bench, probe } from "./helpers/engine";
import { buildChatRequest, OpenAICompatibleProvider, toChatMessages } from "../src/providers/openai-compatible";
import type { ModelEvent, ModelRequest } from "../src/providers/types";
import { cli, loadIdentity, testModel, workspace } from "./helpers/env";
import { startFakeOpenAI, type FakeChatServer } from "./helpers/fake-openai-server";
import { ScriptedProvider } from "./helpers/scripted-provider";

const identity = loadIdentity();

function request(model = "test-medium", overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    model: testModel(model),
    system: [{ text: "stable", cacheBoundary: true }, { text: "variable" }],
    tools: [
      { name: "zeta_tool", description: "z", inputSchema: { type: "object", properties: {} } },
      { name: "read_file", description: "r", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
    ],
    history: [{ role: "user", parts: [{ type: "text", text: "hi" }] }],
    maxOutputTokens: 4000,
    thinking: { enabled: true, mode: "adaptive", budgetTokens: 16_000, showSummaries: false },
    effort: "high",
    ...overrides,
  };
}

let server: FakeChatServer | undefined;
afterEach(() => server?.stop());

const withServer = (baseURL: string, extra: Record<string, unknown> = {}) => ({ api: { baseUrl: baseURL }, ...extra });

describe("openai_compatible: request", () => {
  test("D-10 — streamed chat request: one system message, function tools sorted, output limit, tool choice never forced", () => {
    const body = buildChatRequest(request()) as unknown as Record<string, unknown>;
    expect(body["stream"]).toBe(true);
    expect(body["stream_options"]).toEqual({ include_usage: true });
    expect(body["max_tokens"]).toBe(4000);
    expect(body["tool_choice"]).toBeUndefined();
    const messages = body["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0]).toEqual({ role: "system", content: "stable\n\nvariable" });
    expect((body["tools"] as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(["read_file", "zeta_tool"]);
    // No effort, no thinking switch: the model declares none of them.
    expect(body["reasoning_effort"]).toBeUndefined();
  });

  test("TECH — images of a tool result follow the tool message in a user message (a tool message carries text only)", () => {
    const caps = { ...testModel("test-medium").capabilities, images: true };
    const messages = toChatMessages([], [
      { role: "user", parts: [{ type: "tool_result", callId: "c1", isError: false, content: [{ type: "text", text: "Image x" }, { type: "image", mediaType: "image/png", dataBase64: "AAAA" }] }] },
    ], caps) as unknown as Array<{ role: string; content: unknown }>;
    expect(messages[0]).toEqual({ role: "tool", tool_call_id: "c1", content: "Image x\n[image attached below]" } as never);
    expect(messages[1]!.role).toBe("user");
    expect(messages[1]!.content).toEqual([
      { type: "text", text: "Images returned by the tool calls above:" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
  });

  test("E-043 — server-specific details come from providerOptions of the catalogue entry", () => {
    const on = buildChatRequest(request("test-options")) as unknown as Record<string, unknown>;
    expect(on["max_completion_tokens"]).toBe(4000);
    expect(on["max_tokens"]).toBeUndefined();
    expect(on["reasoning_effort"]).toBe("high");
    expect(on["think"]).toBe(true);
    const off = buildChatRequest(request("test-options", { thinking: { enabled: false, mode: "adaptive", budgetTokens: 1, showSummaries: false } })) as unknown as Record<string, unknown>;
    expect(off["think"]).toBe(false);
  });
});

describe("openai_compatible: end to end through the SDK", () => {
  test("D-10 — a tool call streamed in fragments is executed; the result goes back as a tool message after the verbatim assistant message", async () => {
    const ws = workspace();
    const file = ws.write("project/note.txt", "ARTICHOKE\n");
    server = startFakeOpenAI([{ reasoning: "let me read", toolCalls: [{ id: "call_a", name: "read_file", arguments: JSON.stringify({ path: file }) }] }, { text: "The word is ARTICHOKE." }]);
    const r = await cli(["--non-interactive", "--result-format", "json", "What is the word?"], ws, { userConfig: withServer(server.baseURL) });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ result: "The word is ARTICHOKE.", haltReason: "completed", iterations: 2, usage: { inputTokens: 100, outputTokens: 18 } });
    expect(server.requests[0]!.path).toBe("/v1/chat/completions");
    expect(server.requests[0]!.body["model"]).toBe("test-medium");
    const second = server.requests[1]!.body["messages"] as Array<Record<string, unknown>>;
    const assistantIndex = second.findIndex(message => message["role"] === "assistant");
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(second[assistantIndex]).toEqual({ role: "assistant", content: null, tool_calls: [{ id: "call_a", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: file }) } }] });
    expect(second[assistantIndex + 1]).toMatchObject({ role: "tool", tool_call_id: "call_a" });
    expect(String(second[assistantIndex + 1]!["content"])).toContain("ARTICHOKE");
    // Append-only: the second request extends the first one.
    const first = server.requests[0]!.body["messages"] as unknown[];
    expect(JSON.stringify(second.slice(0, first.length))).toBe(JSON.stringify(first));
    expect(r.stdout).not.toContain("let me read");
  });

  test("D-10 — without key no authorization header is sent; with OPENAI_API_KEY a bearer token is", async () => {
    server = startFakeOpenAI([{ text: "a" }, { text: "b" }]);
    await cli(["--non-interactive", "x"], workspace(), { userConfig: withServer(server.baseURL) });
    expect(server.requests[0]!.headers["authorization"]).toBeUndefined();
    expect(server.requests[0]!.headers["user-agent"]).toBe(identity.get("USER_AGENT"));
    await cli(["--non-interactive", "x"], workspace(), { userConfig: withServer(server.baseURL), env: { OPENAI_API_KEY: "local-test-key" } });
    expect(server.requests[1]!.headers["authorization"]).toBe("Bearer local-test-key");
  });

  test("TECH — the base URL can come from OPENAI_BASE_URL", async () => {
    server = startFakeOpenAI([{ text: "via env" }]);
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: { api: { baseUrl: null } }, env: { OPENAI_BASE_URL: server.baseURL } });
    expect(r.stdout).toBe("via env\n");
  });

  test("D-21 — E-072: a response with reasoning only is relaunched; it goes back with an empty content, never null", async () => {
    server = startFakeOpenAI([{ reasoning: "the answer is 8080" }, { text: "8080" }]);
    const r = await cli(["--non-interactive", "--result-format", "json", "Which port?"], workspace(), { userConfig: withServer(server.baseURL) });
    expect(JSON.parse(r.stdout)).toMatchObject({ result: "8080", haltReason: "completed", iterations: 2 });
    const second = server.requests[1]!.body["messages"] as Array<Record<string, unknown>>;
    const assistantIndex = second.findIndex(message => message["role"] === "assistant");
    expect(assistantIndex).toBeGreaterThanOrEqual(0);
    expect(second[assistantIndex]).toEqual({ role: "assistant", content: "" });
    expect(second[assistantIndex + 1]).toMatchObject({ role: "user" });
    expect(String(JSON.stringify(second[assistantIndex + 1]))).toContain("contained no answer");
  });

  test("TECH — invalid JSON arguments are reported to the model, never executed", async () => {
    server = startFakeOpenAI([{ toolCalls: [{ name: "read_file", arguments: "{\"path\": \"/x" }] }, { text: "retry" }]);
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: withServer(server.baseURL) });
    expect(r.code).toBe(0);
    const tool = (server.requests[1]!.body["messages"] as Array<Record<string, unknown>>).find((m) => m["role"] === "tool")!;
    expect(String(tool["content"])).toContain("Invalid input");
  });

  test("TECH — errors of the server are classified: unreachable server, unknown model", async () => {
    const down = await cli(["--non-interactive", "x"], workspace(), { userConfig: withServer("http://127.0.0.1:9/v1", { api: { baseUrl: "http://127.0.0.1:9/v1", maxRetries: 0 } }) });
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("Connexion au serveur du modèle impossible");
    server = startFakeOpenAI([{ status: 404 }]);
    const provider = new OpenAICompatibleProvider({ baseURL: server.baseURL, timeoutMs: 5000, idleTimeoutMs: 5000, headers: {} });
    let kind = "";
    try {
      for await (const _ of provider.stream(request(), new AbortController().signal) as AsyncIterable<ModelEvent>) void _;
    } catch (e) {
      kind = (e as { kind: string }).kind;
    }
    expect(kind).toBe("not_found");
  });
});

describe("D-09 / D-10 configuration of the provider and the model", () => {
  test("E-039 — without a configured provider the run stops with code 2 and explains how to configure it", async () => {
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: null });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Aucun fournisseur de modèles n'est configuré");
    expect(r.stderr).toContain("openai_compatible");
    expect(r.stdout).toBe("");
  });

  test("E-042 — openai_compatible without base URL stops with code 2", async () => {
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: { api: { baseUrl: null } } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("api.baseUrl");
  });

  test("E-040 — a tier without associated model stops with code 2 and names models.identifierMap", async () => {
    const r = await cli(["--non-interactive", "x"], workspace(), { userConfig: { models: { identifierMap: { medium: null } } } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("models.identifierMap.medium");
  });

  test("D-10 — a known model declared without tool calls is refused at start-up", async () => {
    const declared = await cli(["--non-interactive", "--model", "test-no-tools", "x"], workspace());
    expect(declared.code).toBe(2);
    expect(declared.stderr).toContain("toolCalling");
  });

  test("SPEC-API-006/CA-02 — an identifier absent from the catalogue runs with minimal capabilities and a warning", async () => {
    const ws = workspace(), path = ws.write("project/minimal.txt", "MINIMAL_TOOLS_28\n");
    server = startFakeOpenAI([{ toolCalls: [{ id: "minimal_read", name: "read_file", arguments: JSON.stringify({ path }) }] }, { text: "MINIMAL_TOOLS_28" }]);
    const result = await cli(["--non-interactive", "--model", "some-local-model", "x"], ws, { userConfig: withServer(server.baseURL, { permissions: { allowRules: ["read_file"] } }) });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("MINIMAL_TOOLS_28\n");
    expect(result.stderr).toContain("absent du catalogue");
    expect(result.stderr).toContain("capacités minimales");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[0]!.body.model).toBe("some-local-model");
    expect(JSON.stringify(server.requests[0]!.body.tools)).toContain("read_file");
    expect(JSON.stringify(server.requests[1]!.body.messages)).toContain("MINIMAL_TOOLS_28");
    expect(server.requests[0]!.body.reasoning_effort).toBeUndefined();
  });

  test("TECH — a model declared without tools cannot execute unexpected streamed tool calls", async () => {
    const calls: unknown[] = [];
    const b = bench([{ toolCalls: [{ name: "probe", input: {} }] }], { model: "test-no-tools", tools: [probe("probe", { calls })] });
    const result = await runTurn(b.deps, "x", new AbortController().signal);
    expect(result.stopCause).toBe("error");
    expect(calls).toHaveLength(0);
    expect(b.provider.requests[0]!.tools).toHaveLength(0);
  });

  test("TECH — a model declared without tools rejects tool calls carried only by the completed message", async () => {
    class CompleteOnly extends ScriptedProvider {
      override async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        for await (const event of super.stream(request, signal)) if (event.type !== "tool_call") yield event;
      }
    }
    const calls: unknown[] = [], provider = new CompleteOnly([{ toolCalls: [{ name: "probe", input: {} }] }]);
    const b = bench([], { model: "test-no-tools", tools: [probe("probe", { calls })], deps: { provider } });
    const result = await runTurn(b.deps, "x", new AbortController().signal);
    expect(result.stopCause).toBe("error");
    expect(provider.requests[0]!.tools).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  test("E-041 — a local model declared in models.extraCatalog is usable; a distribution model cannot be redeclared", async () => {
    server = startFakeOpenAI([{ text: "local ok" }]);
    const entry = { id: "some-local-model", provider: "openai_compatible", family: "local", label: "Local", contextWindow: 8192, maxOutputTokens: 2048, capabilities: { toolCalling: true } };
    const shadow = { ...entry, id: "test-no-tools" };
    const oversized = await cli(["--non-interactive", "--model", "some-local-model", "x"], workspace(), { userConfig: withServer(server.baseURL, { models: { extraCatalog: [entry, shadow] } }) });
    expect(oversized.code).toBe(1); expect(oversized.stderr).toContain("--toolset"); expect(server.requests).toHaveLength(0);
    const r = await cli(["--non-interactive", "--toolset", "read_file", "--model", "some-local-model", "x"], workspace(), { userConfig: withServer(server.baseURL, { models: { extraCatalog: [entry, shadow] } }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("local ok\n");
    expect(r.stderr).toContain("test-no-tools appartient au catalogue de la distribution");
    expect(server.requests[0]!.body["max_tokens"]).toBe(2048);
    expect((server.requests[0]!.body["tools"] as Array<{ function: { name: string } }>).map(tool => tool.function.name)).toEqual(["read_file"]);
  });

  test("D-16 — an entry of models.extraCatalog without an explicit toolCalling is ignored with a warning", async () => {
    server = startFakeOpenAI([{ text: "minimal" }]);
    const entry = { id: "undeclared-model", provider: "openai_compatible", family: "local", label: "Local", contextWindow: 8192, maxOutputTokens: 2048 };
    const r = await cli(["--non-interactive", "--model", "undeclared-model", "x"], workspace(), { userConfig: withServer(server.baseURL, { models: { extraCatalog: [entry] } }) });
    expect(r.stderr).toContain('undeclared-model de models.extraCatalog ne déclare pas "capabilities": { "toolCalling": … }');
    expect(r.code).toBe(0);
    expect(JSON.stringify(server.requests[0]!.body.tools)).toContain("read_file");
  });

  test("D-16 — models added by models.extraCatalog stay subject to the managed models.allowList; the user cannot widen it", async () => {
    const entry = { id: "added-model", provider: "openai_compatible", family: "local", label: "Local", contextWindow: 8192, maxOutputTokens: 2048, capabilities: { toolCalling: true } };
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ models: { allowList: ["medium", "test-small"] } }));
    const provider = new ScriptedProvider([{ text: "never" }]);
    const refused = await cli(["--non-interactive", "--model", "added-model", "x"], ws, { provider, userConfig: { models: { extraCatalog: [entry], allowList: ["added-model"] } } });
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain("Ce modèle n'est pas autorisé par votre configuration : added-model. Modèles autorisés : medium, test-small.");
    expect(provider.requests).toHaveLength(0);
    // An alias of the list covers its tier; an identifier of the list is allowed.
    const medium = await cli(["--non-interactive", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(medium.code).toBe(0);
    const large = await cli(["--non-interactive", "--model", "large", "x"], ws, { provider: new ScriptedProvider([{ text: "never" }]) });
    expect(large.code).toBe(2);
  });
});

// Optional integration test on a real local server (decision D-10): set TEST_OPENAI_COMPATIBLE_BASE_URL and TEST_OPENAI_COMPATIBLE_MODEL.
const LOCAL_URL = process.env["TEST_OPENAI_COMPATIBLE_BASE_URL"];
const LOCAL_MODEL = process.env["TEST_OPENAI_COMPATIBLE_MODEL"];
describe("openai_compatible: optional integration on a local server", () => {
  test.skipIf(!LOCAL_URL || !LOCAL_MODEL)(
    "TECH — a real local model reads a file with read_file and answers",
    async () => {
      const ws = workspace();
      ws.write("project/secret.txt", "The code word is PERIWINKLE.\n");
      const entry = { id: LOCAL_MODEL!, provider: "openai_compatible", family: "local", label: "Local", contextWindow: 32768, maxOutputTokens: 2048, capabilities: { toolCalling: true } };
      const events: string[] = [];
      const r = await cli(["--non-interactive", "--model", LOCAL_MODEL!, "--result-format", "json", "Read the file secret.txt in the working directory with the read_file tool (use its absolute path) and tell me the code word."], ws, {
        userConfig: { api: { baseUrl: LOCAL_URL }, models: { extraCatalog: [entry] } },
        extra: { onEvent: (e) => void (e.type === "tool_call" && events.push(e.name)) },
      });
      expect(r.code).toBe(0);
      expect(events).toContain("read_file");
      expect(JSON.parse(r.stdout).result.toUpperCase()).toContain("PERIWINKLE");
    },
    300_000,
  );
});
