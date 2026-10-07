// Implements: SPEC-IHM-009 (§ 5.2 recency and frequency of use, § 7.2 statistics of use, RG-03 kept on this machine)
// Statistics of use of the proposals of the completion: how often and when each one was inserted. A failed read or write
// only loses the ranking help.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UsageStats } from "./completion";

const MAX_ENTRIES = 1_000;

export function readUsage(path: string): Map<string, UsageStats> {
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as Record<string, { count?: unknown; last?: unknown }>;
    const out = new Map<string, UsageStats>();
    for (const [k, v] of Object.entries(data)) if (typeof v?.count === "number" && typeof v.last === "number") out.set(k, { count: v.count, last: v.last });
    return out;
  } catch {
    return new Map();
  }
}

/** Kept bounded: the most recently used entries stay. */
export function writeUsage(path: string, usage: ReadonlyMap<string, UsageStats>): void {
  if (usage.size === 0) return;
  try {
    const kept = [...usage].sort((a, b) => b[1].last - a[1].last).slice(0, MAX_ENTRIES);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(kept)), { mode: 0o600 });
    renameSync(tmp, path);
  } catch {
    // statistics only
  }
}
