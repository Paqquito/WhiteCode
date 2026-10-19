// Implements: SPEC-MOT-015 (age, recent-result protection, immutable history and acknowledged edit registry), gap E-250.
import type { HistoryMessage } from "../providers/types";
import { COMPACTABLE_TOOLS } from "./micro-compaction";

export interface CachedMicroSettings {
  readonly triggerRatio: number;
  readonly keepRecent: number;
  readonly minAgeMinutes: number;
}

export interface CachedMicroState { readonly version: 1; readonly edited: readonly string[]; readonly rejected: boolean; }
function decodeState(value: unknown): CachedMicroState {
  const state = value as Partial<CachedMicroState> | undefined;
  if (!state || state.version !== 1 || typeof state.rejected !== "boolean" || !Array.isArray(state.edited) || state.edited.length > 10000 || state.edited.some(id => typeof id !== "string" || id.length === 0 || id.length > 1024) || new Set(state.edited).size !== state.edited.length) return { version: 1, edited: [], rejected: true };
  return state as CachedMicroState;
}

/** Replays only product metadata; a full compaction forgets edits but never a session rejection. */
export function restoredCacheState(records: readonly { readonly type: string; readonly data: Record<string, unknown> }[]): CachedMicroState {
  let edited: readonly string[] = [], rejected = false;
  for (const record of records) {
    if (record.type === "compaction") edited = [];
    else if (record.type === "system" && record.data["event"] === "cache_edit_state") { const state = decodeState(record.data["state"]); edited = state.edited; rejected ||= state.rejected; }
  }
  return { version: 1, edited, rejected };
}

/** Plans targeted cache edits; only a service acknowledgement commits the selected identifiers. */
export class CachedMicroCompaction {
  readonly instructions = "Older tool results may be removed from the service cache while the local history remains intact. Read the source again if an older result is unavailable; ordinary permissions still apply.";
  readonly #seen = new Map<string, number>();
  readonly #edited = new Set<string>();
  #offered = new Set<string>();
  #historyGeneration: number | undefined;
  #rejected = false;
  constructor(private readonly clock: () => number = Date.now, private readonly persistence?: { readonly restored?: unknown; readonly save?: (state: CachedMicroState) => void }) {
    if (persistence?.restored !== undefined) {
      const state = decodeState(persistence.restored);
      for (const id of state.edited) this.#edited.add(id);
      this.#rejected = state.rejected;
    }
  }
  private persist(): boolean {
    try { this.persistence?.save?.({ version: 1, edited: [...this.#edited], rejected: this.#rejected }); return true; }
    catch { this.#rejected = true; return false; }
  }
  get available(): boolean { return !this.#rejected; }

  /** The generation changes only after a full history replacement, not after presentation changes. */
  plan(history: readonly HistoryMessage[], historyGeneration: number, ratio: number, settings: CachedMicroSettings): readonly string[] {
    this.#offered.clear();
    if (this.#rejected) return [];
    if (this.#historyGeneration !== historyGeneration) {
      this.#seen.clear();
      if (this.#historyGeneration !== undefined) { this.#edited.clear(); if (!this.persist()) return []; }
      this.#historyGeneration = historyGeneration;
    }
    if (!Number.isFinite(settings.triggerRatio) || settings.triggerRatio < 0 || settings.triggerRatio > 1 || !Number.isSafeInteger(settings.keepRecent) || settings.keepRecent < 0 || !Number.isFinite(settings.minAgeMinutes) || settings.minAgeMinutes < 0) throw new RangeError("Invalid cached compaction settings.");
    const tools = new Map<string, string>(), ambiguous = new Set<string>(), results: string[] = [], occurrences = new Map<string, number>();
    for (const message of history) {
      if (message.role === "assistant") for (const call of message.toolCalls) {
        if (tools.has(call.callId)) ambiguous.add(call.callId);
        tools.set(call.callId, call.name);
      }
      else if (message.role === "user") for (const part of message.parts) if (part.type === "tool_result") {
        results.push(part.callId); occurrences.set(part.callId, (occurrences.get(part.callId) ?? 0) + 1);
      }
    }
    if (results.length > 10000) return [];
    const current = new Set(results), now = this.clock();
    for (const id of this.#seen.keys()) if (!current.has(id)) this.#seen.delete(id);
    for (const id of results) if (!this.#seen.has(id)) this.#seen.set(id, now);
    if (!Number.isFinite(ratio) || ratio <= settings.triggerRatio) return [];
    const compactable = results.filter(id => !ambiguous.has(id) && occurrences.get(id) === 1 && COMPACTABLE_TOOLS.has(tools.get(id) ?? ""));
    const selected = compactable.slice(0, Math.max(0, compactable.length - settings.keepRecent)).filter(id => !this.#edited.has(id) && now - this.#seen.get(id)! >= settings.minAgeMinutes * 60000);
    this.#offered = new Set(selected);
    return selected;
  }

  acknowledge(ids: readonly string[]): boolean {
    if (this.#rejected || new Set(ids).size !== ids.length || ids.some(id => !this.#offered.has(id))) return false;
    if (this.#edited.size + ids.filter(id => !this.#edited.has(id)).length > 10000) return false;
    for (const id of ids) this.#edited.add(id);
    this.#offered.clear();
    return this.persist();
  }
  reject(): void { this.#rejected = true; this.#offered.clear(); this.persist(); }
}
