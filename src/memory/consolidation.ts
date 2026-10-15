// Implements: SPEC-MOT-039, SPEC-AGT-022 (exclusive staged consolidation, visible task and cancellation without partial edits).
// Supports: SPEC-EXT-035, gap E-172.
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tryFileLock } from "../platform/file-lock";
import { currentPlatform } from "../platform/system";
import { writeAtomic } from "../tools/text-file";
import type { BackgroundTasks } from "../engine/background";
import { MemoryStore } from "./store";

interface Options {
  readonly store: MemoryStore;
  readonly background: BackgroundTasks;
  readonly signal: AbortSignal;
  readonly enabled: () => boolean;
  readonly denied: (path: string) => boolean;
  readonly minHours: number;
  readonly minSessions: number;
  readonly now?: () => number;
  readonly work: (store: MemoryStore, signal: AbortSignal, changed: () => void) => Promise<boolean>;
}
export class MemoryConsolidation {
  #counted = false;
  constructor(readonly options: Options) {}
  get #stateFile(): string { return join(this.options.store.root, ".consolidation.json"); }
  #state(): { last: number; sessions: number } {
    if (!existsSync(this.#stateFile)) return { last: 0, sessions: 0 };
    const stat = lstatSync(this.#stateFile); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 1024) throw new Error("Invalid consolidation state.");
    const value = JSON.parse(readFileSync(this.#stateFile, "utf8")); if (!Number.isFinite(value.last) || value.last < 0 || !Number.isSafeInteger(value.sessions) || value.sessions < 0) throw new Error("Invalid consolidation state."); return value;
  }
  #save(state: { last: number; sessions: number }): void { writeAtomic(this.#stateFile, Buffer.from(JSON.stringify(state)), currentPlatform(), true); }
  /** Count a session once, independent of its number of turns. */
  sessionCompleted(): string | undefined {
    if (this.#counted || !this.options.enabled()) return undefined; this.#counted = true;
    const { store } = this.options; store.entries(); mkdirSync(store.root, { recursive: true, mode: 0o700 });
    const release = tryFileLock(join(store.root, ".consolidation-state.lock")); if (!release) return undefined;
    let due = false;
    try { const state = this.#state(); state.sessions++; this.#save(state); due = (this.options.now?.() ?? Date.now()) - state.last >= this.options.minHours * 3600000 && state.sessions >= this.options.minSessions; } finally { release(); }
    return due ? this.start() : undefined;
  }
  start(): string | undefined {
    const { store, background, signal } = this.options;
    if (!this.options.enabled() || signal.aborted || !store.allowsAll(this.options.denied)) return undefined;
    const entries = store.entries(); if (!entries.length || entries.some(entry => this.options.denied(join(store.root, entry.file)))) return undefined;
    const release = tryFileLock(join(store.root, ".consolidation.lock")); if (!release) return undefined;
    try {
      const expected = new Map(entries.map(entry => [entry.file, store.read(entry.file).text]));
      const countedSessions = this.#state().sessions;
      const attempt = join(store.root, "consolidation-" + randomUUID()), staged = new MemoryStore(join(attempt, "staging"), store.options), backup = new MemoryStore(join(attempt, "backup"), store.options);
      for (const [file, text] of expected) { staged.put(file, text); backup.put(file, text); }
      const task = background.start("agent", "Consolidation de la mémoire", async (taskSignal, write) => {
        const combined = AbortSignal.any([signal, taskSignal, AbortSignal.timeout(45000)]);
        try {
          await Promise.resolve();
          const success = await this.options.work(staged, combined, () => { background.updateActivity(task.id, "mise à jour", (task.toolCalls ?? 0) + 1); write("Memory staging updated.\n"); });
          combined.throwIfAborted(); if (!success) throw new Error("Consolidation worker did not complete.");
          const changes = new Map(staged.entries().map(entry => [entry.file, staged.read(entry.file).text]));
          if (!store.allowsAll(this.options.denied) || [...changes.keys()].some(file => this.options.denied(join(store.root, file)))) throw new Error("Memory permission changed.");
          store.publish(expected, changes);
          const stateRelease = tryFileLock(join(store.root, ".consolidation-state.lock"));
          if (stateRelease) try { this.#save({ last: this.options.now?.() ?? Date.now(), sessions: Math.max(0, this.#state().sessions - countedSessions) }); } finally { stateRelease(); }
          return { status: "completed" as const, summary: "Mémoire consolidée ; copie préalable conservée." };
        } catch (error) { if (combined.aborted) return { status: "stopped" as const, summary: "Consolidation interrompue ; mémoire initiale conservée." }; throw error; }
        finally { release(); }
      });
      task.activity = "démarrage"; task.agentType = "memory-consolidation"; return task.id;
    } catch (error) { release(); throw error; }
  }
}
