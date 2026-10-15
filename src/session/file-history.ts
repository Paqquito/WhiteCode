// Implements: SPEC-SES-006 (§ 5.1, § 5.3 steps 1 and 2, FA-02, EF-01, EF-02, EF-04, EF-05, EF-08, ERR-01, RG-01, RG-02, CA-03), SPEC-SES-012 (EF-02 copies kept in memory)
// File history of a session: the content of each file the agent changes is saved, by content fingerprint, before its
// first change in a turn; every user message records a checkpoint. Shell commands are not followed (RG-02).
// Supports: SPEC-SES-006 (CA-09, RG-01), SPEC-MOD-002 (CA-07), gap E-132: an existing blob must be recoverable.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storeExists, storeStat, storeRead, storeWrite, storeMkdir } from "./private-storage";

/** State of a path, as the agent last knew it or as it is now (SPEC-SES-006 § 5.7 point 1: absence, type, link target). */
export type FileState =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly hash: string; readonly size: number }
  | { readonly kind: "too_large"; readonly size: number }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "directory" }
  | { readonly kind: "other" };

export function sameState(a: FileState, b: FileState): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "file":
      return a.hash === (b as typeof a).hash;
    case "too_large":
      return a.size === (b as typeof a).size;
    case "link":
      return a.target === (b as typeof a).target;
    default:
      return true;
  }
}

export const hashBytes = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** Current state of `path`; the content is returned with it when it is a regular file within the size limit. */
export function observe(path: string, maxFileSize: number): { state: FileState; bytes?: Buffer } {
  let stats;
  try {
    stats = lstatSync(path);
  } catch {
    return { state: { kind: "absent" } };
  }
  if (stats.isSymbolicLink()) {
    let target = "";
    try {
      target = readlinkSync(path);
    } catch {
      // unreadable link: compared by its absence of target
    }
    return { state: { kind: "link", target } };
  }
  if (stats.isDirectory()) return { state: { kind: "directory" } };
  if (!stats.isFile()) return { state: { kind: "other" } };
  if (stats.size > maxFileSize) return { state: { kind: "too_large", size: stats.size } };
  const bytes = readFileSync(path);
  return { state: { kind: "file", hash: hashBytes(bytes), size: bytes.length }, bytes };
}

/** Saved contents, by fingerprint (EF-04): a folder of the session, or memory for a session without persistence. */
export class BlobStore {
  readonly #dir: string | undefined;
  readonly #memory = new Map<string, Buffer>();

  constructor(dir: string | undefined) {
    this.#dir = dir;
  }

  put(hash: string, bytes: Buffer): void {
    if (hashBytes(bytes) !== hash) throw new Error("Backup fingerprint does not match its content.");
    if (this.#dir === undefined) {
      this.#memory.set(hash, bytes);
      return;
    }
    const path = join(this.#dir, hash);
    const valid = () => storeStat(path).isFile() && this.get(hash) !== undefined;
    if (storeExists(path)) {
      if (!valid()) throw new Error("The existing backup is not a recoverable regular file.");
      return;
    }
    storeMkdir(this.#dir, { recursive: true, mode: 0o700 });
    try { storeWrite(path, bytes, { mode: 0o600, flag: "wx" }); }
    catch (error) {
      // A concurrent identical backup may have won creation; no existing content is overwritten.
      if (!storeExists(path) || !valid()) throw error;
    }
    if (!valid()) throw new Error("The backup could not be verified after creation.");
  }

  get(hash: string): Buffer | undefined {
    if (this.#dir === undefined) return this.#memory.get(hash);
    try {
      const bytes = storeRead(join(this.#dir, hash));
      return hashBytes(bytes) === hash ? bytes : undefined; // a damaged copy is never restored
    } catch {
      return undefined;
    }
  }
}

/** Records written to the transcript (`file_snapshot`). */
export type SnapshotRecord =
  | { readonly kind: "backup"; readonly path: string; readonly before: FileState; readonly reason?: "restore" }
  | { readonly kind: "written"; readonly path: string; readonly after: FileState }
  | { readonly kind: "checkpoint"; readonly message: string; readonly files: Readonly<Record<string, FileState>> };

export interface FileHistoryOptions {
  readonly blobs: BlobStore;
  readonly maxFileSize: number;
  readonly record: (data: SnapshotRecord) => void;
  readonly warn: (message: string) => void;
}

export class FileHistory {
  readonly #o: FileHistoryOptions;
  /** Files already saved in the current turn (step 1: before the first change in a turn). */
  readonly #savedThisTurn = new Set<string>();
  /** Last known state of each followed file. */
  readonly #known = new Map<string, FileState>();

  constructor(options: FileHistoryOptions) {
    this.#o = options;
  }

  /** Step 2, EF-02: a checkpoint for each user message, with the followed files and their fingerprints. */
  checkpoint(messageId: string): void {
    this.#savedThisTurn.clear();
    this.#o.record({ kind: "checkpoint", message: messageId, files: Object.fromEntries(this.#known) });
  }

  /** EF-01, ERR-01: saves the files a tool is about to change; a message when the change must not happen. */
  beforeWrite(paths: readonly string[]): string | undefined {
    for (const path of paths) {
      if (this.#savedThisTurn.has(path)) continue;
      let observed;
      try {
        observed = observe(path, this.#o.maxFileSize);
        if (observed.bytes && observed.state.kind === "file") this.#o.blobs.put(observed.state.hash, observed.bytes);
      } catch {
        return "Impossible de sauvegarder l'état du fichier : modification annulée."; // ERR-01
      }
      if (observed.state.kind === "too_large") {
        this.#o.warn(`Fichier trop volumineux pour être sauvegardé : ${path} (${Math.round(observed.state.size / 1_048_576)} Mo) ; il ne pourra pas être restauré.`); // FA-02, CA-03
      }
      this.#savedThisTurn.add(path);
      this.#known.set(path, observed.state);
      this.#o.record({ kind: "backup", path, before: observed.state });
    }
    return undefined;
  }

  /** After the tool: the state the agent produced becomes the last known state (reference of § 5.7 point 2). */
  afterWrite(paths: readonly string[]): void {
    for (const path of paths) {
      let state: FileState;
      // Only the fingerprint is kept: a later restore point finds this content in the backup of the next turn.
      try {
        state = observe(path, this.#o.maxFileSize).state;
      } catch {
        continue;
      }
      this.#known.set(path, state);
      this.#o.record({ kind: "written", path, after: state });
    }
  }
}
