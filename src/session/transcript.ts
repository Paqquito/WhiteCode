// Implements: SPEC-SES-001 (§ 5.1 location and record types, EF-01 to EF-05, EF-07 via E-013, FA-02, RG-01, ERR-01, ERR-02, CA-01 to CA-03)
// Append-only JSON Lines transcript, written as soon as a message is complete.

import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tryFileLock } from "../platform/file-lock";

export const TRANSCRIPT_FORMAT_VERSION = 1;

export type RecordType = "session_meta" | "user" | "assistant" | "tool_result" | "system" | "compaction" | "file_snapshot";

export interface TranscriptRecord {
  readonly v: number;
  readonly type: RecordType;
  readonly id: string;
  readonly parentId: string | null;
  readonly sessionId: string;
  readonly ts: string;
  readonly data: Record<string, unknown>;
}

/** Reversible, file-system-safe encoding of the real working folder (§ 5.1). */
export function projectKey(realPath: string): string {
  let out = "";
  for (const byte of Buffer.from(realPath, "utf8")) {
    const ch = String.fromCharCode(byte);
    out += /[A-Za-z0-9.-]/.test(ch) ? ch : `_${byte.toString(16).padStart(2, "0")}`;
  }
  return out;
}

export function decodeProjectKey(key: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < key.length; i++) {
    if (key[i] === "_") {
      bytes.push(parseInt(key.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(key.charCodeAt(i));
  }
  return Buffer.from(bytes).toString("utf8");
}

export interface TranscriptWriterOptions {
  /** Supports: SPEC-CFG-013 CA-02; live product sessions hold a kernel lease until close or death. */
  readonly active?: boolean;
  readonly sessionsDir: string;
  readonly projectRealPath: string;
  readonly sessionId?: string;
  /** Record the next one hangs from, when an existing transcript is continued (SPEC-SES-002 step 6, SPEC-SES-004 § 5.1). */
  readonly parentId?: string;
  readonly clock?: () => Date;
}

export class TranscriptWriter {
  readonly sessionId: string;
  readonly path: string;
  readonly sessionDir: string;
  #fd: number | undefined;
  #releaseActive: (() => void) | undefined;
  #lastId: string | null;
  #failed = false;
  readonly #clock: () => Date;
  /** Warning raised when the transcript can no longer be written (FA-02, ERR-01). */
  warning: string | undefined;

  constructor(options: TranscriptWriterOptions) {
    this.sessionId = options.sessionId ?? randomUUID();
    const dir = join(options.sessionsDir, projectKey(options.projectRealPath));
    this.sessionDir = join(dir, this.sessionId);
    this.path = join(dir, `${this.sessionId}.jsonl`);
    this.#clock = options.clock ?? (() => new Date());
    this.#lastId = options.parentId ?? null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (options.active) {
      this.#releaseActive = tryFileLock(this.path + ".active");
      if (!this.#releaseActive) throw new Error("Cette session est déjà active dans un autre processus.");
    }
    try { this.#fd = openSync(this.path, "a", 0o600); }
    catch (error) { this.#releaseActive?.(); this.#releaseActive = undefined; throw error; }
  }

  /** Appends one record; returns its identifier. Never rewrites an existing line (RG-01). */
  append(type: RecordType, data: Record<string, unknown>): string {
    const record: TranscriptRecord = {
      v: TRANSCRIPT_FORMAT_VERSION,
      type,
      id: randomUUID(),
      parentId: this.#lastId,
      sessionId: this.sessionId,
      ts: this.#clock().toISOString(),
      data,
    };
    if (this.#fd !== undefined && !this.#failed) {
      try {
        writeSync(this.#fd, `${JSON.stringify(record)}\n`);
      } catch {
        this.#failed = true;
        this.warning = "La session n'est plus enregistrée : espace disque insuffisant ou écriture impossible.";
      }
    }
    this.#lastId = record.id;
    return record.id;
  }

  /** Forces the data to disk, at the end of a turn. */
  flush(): void {
    if (this.#fd !== undefined && !this.#failed) {
      try {
        fsyncSync(this.#fd);
      } catch {
        this.#failed = true;
        this.warning = "La durabilité de l'enregistrement de session ne peut plus être garantie.";
      }
    }
  }

  /** Supports: SPEC-IHM-017 CA-02; the composition validates this parent before branching. */
  branch(parentId: string | null): void { this.#lastId = parentId; }

  close(): void {
    this.flush();
    if (this.#fd !== undefined) closeSync(this.#fd);
    this.#fd = undefined;
    this.#releaseActive?.(); this.#releaseActive = undefined;
  }
}

export interface ReadResult {
  readonly records: TranscriptRecord[];
  readonly skippedLines: number;
}

/** Reads a transcript; an unreadable line (interrupted write) is skipped without invalidating the rest (EF-04). */
export function readTranscript(path: string): ReadResult {
  if (!existsSync(path)) return { records: [], skippedLines: 0 };
  const records: TranscriptRecord[] = [];
  let skippedLines = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as TranscriptRecord);
    } catch {
      skippedLines++;
    }
  }
  return { records, skippedLines };
}

/** Effective session metadata: the last `session_meta` record wins (§ 5.3 step 3). */
export function effectiveMeta(records: readonly TranscriptRecord[]): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  for (const r of records) if (r.type === "session_meta") Object.assign(meta, r.data);
  return meta;
}
