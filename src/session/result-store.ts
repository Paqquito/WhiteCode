// Implements: SPEC-OUT-001 (FA-01, EF-05 large results stored in the session folder, CA-03), SPEC-PER-010 (FA-01 folder of the session, readable)
// Supports: SPEC-OUT-008 (§ 5.3 point 7 complete output stored apart)

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Folder of the large results of one session; files live as long as the session (Q-01 of SPEC-OUT-001). */
export class ResultStore {
  #created = false;

  constructor(readonly dir: string) {}

  /** Writes `text` under a name derived from `key`; returns the absolute path. */
  store(key: string, text: string): string {
    if (!this.#created) {
      mkdirSync(this.dir, { recursive: true });
      this.#created = true;
    }
    const path = join(this.dir, `${key.replace(/[^A-Za-z0-9_-]/g, "_")}.txt`);
    writeFileSync(path, text, "utf8");
    return path;
  }
}
