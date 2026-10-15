// Supports: SPEC-SES-001 (protected storage access), gap E-181.
import { ArchiveFailure } from "../session/archive-crypto";
import { storeAppend as appendFileSync, storeExists as existsSync, storeMkdir as mkdirSync, storeRead as readFileSync, storeRename as renameSync, storeStat as statSync, storeWrite as writeFileSync } from "../session/private-storage";
// Implements: SPEC-IHM-008 (§ 5.1 recording, § 5.4 scope, § 5.5 bounds and purge, FA-02, FA-04, FA-05, EF-01, EF-05, EF-06, EF-08, ERR-01, ERR-02, RG-01, RG-03, RG-04, ENF-02, CA-04, CA-06, CA-07)
// The history of the inputs, kept on this machine only: one line per message appended to a file shared by the sessions,
// so that concurrent writes add up without loss; read back in time order, bounded in number and age, filtered by folder.


import { dirname } from "node:path";
import { containsSecret } from "../shared/secrets";
import { ContentStore } from "../session/content-store";
import { join } from "node:path";
// Implements: SPEC-SES-016 (shared project history and leading-space exclusion).

export interface HistoryEntry {
  readonly text: string;
  /** Folder of origin (§ 5.4). */
  readonly dir: string;
  readonly at: number;
}

export interface HistoryOptions {
  readonly path: string;
  readonly dir: string;
  readonly scope: "folder" | "global";
  readonly maxEntries: number;
  readonly retentionDays: number;
  readonly enabled: boolean;
  readonly now?: () => number;
  readonly warn: (message: string) => void;
  readonly contentInlineThreshold?: number;
}

export class InputHistory {
  readonly #o: HistoryOptions;
  /** Entries in memory, the oldest first. */
  #entries: HistoryEntry[] = [];
  #stamp = "";
  #memoryOnly = false;
  readonly #content: ContentStore;

  constructor(o: HistoryOptions) {
    this.#o = o;
    this.#content = new ContentStore(join(dirname(o.path), "content"), o.contentInlineThreshold);
    this.#reload();
  }

  get #now(): number {
    return (this.#o.now ?? Date.now)();
  }

  /** The file is read again when another session changed it (FA-04); bounds and scope applied (EF-05, § 5.4). */
  #reload(): void {
    if (!this.#o.enabled || this.#memoryOnly) return;
    let stamp = "";
    try {
      const s = statSync(this.#o.path);
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch (error) {
      if (error instanceof ArchiveFailure) throw error;
      return;
    }
    if (stamp === this.#stamp) return;
    this.#stamp = stamp;
    let text: string;
    try {
      text = readFileSync(this.#o.path, "utf8");
    } catch (error) {
      if (error instanceof ArchiveFailure) throw error;
      return;
    }
    const lines = text.split("\n").filter((l) => l.trim() !== "");
    const read: HistoryEntry[] = [];
    for (const l of lines) {
      try {
        const v = JSON.parse(l) as { text?: unknown; dir?: unknown; at?: unknown };
        v.text = this.#content.decode(v.text);
        if (typeof v.text === "string" && typeof v.dir === "string" && typeof v.at === "number") read.push({ text: v.text, dir: v.dir, at: v.at });
      } catch (error) {
        if (error instanceof ArchiveFailure) throw error;
        // ENF-02: a line cut by an interrupted write is skipped.
      }
    }
    if (lines.length > 0 && read.length === 0) {
      // ERR-02, FA-05: an unreadable store is put aside and a new one starts.
      try {
        renameSync(this.#o.path, `${this.#o.path}.illisible-${this.#now}`);
      } catch {
        // nothing more to do
      }
      this.#stamp = "";
      this.#o.warn("Historique illisible : un nouvel historique a été créé.");
    }
    const oldest = this.#now - this.#o.retentionDays * 86_400_000;
    this.#entries = read.filter((e) => e.at >= oldest).sort((a, b) => a.at - b.at);
  }

  /** § 5.1, EF-01: a message sent is recorded, except an empty one, a repetition of the previous one, or a secret (RG-04). */
  add(text: string): void {
    if (!this.#o.enabled || text.startsWith(" ") || text.trim() === "" || containsSecret(text)) return;
    this.#reload();
    const previous = this.#visible()[0];
    if (previous?.text === text) return; // CA-04
    const entry: HistoryEntry = { text, dir: this.#o.dir, at: this.#now };
    this.#entries.push(entry);
    if (this.#memoryOnly) return;
    try {
      mkdirSync(dirname(this.#o.path), { recursive: true, mode: 0o700 });
      this.#content.publish(entry.text, text => appendFileSync(this.#o.path, `${JSON.stringify({ ...entry, text })}\n`, { mode: 0o600 })); // EF-08: appends add up
      const s = statSync(this.#o.path);
      this.#stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      // ERR-01: the history stays in memory, with a single warning.
      this.#memoryOnly = true;
      this.#o.warn("L'historique ne sera pas conservé.");
    }
  }

  /** The entries of the scope, the most recent first (RG-03), at most `ui.history.maxEntries` (EF-05). */
  #visible(): HistoryEntry[] {
    const scoped = this.#o.scope === "global" ? this.#entries : this.#entries.filter((e) => e.dir === this.#o.dir);
    return scoped.slice(-this.#o.maxEntries).reverse();
  }

  entries(): HistoryEntry[] {
    if (!this.#o.enabled) return [];
    this.#reload();
    return this.#visible();
  }

  /** EF-06, CA-07: the history of the scope is erased; the entries of other folders stay in a folder scope. */
  clear(): void {
    const kept = this.#o.scope === "global" ? [] : this.#entries.filter((e) => e.dir !== this.#o.dir);
    this.#entries = kept;
    if (this.#memoryOnly) return;
    try {
      this.#write(kept);
    } catch {
      this.#o.warn("L'historique n'a pas pu être effacé.");
    }
  }

  /**
   * § 5.5: deferred maintenance; the file is rewritten without the expired entries and beyond the bound, only when it
   * holds clearly more than what is kept.
   */
  prune(): void {
    if (!this.#o.enabled || this.#memoryOnly || !existsSync(this.#o.path)) return;
    this.#reload();
    let lines = 0;
    try {
      lines = readFileSync(this.#o.path, "utf8").split("\n").filter((l) => l.trim() !== "").length;
    } catch (error) {
      if (error instanceof ArchiveFailure) throw error;
      return;
    }
    // The bound applies per folder in a folder scope: the file keeps at most the bound for each folder.
    const byDir = new Map<string, HistoryEntry[]>();
    for (const e of this.#entries) byDir.set(e.dir, [...(byDir.get(e.dir) ?? []), e]);
    const kept = [...byDir.values()].flatMap((list) => list.slice(-this.#o.maxEntries)).sort((a, b) => a.at - b.at);
    if (lines <= kept.length * 1.2 + 10) return;
    try {
      this.#write(kept);
      this.#entries = kept;
    } catch {
      // The pruning is retried at the next launch.
    }
  }

  #write(entries: readonly HistoryEntry[]): void {
    mkdirSync(dirname(this.#o.path), { recursive: true, mode: 0o700 });
    const tmp = `${this.#o.path}.tmp-${process.pid}`;
    this.#content.withLock(() => {
      writeFileSync(tmp, entries.map((e) => `${JSON.stringify({ ...e, text: this.#content.encode(e.text) })}\n`).join(""), { mode: 0o600 });
      renameSync(tmp, this.#o.path);
    });
    const s = statSync(this.#o.path);
    this.#stamp = `${s.mtimeMs}:${s.size}`;
  }
}
