import { expect, test } from "bun:test";
import { CachedMicroCompaction, restoredCacheState } from "../src/engine/cached-micro-compaction";
import { Conversation } from "../src/engine/conversation";
import type { HistoryMessage } from "../src/providers/types";

const settings = { triggerRatio: 0.5, keepRecent: 1, minAgeMinutes: 1 };
const history = (): HistoryMessage[] => [
  { role: "assistant", text: "", toolCalls: [{ callId: "old-read", name: "read_file", input: {} }, { callId: "write", name: "write_file", input: {} }, { callId: "new-read", name: "read_file", input: {} }], native: { provider: "test", content: {} } },
  { role: "user", parts: [
    { type: "tool_result", callId: "old-read", isError: false, content: [{ type: "text", text: "old content" }] },
    { type: "tool_result", callId: "write", isError: false, content: [{ type: "text", text: "write receipt" }] },
    { type: "tool_result", callId: "new-read", isError: false, content: [{ type: "text", text: "new content" }] },
  ] },
];

test("TECH — cached compaction selects old reads above the threshold while preserving the exact history", () => {
  let now = 0;
  const cache = new CachedMicroCompaction(() => now), messages = history(), bytes = JSON.stringify(messages);
  expect(cache.plan(messages, 0, 0.4, settings)).toEqual([]);
  now = 60_001;
  expect(cache.plan(messages, 0, 0.6, settings)).toEqual(["old-read"]);
  expect(JSON.stringify(messages)).toBe(bytes);
});

test("TECH — only acknowledged offered results are edited once; a full history replacement forgets the old edit registry", () => {
  const cache = new CachedMicroCompaction(() => 100), messages = history(), immediate = { ...settings, minAgeMinutes: 0 };
  expect(cache.plan(messages, 0, 0.6, immediate)).toEqual(["old-read"]);
  expect(cache.acknowledge(["old-read"])).toBe(true);
  expect(cache.plan(messages, 0, 0.6, immediate)).toEqual([]);
  expect(cache.plan(messages, 1, 0.6, immediate)).toEqual(["old-read"]);
});

test("TECH — an unacknowledged edit can be retried and an unknown acknowledgement never edits an unoffered result", () => {
  const cache = new CachedMicroCompaction(() => 100), messages = history(), immediate = { ...settings, minAgeMinutes: 0 };
  expect(cache.plan(messages, 0, 0.6, immediate)).toEqual(["old-read"]);
  expect(cache.acknowledge(["write"])).toBe(false);
  expect(cache.plan(messages, 0, 0.6, immediate)).toEqual(["old-read"]);
  expect(cache.acknowledge(["old-read", "old-read"])).toBe(false);
});

test("TECH — rejecting the capability disables cache edits for the session even after full compaction", () => {
  const cache = new CachedMicroCompaction(() => 100);
  cache.reject();
  expect(cache.available).toBe(false);
  expect(cache.plan(history(), 0, 0.9, { ...settings, minAgeMinutes: 0 })).toEqual([]);
  expect(cache.plan(history(), 1, 0.9, { ...settings, minAgeMinutes: 0 })).toEqual([]);
});

test("TECH — duplicate result identifiers are preserved without producing ambiguous cache edits", () => {
  const cache = new CachedMicroCompaction(() => 100), messages = history();
  messages.push({ role: "user", parts: [{ type: "tool_result", callId: "old-read", isError: false, content: [{ type: "text", text: "ambiguous" }] }] });
  expect(cache.plan(messages, 0, 0.9, { ...settings, minAgeMinutes: 0 })).toEqual([]);
});

test("TECH — temporarily projected-away results retain their edit state within the same history generation", () => {
  const cache = new CachedMicroCompaction(() => 100), messages = history(), immediate = { ...settings, minAgeMinutes: 0 };
  expect(cache.plan(messages, 0, 0.9, immediate)).toEqual(["old-read"]);
  expect(cache.acknowledge(["old-read"])).toBe(true);
  expect(cache.plan([], 0, 0.9, immediate)).toEqual([]);
  expect(cache.plan(messages, 0, 0.9, immediate)).toEqual([]);
});

test("TECH — history generations change only for full replacement, not presentation or tool changes", () => {
  const conversation = new Conversation([], []);
  conversation.replaceSystem([{ text: "New presentation" }]); conversation.replaceTools([]); conversation.resetCache();
  expect(conversation.historyGeneration).toBe(0);
  conversation.startSegment([], [], [{ type: "text", text: "Summary" }]);
  expect(conversation.historyGeneration).toBe(1);
});

test("TECH — full compaction forgets persisted edits while rejection and corrupt metadata stay disabled", () => {
  const records = [{ type: "system", data: { event: "cache_edit_state", state: { version: 1, edited: ["old-read"], rejected: true } } }, { type: "compaction", data: {} }];
  expect(restoredCacheState(records)).toEqual({ version: 1, edited: [], rejected: true });
  const corrupted = new CachedMicroCompaction(() => 0, { restored: { version: 1, edited: ["old-read", "old-read"], rejected: false } });
  expect(corrupted.available).toBe(false);
  const cache = new CachedMicroCompaction(() => 0, { save: () => { throw Error("Metadata cannot be saved"); } });
  expect(cache.plan(history(), 0, 0.9, { ...settings, minAgeMinutes: 0 })).toEqual(["old-read"]);
  expect(cache.acknowledge(["old-read"])).toBe(false);
  expect(cache.available).toBe(false);
});
