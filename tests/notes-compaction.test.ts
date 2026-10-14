// Supports: SPEC-MOT-017/CA-01/02 (notes strategy and classic fallback).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { compactConversation, type CompactionDeps } from "../src/engine/compaction";
import { ContextMeter } from "../src/engine/context-meter";
import { TranscriptWriter, readTranscript } from "../src/session/transcript";
import { activeChain, rebuildHistory } from "../src/session/sessions";
import { bench } from "./helpers/engine";
import { workspace } from "./helpers/env";

function seed(b: ReturnType<typeof bench>, writer?: TranscriptWriter): void {
  for (let n = 0; n < 4; n++) {
    const parts = [{ type: "text" as const, text: `Request ${n}. ` + (n < 3 ? "Prior context. ".repeat(600) : "Keep this last request.") }];
    const assistant = { role: "assistant" as const, text: `Answer ${n}.`, toolCalls: [], native: { provider: "openai_compatible", content: { role: "assistant", content: `Answer ${n}.` } } };
    b.conversation.appendUser(parts); b.conversation.appendAssistant(assistant);
    writer?.append("user", { content: parts }); writer?.append("assistant", { provider: "openai_compatible", content: assistant.native.content });
  }
}
function dependencies(b: ReturnType<typeof bench>, writer?: TranscriptWriter): CompactionDeps {
  return { ...b.deps, meter: new ContextMeter({ model: b.deps.model, outputReserveTokens: 512 }), summaryMaxTokens: 512, transcript: writer, rebuildSystem: () => b.conversation.system, restoredElements: () => [] };
}

test("SPEC-MOT-017/CA-01 — fresh session notes avoid a summary request and preserve recent exchanges after compaction and reopening", async () => {
  const ws = workspace(), writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project }), b = bench([]);
  try {
    seed(b, writer); const recent = structuredClone(b.conversation.messages.slice(-2));
    const result = await compactConversation({ ...dependencies(b, writer), sessionNotes: () => ({ content: "# Session notes\n\n## Goal\nWork completed with evidence.\n", coveredMessages: b.conversation.messages.length, segment: b.conversation.segment }), notesKeepRecentMessages: 2, notesKeepRecentTokens: 1 }, undefined, true, new AbortController().signal);
    expect(result.kind).toBe("compacted"); expect(b.provider.requests).toHaveLength(0); expect(b.conversation.messages.slice(-2)).toEqual(recent);
    writer.flush(); const records = readTranscript(writer.path).records; const compacted = records.find(record => record.type === "compaction"); expect(compacted?.data["strategy"]).toBe("session_notes");
    const rebuilt = rebuildHistory(activeChain(records).chain); expect(rebuilt.messages.slice(-2)).toEqual(recent); expect(JSON.stringify(rebuilt.messages[0])).toContain("Work completed with evidence.");
  } finally { writer.close(); }
});

test("SPEC-MOT-017/CA-02 — absent or stale notes use classic model compaction", async () => {
  for (const stale of [false, true]) {
    const b = bench([{ text: "Classic summary of the prior work." }]); seed(b);
    const result = await compactConversation({ ...dependencies(b), sessionNotes: () => stale ? { content: "Stale notes.", coveredMessages: 1000, segment: 99 } : undefined }, undefined, true, new AbortController().signal);
    expect(result.kind).toBe("compacted"); expect(b.provider.requests).toHaveLength(1); expect(b.provider.requests[0]!.purpose).toBe("compaction");
  }
});

test("TECH — notes compaction retains complete tool pairs and resolves image references without rewriting native responses", async () => {
  const ws = workspace(), writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project }), b = bench([]);
  try {
    seed(b, writer);
    const image = { type: "image" as const, mediaType: "image/png" as const, dataBase64: Buffer.from("IMAGE_REPLAY_WITNESS").toString("base64") };
    b.conversation.appendUser([{ type: "text", text: "Inspect this retained image. " + "Recent detail. ".repeat(400) }, image]);
    b.conversation.appendAssistant({ role: "assistant", text: "", toolCalls: [{ callId: "retained-call", name: "read_file", input: { path: "/example" } }], native: { provider: "openai_compatible", content: { untouched: "NATIVE_RESPONSE_WITNESS" } } });
    b.conversation.appendUser([{ type: "tool_result", callId: "retained-call", isError: false, content: [{ type: "text", text: "Read result." }] }]);
    b.conversation.appendAssistant({ role: "assistant", text: "Observed evidence.", toolCalls: [], native: { provider: "openai_compatible", content: { untouched: "FINAL_NATIVE_WITNESS" } } });
    const recent = structuredClone(b.conversation.messages.slice(-4));
    await compactConversation({ ...dependencies(b, writer), sessionNotes: () => ({ content: "# Session notes\nEarlier work.\n", coveredMessages: b.conversation.messages.length, segment: b.conversation.segment }), notesKeepRecentMessages: 2, notesKeepRecentTokens: 1 }, undefined, true, new AbortController().signal);
    expect(b.provider.requests).toHaveLength(0); expect(b.conversation.messages.slice(-4)).toEqual(recent);
    writer.flush(); const raw = readFileSync(writer.path, "utf8"); expect(raw).toContain("$contentRef"); expect(raw).not.toContain(image.dataBase64); expect(raw).toContain("NATIVE_RESPONSE_WITNESS");
    const records = readTranscript(writer.path).records, record = records.find(record => record.type === "compaction"); expect(record?.data["retained"]).toEqual(recent);
    expect(rebuildHistory(activeChain(records).chain).messages.slice(-4)).toEqual(recent);
  } finally { writer.close(); }
});
