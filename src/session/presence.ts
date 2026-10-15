// Implements: SPEC-SES-011 (§ 5.3 steps 1 to 4, FA-01, EF-02, EF-03, ERR-01 without dialog, CA-01 to CA-03)
// Presence of the running sessions: one small file per session, refreshed while it runs and removed at exit. It holds
// no conversation content (SPEC-SES-001 § 5.7, "hors inventaire").

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { comparablePath, type PlatformName } from "../platform/system";
import { processExists } from "../platform/process";

export interface Presence {
  readonly sessionId: string;
  readonly pid: number;
  /** Real working folder. */
  readonly cwd: string;
  /** Last sign of life (ISO date). */
  readonly heartbeat: string;
}

export interface PresenceOptions {
  readonly dir: string;
  readonly timeoutMs: number;
  readonly platform: PlatformName;
  readonly clock?: () => Date;
}

export class PresenceRegistry {
  readonly #o: PresenceOptions;
  #own: Presence | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: PresenceOptions) {
    this.#o = options;
  }

  #now(): Date {
    return (this.#o.clock ?? (() => new Date()))();
  }

  /** Live presences of other sessions; dead ones are removed silently (step 1, FA-01, CA-03). */
  others(ownSessionId?: string): Presence[] {
    let names: string[];
    try {
      names = readdirSync(this.#o.dir).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const live: Presence[] = [];
    for (const name of names) {
      const path = join(this.#o.dir, name);
      let p: Presence;
      try {
        p = JSON.parse(readFileSync(path, "utf8")) as Presence;
      } catch {
        continue; // being written, or not ours
      }
      if (this.#now().getTime() - Date.parse(p.heartbeat) > this.#o.timeoutMs) {
        // A stalled but living process remains evidence for session-rescue; only dead presences are pruned.
        if(!processExists(p.pid))rmSync(path, { force: true });
        continue;
      }
      if (p.sessionId !== ownSessionId) live.push(p);
    }
    return live;
  }

  /** Other live sessions working in `cwd` (step 2, EF-02, CA-01). */
  sameFolder(cwd: string, ownSessionId?: string): Presence[] {
    const key = comparablePath(cwd, this.#o.platform);
    return this.others(ownSessionId).filter((p) => comparablePath(p.cwd, this.#o.platform) === key);
  }

  /** Is this session already open in another process (step 3, EF-03, CA-02)? */
  isActive(sessionId: string): boolean {
    return this.others().some((p) => p.sessionId === sessionId && p.pid !== process.pid);
  }

  /** Publishes the presence of this session and refreshes it until `withdraw` (step 4). */
  publish(sessionId: string, cwd: string): void {
    mkdirSync(this.#o.dir, { recursive: true, mode: 0o700 });
    const write = () => {
      this.#own = { sessionId, pid: process.pid, cwd, heartbeat: this.#now().toISOString() };
      try {
        writeFileSync(join(this.#o.dir, `${sessionId}.json`), JSON.stringify(this.#own), { mode: 0o600 });
      } catch {
        // a presence that cannot be written only weakens the warnings
      }
    };
    write();
    this.#timer = setInterval(write, Math.max(1_000, Math.floor(this.#o.timeoutMs / 3)));
    this.#timer.unref?.();
  }

  withdraw(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
    if (this.#own) rmSync(join(this.#o.dir, `${this.#own.sessionId}.json`), { force: true });
    this.#own = undefined;
  }
}
