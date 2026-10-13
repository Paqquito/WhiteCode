// Implements: SPEC-SES-002 (§ 5.3 steps 1, 2 and 5, EF-02, EF-04, ERR-02, ERR-03, RG-01), SPEC-SES-004 (§ 5.3, EF-01 to EF-03, ERR-01, ERR-02),
//             SPEC-SES-015 (§ 5.1, § 5.3 steps 1 and 2, EF-01, EF-02, ERR-01), SPEC-SES-001 (EF-03 branches, EF-04 partial lines, CA-03 last title)
// Reading of transcripts: sessions of a project, designation by identifier or title, active branch, rebuilt history.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ContentPart, HistoryMessage, ToolCall, ToolResultPart } from "../providers/types";
import { decodeProjectKey, projectKey, type TranscriptRecord } from "./transcript";
// Implements: SPEC-SES-009 (EF-02/03, CA-03), gap E-149.

export function sessionLabels(records: readonly TranscriptRecord[]): string[] {
  let labels: string[] = [];
  for (const record of records) if (record.type === "session_meta" && Array.isArray(record.data["labels"])) {
    labels = [...new Set(record.data["labels"].filter((value): value is string => typeof value === "string" && /^[a-z0-9_-]{1,32}$/.test(value)))].slice(0, 20);
  }
  return labels;
}

export interface SessionInfo {
  readonly id: string;
  readonly path: string;
  /** Real working folder the session belongs to. */
  readonly project: string;
  readonly modifiedMs: number;
}

export class SessionError extends Error {}

/** Records of a transcript, in file order; a partial or corrupt line is skipped (SPEC-SES-001 EF-04). */
export function readTranscript(path: string): { records: TranscriptRecord[]; skipped: number } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new SessionError("Cette conversation ne peut pas être rechargée."); // ERR-03
  }
  const records: TranscriptRecord[] = [];
  let skipped = 0;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const r = JSON.parse(line) as TranscriptRecord;
      if (typeof r.id === "string" && typeof r.type === "string") records.push(r);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { records, skipped };
}

/** Sessions of the project, most recent first. */
export function projectSessions(sessionsDir: string, projectReal: string): SessionInfo[] {
  return sessionsIn(join(sessionsDir, projectKey(projectReal)), projectReal);
}

function sessionsIn(dir: string, project: string): SessionInfo[] {
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return names
    .map((n) => {
      const path = join(dir, n);
      return { id: n.slice(0, -".jsonl".length), path, project, modifiedMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.modifiedMs - a.modifiedMs || (a.id < b.id ? 1 : -1));
}

/** Effective title: the last one recorded (SPEC-SES-001 CA-03, SPEC-SES-008). */
export function sessionTitle(records: readonly TranscriptRecord[]): string | undefined {
  let title: string | undefined;
  for (const r of records) if (r.type === "system" && r.data["event"] === "title" && typeof r.data["title"] === "string") title = r.data["title"];
  return title;
}

/**
 * Session designated by `--reopen <value>` (SPEC-SES-002 § 5.1): an identifier of this project, a title of this project
 * (SPEC-SES-008 EF-03), or an identifier of another project (SPEC-SES-005, reported to the caller).
 */
export function designateSession(sessionsDir: string, projectReal: string, value: string): SessionInfo {
  const here = projectSessions(sessionsDir, projectReal);
  const byId = here.find((s) => s.id === value);
  if (byId) return byId;
  const wanted = value.trim().toLowerCase();
  const byTitle = here.filter((s) => sessionTitle(readTranscript(s.path).records)?.trim().toLowerCase() === wanted);
  if (byTitle.length === 1) return byTitle[0]!;
  if (byTitle.length > 1) {
    throw new SessionError(`Plusieurs sessions portent ce nom : ${value}. Indiquez un identifiant : ${byTitle.map((s) => s.id).join(", ")}.`); // SPEC-SES-008 ERR-02 without picker
  }
  let keys: string[] = [];
  try {
    keys = readdirSync(sessionsDir);
  } catch {
    // no session at all
  }
  for (const key of keys) {
    const path = join(sessionsDir, key, `${value}.jsonl`);
    if (existsSync(path)) return { id: value, path, project: decodeProjectKey(key), modifiedMs: statSync(path).mtimeMs };
  }
  throw new SessionError(`Session introuvable : ${value}.`); // SPEC-SES-002 ERR-02
}

/**
 * Active branch: the chain of parents that ends at `endId`, or at the last record of the file, which is the last branch
 * used (SPEC-SES-004 CA-02). A broken chain stops at the last coherent point (SPEC-SES-015 ERR-01).
 */
export function activeChain(records: readonly TranscriptRecord[], endId?: string): { chain: TranscriptRecord[]; broken: boolean } {
  const byId = new Map(records.map((r) => [r.id, r]));
  const end = endId !== undefined ? byId.get(endId) : records[records.length - 1];
  const chain: TranscriptRecord[] = [];
  let broken = false;
  const seen = new Set<string>();
  for (let r = end; r; ) {
    if (seen.has(r.id)) break;
    seen.add(r.id);
    chain.unshift(r);
    if (r.parentId === null) break;
    const parent = byId.get(r.parentId);
    if (!parent) {
      broken = true;
      break;
    }
    r = parent;
  }
  return { chain, broken };
}

/** Message of the model designated by `--reopen-at` (SPEC-SES-004 EF-01): its record identifier. */
export function assistantRecord(records: readonly TranscriptRecord[], id: string): TranscriptRecord {
  const r = records.find((x) => x.id === id);
  if (!r) throw new SessionError("Message introuvable dans cette session."); // ERR-01
  if (r.type !== "assistant") throw new SessionError("Indiquez un message du modèle."); // ERR-02
  return r;
}

/** SPEC-SES-004 EF-03: the designated response followed by its results when they exist; the branch ends after them. */
export function withResults(records: readonly TranscriptRecord[], assistantId: string): string {
  let end = assistantId;
  for (;;) {
    const next = records.find((r) => r.parentId === end && r.type === "tool_result");
    if (!next) return end;
    end = next.id;
  }
}

/** Native formats: the same native content can only be sent back to an adapter of the same protocol (gap E-079). */
export function protocolOf(provider: string): "messages" | "chat" {
  return provider === "anthropic" ? "messages" : "chat";
}

/** Text and tool calls of a response, recorded with it, or derived from its native content for older records. */
function assistantParts(data: Record<string, unknown>): { text: string; toolCalls: ToolCall[] } {
  if (typeof data["text"] === "string" && Array.isArray(data["toolCalls"])) return { text: data["text"], toolCalls: data["toolCalls"] as ToolCall[] };
  const content = data["content"];
  if (Array.isArray(content)) {
    const blocks = content as Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown }>;
    return {
      text: blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join(""),
      toolCalls: blocks.filter((b) => b.type === "tool_use").map((b) => ({ callId: b.id!, name: b.name!, input: b.input })),
    };
  }
  const message = (content ?? {}) as { content?: string | null; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> };
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls: (message.tool_calls ?? []).map((c) => {
      let input: unknown;
      try {
        input = JSON.parse(c.function.arguments);
      } catch {
        input = {};
      }
      return { callId: c.id, name: c.function.name, input };
    }),
  };
}

/** SPEC-SES-015 § 5.1: the result given to a call that never got one. */
export const INTERRUPTED_RESULT = "Interrupted: the program stopped while this call was running. The action may have been partly carried out; check its effects before going on.";

export interface RebuiltHistory {
  readonly messages: HistoryMessage[];
  /** Provider of the first response of the branch, if any. */
  readonly provider?: string;
  /** Results given to calls left without one, to append to the transcript (EF-02: never a rewrite). */
  readonly repairs: ToolResultPart[];
  /** The branch ends with a user message that got no answer (§ 5.1, FA-01). */
  readonly unanswered: boolean;
}

/**
 * History of the active branch, as the engine sends it (SPEC-SES-002 step 2, EF-02): user messages, responses, results
 * grouped by response, reminders; a compaction restarts the history from its opening message. Calls left without a
 * result receive a synthetic one (SPEC-SES-015, SPEC-MOT-001 RG-01).
 */
export function rebuildHistory(chain: readonly TranscriptRecord[]): RebuiltHistory {
  let messages: HistoryMessage[] = [];
  let provider: string | undefined;
  const repairs: ToolResultPart[] = [];
  let pending: ToolCall[] = [];
  let results: ToolResultPart[] = [];
  const closeResults = () => {
    if (pending.length === 0 && results.length === 0) return;
    const got = new Set(results.map((r) => r.callId));
    for (const call of pending) {
      if (got.has(call.callId)) continue;
      const repair: ToolResultPart = { type: "tool_result", callId: call.callId, isError: true, content: [{ type: "text", text: INTERRUPTED_RESULT }] };
      results.push(repair);
      repairs.push(repair);
    }
    const order = new Map(pending.map((c, i) => [c.callId, i]));
    results.sort((a, b) => (order.get(a.callId) ?? 0) - (order.get(b.callId) ?? 0));
    messages.push({ role: "user", parts: results });
    pending = [];
    results = [];
  };
  for (const r of chain) {
    const data = r.data;
    switch (r.type) {
      case "compaction":
        pending = [];
        results = [];
        messages = [{ role: "user", parts: (data["opening"] as ContentPart[] | undefined) ?? [] }];
        break;
      case "user":
        closeResults();
        messages.push({ role: "user", parts: (data["content"] as ContentPart[]) ?? [] });
        break;
      case "assistant": {
        closeResults();
        const { text, toolCalls } = assistantParts(data);
        const native = { provider: String(data["provider"] ?? ""), content: data["content"] };
        provider ??= native.provider;
        messages.push({ role: "assistant", text, toolCalls, native });
        pending = [...toolCalls];
        break;
      }
      case "tool_result":
        results.push({ type: "tool_result", callId: String(data["callId"]), isError: data["isError"] === true, content: (data["content"] as ContentPart[]) ?? [] });
        break;
      case "system":
        if (data["event"] === "note" && typeof data["text"] === "string") {
          closeResults();
          messages.push({ role: "system_note", text: data["text"] });
        }
        break;
      default:
        break;
    }
  }
  closeResults();
  const last = messages[messages.length - 1];
  return { messages, provider, repairs, unanswered: last?.role === "user" && !last.parts.some((p) => p.type === "tool_result") };
}
