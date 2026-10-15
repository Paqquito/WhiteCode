// Supports: SPEC-MOT-042 (real append-only journal and compaction archive).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { AssistantTrace } from "../src/memory/assistant-trace";
import { compactConversation } from "../src/engine/compaction";
import { ContextMeter } from "../src/engine/context-meter";
import { bench } from "./helpers/engine";
import { workspace } from "./helpers/env";

test("SPEC-MOT-042/CA-01 — actual compaction queues a reduced archive without tool output and does not wait for disk", async () => {
  const ws = workspace(),
    b = bench([{ text: "Summary." }]),
    trace = new AssistantTrace({
      root: join(ws.configHome, "assistant-memory", "sample"),
      redact: (t) => t,
      report: () => {},
    });
  b.conversation.appendUser([{ type: "text", text: "Keep the objective." }]);
  b.conversation.appendAssistant({
    role: "assistant",
    text: "Inspecting.",
    toolCalls: [
      { callId: "r1", name: "read_file", input: { path: "sample.txt" } },
    ],
    native: {
      provider: "openai_compatible",
      content: { secretNative: "OMIT_NATIVE" },
    },
  });
  b.conversation.appendUser([
    {
      type: "tool_result",
      callId: "r1",
      isError: false,
      content: [{ type: "text", text: "LARGE_RESULT".repeat(20000) }],
    },
  ]);
  const outcome = await compactConversation(
    {
      ...b.deps,
      meter: new ContextMeter({
        model: b.deps.model,
        outputReserveTokens: 512,
      }),
      summaryMaxTokens: 512,
      rebuildSystem: () => b.conversation.system,
      restoredElements: () => [],
      archive: (messages, segment) => trace.archive(messages, segment),
    },
    undefined,
    true,
    new AbortController().signal,
  );
  expect(outcome.kind).toBe("compacted");
  expect(trace.pending).toBe(1);
  await trace.flush();
  const files = readdirSync(join(trace.root, "segments"));
  expect(files).toHaveLength(1);
  const text = readFileSync(join(trace.root, "segments", files[0]!), "utf8");
  expect(text).toContain("Keep the objective.");
  expect(text).toContain("read_file");
  expect(text).not.toContain("LARGE_RESULT");
  expect(text).not.toContain("OMIT_NATIVE");
});

test("SPEC-MOT-042/CA-02 — a long lived journal tool appends after midnight to the new date without rewriting yesterday", async () => {
  const ws = workspace();
  let now = new Date(2026, 9, 15, 23, 59, 58);
  const trace = new AssistantTrace({
    root: join(ws.configHome, "assistant-memory", "sample"),
    redact: (t) => t,
    report: () => {},
    now: () => now,
  });
  const tool = trace.journalTool(),
    context = {
      signal: new AbortController().signal,
      readDenied: () => false,
      writeDenied: () => false,
    } as never;
  expect(
    (await tool.execute({ text: "First observation." }, context)).isError,
  ).toBe(false);
  const old = join(trace.root, "journal", "2026", "10", "15.md"),
    before = readFileSync(old, "utf8");
  now = new Date(2026, 9, 16, 0, 0, 2);
  expect(
    (await tool.execute({ text: "Second observation." }, context)).isError,
  ).toBe(false);
  expect(readFileSync(old, "utf8")).toBe(before);
  expect(
    readFileSync(join(trace.root, "journal", "2026", "10", "16.md"), "utf8"),
  ).toContain("00:00:02 Second observation.");
  expect(tool.description({} as never)).not.toContain("2026");
  expect(
    (
      await tool.execute({ text: "forbidden" }, {
        signal: new AbortController().signal,
        readDenied: () => true,
      } as never)
    ).isError,
  ).toBe(true);
});
