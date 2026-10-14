// Supports: SPEC-MOT-017 (validated recent history), SPEC-SES-017 (shared user content), gap E-163.
import type { HistoryMessage } from "../providers/types";
import type { TranscriptRecord } from "./transcript";
import { ContentStore } from "./content-store";
const row = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function content(value: unknown): boolean {
  return row(value) && (value["type"] === "text" && typeof value["text"] === "string" || value["type"] === "image" && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(value["mediaType"])) && typeof value["dataBase64"] === "string");
}
export function retainedHistory(value: unknown): HistoryMessage[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error("Invalid retained history.");
  for (const message of value) {
    if (!row(message) || message["contextId"] !== undefined && (typeof message["contextId"] !== "string" || message["contextId"].length > 128)) throw new Error("Invalid retained message.");
    if (message["role"] === "system_note" && typeof message["text"] === "string") continue;
    if (message["role"] === "assistant" && typeof message["text"] === "string" && row(message["native"]) && typeof message["native"]["provider"] === "string" && Array.isArray(message["toolCalls"]) && message["toolCalls"].length <= 1024 && message["toolCalls"].every((call: unknown) => row(call) && typeof call["callId"] === "string" && typeof call["name"] === "string")) continue;
    if (message["role"] === "user" && Array.isArray(message["parts"]) && message["parts"].length <= 1024 && message["parts"].every((part: unknown) => content(part) || row(part) && part["type"] === "tool_result" && typeof part["callId"] === "string" && typeof part["isError"] === "boolean" && Array.isArray(part["content"]) && part["content"].length <= 1024 && part["content"].every(content))) continue;
    throw new Error("Invalid retained message.");
  }
  return value as HistoryMessage[];
}
/** Provider-native responses stay verbatim; only user parts resolve content references. */
export function decodeRecordContent(record: TranscriptRecord, path: string): TranscriptRecord {
  const store = ContentStore.forTranscript(path);
  if (record.type === "user") return { ...record, data: { ...record.data, content: store.decode(record.data["content"]) } };
  if (record.type === "compaction" && record.data["retained"] !== undefined) {
    const value = record.data["retained"]; if (!Array.isArray(value)) throw new Error("Invalid retained history.");
    const retained = retainedHistory(value.map(message => row(message) && message["role"] === "user" ? { ...message, parts: store.decode(message["parts"]) } : message));
    return { ...record, data: { ...record.data, retained } };
  }
  return record;
}
