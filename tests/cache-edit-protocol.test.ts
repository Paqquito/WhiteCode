import { expect, test } from "bun:test";
import { capabilitiesOf } from "../src/providers/catalog";
import { effectiveCapabilities } from "../src/providers/adapters";
import { buildChatRequest } from "../src/providers/openai-compatible";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible";
import { startFakeOpenAI } from "./helpers/fake-openai-server";
import type { ModelRequest } from "../src/providers/types";
import { testModel } from "./helpers/env";

function request(enabled = true, protocol: string | undefined = "v1"): ModelRequest {
  const base = testModel("test-medium");
  return {
    model: { ...base, capabilities: { ...base.capabilities, cacheEditing: enabled }, providerOptions: protocol ? { cacheEditingProtocol: protocol } : {} },
    system: [{ text: "Required instructions." }], tools: [], history: [{ role: "user", parts: [{ type: "text", text: "Continue." }] }],
    maxOutputTokens: 100, thinking: { enabled: false, mode: "adaptive", budgetTokens: 0, showSummaries: false }, cachedToolEdits: ["old-read"],
  };
}

test("TECH — targeted cache editing defaults off and unsupported adapters explicitly degrade the declared capability", () => {
  expect(capabilitiesOf(undefined).cacheEditing).toBe(false);
  expect(effectiveCapabilities(request().model.capabilities, "openai_compatible").capabilities.cacheEditing).toBe(true);
  expect(effectiveCapabilities(request().model.capabilities, "anthropic").capabilities.cacheEditing).toBe(false);
  expect(effectiveCapabilities(request().model.capabilities, "openai").capabilities.cacheEditing).toBe(false);
});

test("TECH — SDK cache acknowledgements must be a unique subset of the identifiers in the actual request", async () => {
  for (const applied of [["old-read"], ["unrequested"], ["old-read", "old-read"]]) {
    const server = startFakeOpenAI([{ text: "done", cacheEdits: { version: 1, applied_tool_results: applied } }]);
    try {
      const provider = new OpenAICompatibleProvider({ baseURL: server.baseURL, timeoutMs: 2000, idleTimeoutMs: 2000, headers: {} });
      const events = async () => { const out = []; for await (const event of provider.stream(request(), new AbortController().signal)) out.push(event); return out; };
      if (applied.length === 1 && applied[0] === "old-read") {
        const result = (await events()).find(event => event.type === "message_complete");
        expect(result?.cacheEditing).toEqual({ applied: ["old-read"] });
      } else await expect(events()).rejects.toThrow("cache");
      expect(server.requests[0]!.body["cache_edits"]).toEqual({ version: 1, remove_tool_results: ["old-read"] });
    } finally { server.stop(); }
  }
});

test("TECH — a declared v1 service receives only opaque result identifiers alongside unchanged chat messages", () => {
  const body = buildChatRequest(request()) as unknown as Record<string, unknown>;
  expect(body["cache_edits"]).toEqual({ version: 1, remove_tool_results: ["old-read"] });
  const disabled = buildChatRequest(request(false)) as unknown as Record<string, unknown>;
  expect(disabled["cache_edits"]).toBeUndefined();
  expect(disabled["messages"]).toEqual(body["messages"]);
  expect((buildChatRequest(request(true, "unsupported")) as unknown as Record<string, unknown>)["cache_edits"]).toBeUndefined();
  expect((buildChatRequest(request(true, "")) as unknown as Record<string, unknown>)["cache_edits"]).toBeUndefined();
});
