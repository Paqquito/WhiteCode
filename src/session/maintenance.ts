// Implements: SPEC-MOD-010 (§ 5.4 deferred maintenance: expired sessions purged, EF-04, EF-07, RG-03, CA-04)
// Supports: SPEC-CFG-013 (`sessions.retentionDays`)
// The deferred maintenance of a launch: the sessions beyond their retention are removed, the current one never. It runs
// after the display, uses no model, and a failure only leaves the work for the next launch.

import { readdirSync, rmSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tryFileLock } from "../platform/file-lock";
// Implements: SPEC-CFG-013 (CA-01/02/03, EF-02), gap E-151.

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
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) continue;
      names = readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const name of names) {
      const id = name.slice(0, -".jsonl".length);
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id)) continue;
      if (keep.has(id)) continue;
      let release: (() => void) | undefined;
      try {
        const file = join(dir, name), stat = lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs >= limit) continue;
        release = tryFileLock(file + ".active");
        if (!release) continue;
        // The holder may have refreshed its transcript before this cleanup acquired the lease.
        if (lstatSync(file).mtimeMs >= limit) continue;
        rmSync(join(dir, name), { force: true });
        const data = join(dir, id);
        try { const metadata = lstatSync(data); if (metadata.isDirectory() && !metadata.isSymbolicLink()) rmSync(data, { recursive: true, force: true }); } catch { /* no companion directory */ }
        removed.push(id);
      } catch {
        // EF-07: retried at the next launch
      } finally { release?.(); }
    }
  }
  return { removed };
}
