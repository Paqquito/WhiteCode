import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { startFakeOpenAI } from "./helpers/fake-openai-server";

function configuration(baseUrl: string) {
  return {
    api: { provider: "openai_compatible", baseUrl, maxRetries: 0 },
    models: { selected: "test-cache-service", identifierMap: { small: "test-cache-service", medium: "test-cache-service", large: "test-cache-service" }, extraCatalog: [{ id: "test-cache-service", provider: "openai_compatible", family: "cache-fixture", label: "Cache fixture", contextWindow: 100000, maxOutputTokens: 500, capabilities: { toolCalling: true, cacheEditing: true }, providerOptions: { cacheEditingProtocol: "v1" } }] },
    context: { autoCompact: { enabled: false }, microCompact: { triggerRatio: 0, keepRecent: 0 }, cachedMicroCompact: { triggerRatio: 0, keepRecent: 0, minAgeMinutes: 0 } },
  };
}

test("SPEC-MOT-015/CA-01 — the CLI sends cache-edit identifiers while retaining every earlier system, assistant and result byte", async () => {
  const ws = workspace(), first = ws.write("project/first.txt", "FIRST-CACHED-CONTENT"), second = ws.write("project/second.txt", "SECOND-CACHED-CONTENT");
  const server = startFakeOpenAI([
    { toolCalls: [{ id: "old-read", name: "read_file", arguments: JSON.stringify({ path: first }) }] },
    { cacheEdits: { version: 1, applied_tool_results: ["old-read"] }, toolCalls: [{ id: "new-read", name: "read_file", arguments: JSON.stringify({ path: second }) }] },
    { cacheEdits: { version: 1, applied_tool_results: ["new-read"] }, text: "Finished." },
  ]);
  try {
    const result = await cli(["--non-interactive", "--toolset", "read_file", "Read both files."], ws, { userConfig: configuration(server.baseURL) });
    expect(result.code, result.stderr).toBe(0);
    expect(server.requests).toHaveLength(3);
    const messages = server.requests.map(request => request.body["messages"] as unknown[]);
    expect(messages[1]!.slice(0, messages[0]!.length)).toEqual(messages[0]!);
    expect(messages[2]!.slice(0, messages[1]!.length)).toEqual(messages[1]!);
    expect(JSON.stringify(messages[0])).toContain("Older tool results may be removed from the service cache");
    expect(JSON.stringify(messages[2])).toContain("FIRST-CACHED-CONTENT");
    expect(server.requests[0]!.body["cache_edits"]).toBeUndefined();
    expect(server.requests[1]!.body["cache_edits"]).toEqual({ version: 1, remove_tool_results: ["old-read"] });
  } finally { server.stop(); }
});

test("SPEC-MOT-015/CA-02 — a later CLI request targets the new result and never the already acknowledged result", async () => {
  const ws = workspace(), file = ws.write("project/item.txt", "CACHED-ITEM");
  const server = startFakeOpenAI([
    { toolCalls: [{ id: "first", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
    { cacheEdits: { version: 1, applied_tool_results: ["first"] }, toolCalls: [{ id: "second", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
    { cacheEdits: { version: 1, applied_tool_results: ["second"] }, text: "Done." },
  ]);
  try {
    const result = await cli(["--non-interactive", "--toolset", "read_file", "Read twice."], ws, { userConfig: configuration(server.baseURL) });
    expect(result.code, result.stderr).toBe(0);
    expect(server.requests[1]!.body["cache_edits"]).toEqual({ version: 1, remove_tool_results: ["first"] });
    expect(server.requests[2]!.body["cache_edits"]).toEqual({ version: 1, remove_tool_results: ["second"] });
  } finally { server.stop(); }
});

test("TECH — an explicit unsupported-cache response disables editing and retries through ordinary compaction", async () => {
  const ws = workspace(), file = ws.write("project/item.txt", "OLD-CACHE-FALLBACK");
  const server = startFakeOpenAI([
    { toolCalls: [{ id: "first", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
    { status: 400, errorCode: "cache_edit_unsupported" },
    { text: "Recovered." },
  ]);
  try {
    const result = await cli(["--non-interactive", "--toolset", "read_file", "Read."], ws, { userConfig: configuration(server.baseURL) });
    expect(result.code, result.stderr).toBe(0);
    expect(server.requests).toHaveLength(3);
    expect(server.requests[1]!.body["cache_edits"]).toEqual({ version: 1, remove_tool_results: ["first"] });
    expect(server.requests[2]!.body["cache_edits"]).toBeUndefined();
    expect(JSON.stringify(server.requests[2]!.body["messages"])).not.toContain("OLD-CACHE-FALLBACK");
    expect(result.stderr).toContain("cache");
  } finally { server.stop(); }
});

test("TECH — reopening a persisted CLI session keeps acknowledged result IDs from being edited again", async () => {
  const ws = workspace(), file = ws.write("project/item.txt", "PERSISTED-CACHED-ITEM");
  const server = startFakeOpenAI([
    { toolCalls: [{ id: "persisted-read", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
    { cacheEdits: { version: 1, applied_tool_results: ["persisted-read"] }, text: "Read." },
    { text: "Resumed." },
  ]);
  try {
    const original = await cli(["--non-interactive", "--toolset", "read_file", "Read."], ws, { userConfig: configuration(server.baseURL) });
    expect(original.code, original.stderr).toBe(0);
    const resumed = await cli(["--non-interactive", "--reopen-last", "--toolset", "read_file", "Continue."], ws, { userConfig: configuration(server.baseURL) });
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(server.requests).toHaveLength(3);
    expect(server.requests[2]!.body["cache_edits"]).toBeUndefined();
  } finally { server.stop(); }
});

test("TECH — an unrelated HTTP 400 is not retried as an unsupported cache capability", async () => {
  const ws = workspace(), file = ws.write("project/item.txt", "CACHE-BAD-REQUEST");
  const server = startFakeOpenAI([{ toolCalls: [{ id: "read", name: "read_file", arguments: JSON.stringify({ path: file }) }] }, { status: 400, errorCode: "invalid_argument" }]);
  try {
    const result = await cli(["--non-interactive", "--toolset", "read_file", "Read."], ws, { userConfig: configuration(server.baseURL) });
    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(2);
  } finally { server.stop(); }
});

test("TECH — an unacknowledged result is offered again rather than being falsely recorded as edited", async () => {
  const ws = workspace(), file = ws.write("project/item.txt", "UNACKNOWLEDGED-CACHE");
  const server = startFakeOpenAI([
    { toolCalls: [{ id: "first", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
    { toolCalls: [{ id: "second", name: "read_file", arguments: JSON.stringify({ path: file }) }] },
    { text: "Done." },
  ]);
  try {
    const result = await cli(["--non-interactive", "--toolset", "read_file", "Read twice."], ws, { userConfig: configuration(server.baseURL) });
    expect(result.code, result.stderr).toBe(0);
    expect(server.requests[2]!.body["cache_edits"]).toEqual({ version: 1, remove_tool_results: ["first", "second"] });
  } finally { server.stop(); }
});
