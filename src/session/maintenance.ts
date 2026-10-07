// Implements: SPEC-MOD-010 (§ 5.4 deferred maintenance: expired sessions purged, EF-04, EF-07, RG-03, CA-04)
// Supports: SPEC-CFG-013 (`sessions.retentionDays`)
// The deferred maintenance of a launch: the sessions beyond their retention are removed, the current one never. It runs
// after the display, uses no model, and a failure only leaves the work for the next launch.

import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

export function purgeExpiredSessions(sessionsDir: string, retentionDays: number, now: number, keep: ReadonlySet<string>): { removed: string[] } {
  const removed: string[] = [];
  const limit = now - retentionDays * 86_400_000;
  let projects: string[];
  try {
    projects = readdirSync(sessionsDir);
  } catch {
    return { removed };
  }
  for (const project of projects) {
    const dir = join(sessionsDir, project);
    let names: string[];
    try {
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.slice(0, -".jsonl".length);
      if (keep.has(id)) continue;
      try {
        if (statSync(join(dir, name)).mtimeMs >= limit) continue;
        rmSync(join(dir, name), { force: true });
        rmSync(join(dir, id), { recursive: true, force: true });
        removed.push(id);
      } catch {
        // EF-07: retried at the next launch
      }
    }
  }
  return { removed };
}
