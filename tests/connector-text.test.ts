// Supports: SPEC-MOT-035 (an explicitly declared compatible extension, never assumed for a public service).
import { expect, test } from "bun:test";
import { OpenAICompatibleProvider, buildChatRequest } from "../src/providers/openai-compatible";
import type { ModelRequest } from "../src/providers/types";
import { cli, testModel, workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { startFakeOpenAI } from "./helpers/fake-openai-server";
const block = { type: "connector_text", text: "Private document for the connector.", summary: "Document summary", signature: "opaque-fixture-signature", connector: "documents" };
function request(enabled = true, protocol = "v1"): ModelRequest {
  return { model: { ...testModel("test-medium"), providerOptions: { connectorTextProtocol: protocol } }, system: [], tools: [], history: [], maxOutputTokens: 100, thinking: { enabled: false, mode: "adaptive", budgetTokens: 0, showSummaries: false }, connectorText: enabled } as ModelRequest;
}
const fragments = [{ index: 0, type: "connector_text", text: "Private document " }, { index: 0, type: "connector_text", text: "for the connector.", summary: block.summary, signature: block.signature, connector: block.connector, complete: true }];
async function capture(parts: readonly unknown[], enabled = true) {
  const server = startFakeOpenAI([{ text: "Visible answer", connectorTextFragments: parts }]);
  try {
    const provider = new OpenAICompatibleProvider({ baseURL: server.baseURL, timeoutMs: 2000, idleTimeoutMs: 2000, headers: {} });
    const events = [];
    for await (const event of provider.stream(request(enabled), new AbortController().signal)) events.push(event);
    return { events, completed: events.find(event => event.type === "message_complete")! };
  } finally { server.stop(); }
}
test("TECH — connector text is requested only with both the runtime setting and an explicit compatible v1 contract", () => {
  expect((buildChatRequest(request()) as unknown as Record<string, unknown>).connector_text_summary).toEqual({ version: 1 });
  expect((buildChatRequest(request(false)) as unknown as Record<string, unknown>).connector_text_summary).toBeUndefined();
  expect((buildChatRequest(request(true, "unknown")) as unknown as Record<string, unknown>).connector_text_summary).toBeUndefined();
});
test("SPEC-MOT-035/CA-01 — streamed connector text and its signature are echoed intact without cache markers", async () => {
  const result = await capture(fragments), native = result.completed.assistant.native.content as Record<string, unknown>;
  expect(native.connector_text_blocks).toEqual([block]);
  const body = buildChatRequest({ ...request(), history: [result.completed.assistant] });
  expect((body.messages[0] as unknown as Record<string, unknown>).connector_text_blocks).toEqual([block]);
  expect(JSON.stringify(body)).not.toContain("cache_control");
  const switched = buildChatRequest({ ...request(false), history: [result.completed.assistant] });
  expect(JSON.stringify(switched)).not.toContain(block.signature);
  const otherProvider = buildChatRequest({ ...request(), history: [{ ...result.completed.assistant, native: { provider: "other-provider", content: native } }] });
  expect(JSON.stringify(otherProvider)).not.toContain(block.signature);
});
test("SPEC-MOT-035/CA-02 — connector fragments never become text deltas or the assistant answer", async () => {
  const result = await capture(fragments);
  expect(result.completed.assistant.text).toBe("Visible answer");
  expect(result.events.filter(event => event.type === "text_delta").map(event => event.text).join("")).toBe("Visible answer");
});
test("TECH — an inconsistent, unsigned, oversized or unsolicited connector block is discarded with an incident", async () => {
  for (const parts of [[...fragments.slice(0, 1), { ...fragments[1], type: "text" }], [{ index: 0, type: "connector_text", text: "Unsigned", complete: true }], [{ index: 0, type: "connector_text", text: "x".repeat(1024 * 1024 + 1), signature: "fixture", complete: true }]]) {
    const result = await capture(parts), native = result.completed.assistant.native.content as Record<string, unknown>;
    expect(native.connector_text_blocks).toBeUndefined();
    expect((result.completed as unknown as { connectorTextIncidents: number }).connectorTextIncidents).toBeGreaterThan(0);
  }
  const disabled = await capture(fragments, false);
  expect((disabled.completed.assistant.native.content as Record<string, unknown>).connector_text_blocks).toBeUndefined();
});

function configuration(baseUrl: string) {
  return { api: { provider: "openai_compatible", baseUrl }, models: { selected: "connector-fixture", extraCatalog: [{ id: "connector-fixture", provider: "openai_compatible", family: "fixture", label: "Connector fixture", contextWindow: 128000, maxOutputTokens: 1024, capabilities: { toolCalling: true }, providerOptions: { connectorTextProtocol: "v1" } }] } };
}
test("SPEC-MOT-035/CA-01 — two actual CLI requests retain a signed block in history and replay it to the declared local service", async () => {
  const server = startFakeOpenAI([{ text: "FIRST_DONE", connectorTextFragments: fragments }, { text: "SECOND_DONE" }]);
  try {
    const result = await cli(["--non-interactive", "--request-format", "jsonl", "--result-format", "jsonl"], workspace(), { stdin: ["first", "second"].map(text => JSON.stringify({ type: "user", content: text })).join("\n") + "\n", userConfig: configuration(server.baseURL), env: { OPENAI_API_KEY: "fixture-connector-not-a-real-key" } });
    expect(result.code).toBe(0); expect(result.stdout).toContain("SECOND_DONE"); expect(server.requests).toHaveLength(2);
    const first = server.requests[0]!.body, second = server.requests[1]!.body;
    expect(first.connector_text_summary).toEqual({ version: 1 });
    const assistant = (second.messages as Array<Record<string, unknown>>).find(message => message.role === "assistant");
    expect(assistant?.connector_text_blocks).toEqual([block]);
    expect(JSON.stringify(second)).not.toContain("cache_control");
    expect(result.stdout).not.toContain(block.text); expect(result.stdout).not.toContain(block.signature);
  } finally { server.stop(); }
}, 15000);

test("SPEC-MOT-035/CA-02 — the actual terminal displays only a discreet label and reveals connector text in the full transcript", async () => {
  const server = startFakeOpenAI([{ text: "CONNECTOR_DONE", connectorTextFragments: fragments }]), abort = new AbortController();
  const run = interactive([], workspace(), { userConfig: configuration(server.baseURL), signal: abort.signal, extra: { providerFactory: options => new OpenAICompatibleProvider({ ...options, providerId: "openai_compatible" }) } });
  try {
    await run.idle(); run.type("Prepare a connector document" + KEY.enter);
    await run.waitFor(text => text.includes("CONNECTOR_DONE"));
    expect(run.all().join("\n")).toContain("Contenu transmis à documents");
    expect(run.all().join("\n")).not.toContain(block.text);
    run.type("\u001bt");
    await run.waitFor(text => text.includes("Transcription"));
    run.type("/"); run.type("Private document"); run.type(KEY.enter);
    await run.waitFor(text => text.includes("Private document for the connector."));
    run.type(KEY.escape);
  } finally { abort.abort(); await run.done; server.stop(); }
}, 15000);

test("TECH — disabling the user setting stops capability requests in the actual composition", async () => {
  const server = startFakeOpenAI([{ text: "SETTING_OFF", connectorTextFragments: fragments }]);
  try {
    const result = await cli(["--non-interactive", "Continue."], workspace(), { userConfig: { ...configuration(server.baseURL), mcp: { connectorText: { enabled: false } } }, env: { OPENAI_API_KEY: "fixture-connector-not-a-real-key" } });
    expect(result.code).toBe(0); expect(result.stdout).toContain("SETTING_OFF");
    expect(server.requests[0]!.body.connector_text_summary).toBeUndefined();
    expect(result.stdout).not.toContain(block.text); expect(result.stderr).not.toContain("Contenu transmis");
  } finally { server.stop(); }
}, 15000);

test("TECH — a valid signed connector-only response completes without an empty-answer retry", async () => {
  const server = startFakeOpenAI([{ connectorTextFragments: fragments }]);
  try {
    const result = await cli(["--non-interactive", "--result-format", "jsonl", "Prepare the connector content."], workspace(), { userConfig: configuration(server.baseURL) });
    expect(result.code).toBe(0); expect(server.requests).toHaveLength(1);
    expect(result.stdout).toContain('"haltReason":"completed"');
    expect(result.stdout).not.toContain(block.text); expect(result.stderr).not.toContain("aucune réponse");
  } finally { server.stop(); }
}, 15000);

test("TECH — reopening a persisted signed connector block preserves full-transcript access without exposing it as a model answer", async () => {
  const server = startFakeOpenAI([{ text: "PERSISTED_DONE", connectorTextFragments: fragments }]), ws = workspace();
  const first = await cli(["--non-interactive", "Prepare the document."], ws, { userConfig: configuration(server.baseURL) });
  expect(first.code).toBe(0); expect(first.stdout).not.toContain(block.text);
  const abort = new AbortController(), run = interactive(["--reopen-last"], ws, { userConfig: configuration(server.baseURL), signal: abort.signal, extra: { providerFactory: options => new OpenAICompatibleProvider({ ...options, providerId: "openai_compatible" }) } });
  try {
    await run.waitFor(text => text.includes("Session reprise"), "history replay");
    expect(run.all().join("\n")).not.toContain(block.text);
    run.type("\u001bt"); await run.waitFor(text => text.includes("Transcription"));
    run.type("/"); run.type("Private document"); run.type(KEY.enter);
    await run.waitFor(text => text.includes(block.text));
    expect(server.requests).toHaveLength(1);
  } finally { abort.abort(); await run.done; server.stop(); }
}, 15000);
