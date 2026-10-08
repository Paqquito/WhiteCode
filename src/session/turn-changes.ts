// Implements: SPEC-CMD-021 (§ 5.1 view by turn, EF-01, RG-01, CA-01), SPEC-CMD-061 (§ 5.3 step 1: the messages with the
// files changed since each one)
// Supports: SPEC-SES-006 (the snapshots of the session are the history of the files), gap E-115

import type { BlobStore, FileState, SnapshotRecord } from "./file-history";
import { observe, sameState } from "./file-history";
import type { TranscriptRecord } from "./transcript";
import { unifiedDiff } from "../shared/diff";

export interface FileChange {
  readonly path: string;
  readonly kind: "created" | "modified" | "deleted";
  /** Unified difference; undefined when a content is no longer available. */
  readonly diff?: string;
}

export interface TurnChanges {
  /** Record of the user message that opened the turn: a restore point (SPEC-SES-007). */
  readonly point: string;
  readonly message: string;
  readonly files: readonly FileChange[];
}

/** The messages typed by the user, which open a turn: neither generated, nor from a hook, nor queued during a turn. */
export const isTurnMessage = (r: TranscriptRecord) => r.type === "user" && r.data["synthetic"] !== true && r.data["fromHook"] !== true && r.data["queued"] !== true;

export function messageText(r: TranscriptRecord): string {
  const content = r.data["content"];
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((p) => (p && typeof p === "object" && (p as { type?: string }).type === "text" ? String((p as { text?: string }).text ?? "") : "")).join(" ") : "";
}

/**
 * EF-01: the changes of each turn, from the snapshots of the session. The content before a turn is its backup; the
 * content after it is the backup of a later turn with the same fingerprint, or the file on disk when it still has it.
 */
export function changesByTurn(records: readonly TranscriptRecord[], blobs: BlobStore, maxFileSize: number): TurnChanges[] {
  const turns: Array<{ point: string; message: string; before: Map<string, FileState>; after: Map<string, FileState> }> = [];
  const contents = new Map<string, Buffer>();
  for (const r of records) {
    if (isTurnMessage(r)) turns.push({ point: r.id, message: messageText(r), before: new Map(), after: new Map() });
    if (r.type !== "file_snapshot") continue;
    const s = r.data as unknown as SnapshotRecord;
    const turn = turns[turns.length - 1];
    if (s.kind === "backup") {
      if (s.before.kind === "file") {
        const bytes = blobs.get(s.before.hash);
        if (bytes) contents.set(s.before.hash, bytes);
      }
      if (turn && !turn.before.has(s.path)) turn.before.set(s.path, s.before);
    } else if (s.kind === "written" && turn) turn.after.set(s.path, s.after);
  }
  const text = (path: string, state: FileState): string | undefined => {
    if (state.kind === "absent") return "";
    if (state.kind !== "file") return undefined;
    const kept = contents.get(state.hash);
    if (kept) return kept.toString("utf8");
    // The last content produced by the agent is not saved: the file on disk, when it is still in that state.
    const now = observe(path, maxFileSize);
    return sameState(now.state, state) && now.bytes ? now.bytes.toString("utf8") : undefined;
  };
  return turns.map((t) => ({
    point: t.point,
    message: t.message,
    files: [...t.after]
      .filter(([path, after]) => !sameState(t.before.get(path) ?? after, after))
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([path, after]) => {
        const before = t.before.get(path)!;
        const kind = before.kind === "absent" ? "created" : after.kind === "absent" ? "deleted" : "modified";
        const [a, b] = [text(path, before), text(path, after)];
        return { path, kind, ...(a !== undefined && b !== undefined ? { diff: unifiedDiff(a.replace(/\r\n/g, "\n"), b.replace(/\r\n/g, "\n"), path) } : {}) };
      }),
  }));
}
