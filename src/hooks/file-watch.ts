// Implements: SPEC-HOK-013 (debounce, ignored files, burst summaries, anti-recursion, CA-01 to CA-03).
import { watch, statSync, type FSWatcher } from "node:fs";
import { resolve } from "node:path";
import { walkFiles } from "../tools/file-walk";
export interface FileWatchOptions {
  /** Native watcher port for regression fixtures, not a setting. */
  readonly watch?: (root: string, changed: () => void) => Pick<FSWatcher, "on" | "close">;
  readonly roots: readonly string[];
  readonly matches: (path: string) => boolean;
  readonly debounce: () => number;
  readonly burstLimit: () => number;
  readonly emit: (fields: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
  readonly warn: (message: string) => void;
}
interface Stamp { readonly stamp: string; readonly relative: string }
export class HookFileWatch {
  readonly #watchers: Array<Pick<FSWatcher, "on" | "close">> = [];
  #startup?: ReturnType<typeof setTimeout>;
  readonly #agentPaths = new Set<string>();
  #files = new Map<string, Stamp>();
  #timer?: ReturnType<typeof setTimeout>;
  #poll?: ReturnType<typeof setInterval>;
  #running = false; #dirty = false; #closed = false;
  readonly #abort = new AbortController();
  constructor(readonly options: FileWatchOptions) {
    this.#files = this.#scan();
    let fallback = false;
    for (const root of options.roots) {
      try {
        const watcher = options.watch ? options.watch(root, () => this.#changed()) : watch(root, { recursive: true, persistent: false }, () => this.#changed());
        watcher.on("error", () => { watcher.close(); this.#fallback(); }); this.#watchers.push(watcher);
      } catch { fallback = true; }
    }
    if (fallback) this.#fallback();
    // A native backend may arm asynchronously and miss the first change after construction.
    this.#startup = setTimeout(() => { this.#startup = undefined; this.#changed(); }, 100); this.#startup.unref();
  }
  #fallback(): void {
    if (this.#poll || this.#closed) return;
    this.options.warn("Surveillance des fichiers limitée par le système : vérification périodique.");
    this.#poll = setInterval(() => this.#changed(), 2000); this.#poll.unref();
  }
  #scan(): Map<string, Stamp> {
    const files = new Map<string, Stamp>();
    for (const root of this.options.roots) {
      const result = walkFiles(root, { respectIgnoreFiles: true, stayWithinRoot: true, caseInsensitive: process.platform === "win32", deadline: Date.now() + 5000, signal: this.#abort.signal, maxEntries: 100000 }, path => this.options.matches(path));
      for (const file of result.files) files.set(file.path, { stamp: `${file.stats.mtimeMs}:${file.stats.ctimeMs}:${file.stats.size}`, relative: file.relativePath });
      if (result.timedOut || result.truncated) this.options.warn("Surveillance partielle : limite de parcours atteinte.");
    }
    return files;
  }
  agentChanged(paths: readonly string[]): void { for (const path of paths) this.#agentPaths.add(resolve(path)); }
  #changed(): void {
    if (this.#closed) return;
    this.#dirty = true;
    if (this.#running) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => { this.#timer = undefined; void this.#flush(); }, this.options.debounce()); this.#timer.unref();
  }
  async #flush(): Promise<void> {
    if (this.#closed || this.#running) return;
    this.#running = true; this.#dirty = false;
    const next = this.#scan();
    const changed = [...new Set([...next.keys(), ...this.#files.keys()])].filter(path => next.get(path)?.stamp !== this.#files.get(path)?.stamp);
    const events = changed.map(path => ({ path, relativePath: (next.get(path) ?? this.#files.get(path))!.relative,
      change: !next.has(path) ? "deleted" : !this.#files.has(path) ? "created" : "modified", origin: this.#agentPaths.has(resolve(path)) ? "agent" : "external" }));
    this.#files = next;
    try {
      if (events.length > this.options.burstLimit()) {
        await this.options.emit({ summary: true, count: events.length, paths: events.slice(0, this.options.burstLimit()).map(e => e.path), change: "burst", origin: "external" }, this.#abort.signal);
        for (const path of changed) this.#refresh(path);
      } else for (const event of events) { if (this.#closed) break; await this.options.emit(event, this.#abort.signal); this.#refresh(event.path, event.relativePath); }
    } catch { this.options.warn("Échec de la surveillance des fichiers : la session continue."); }
    finally {
      for (const path of changed) this.#agentPaths.delete(resolve(path));
      this.#running = false;
      if (this.#dirty && !this.#closed) this.#changed();
    }
  }
  /** Absorb the watched hook's own write before processing the filesystem notification it generated. */
  #refresh(path: string, relative?: string): void {
    const previous = this.#files.get(path) ?? (relative ? { stamp: "", relative } : undefined);
    if (!previous) return;
    try { const s = statSync(path); this.#files.set(path, { ...previous, stamp: `${s.mtimeMs}:${s.ctimeMs}:${s.size}` }); }
    catch { this.#files.delete(path); }
  }
  close(): void {
    if (this.#startup) clearTimeout(this.#startup);
    this.#closed = true; this.#abort.abort(); if (this.#timer) clearTimeout(this.#timer); if (this.#poll) clearInterval(this.#poll);
    for (const watcher of this.#watchers) watcher.close();
  }
}
