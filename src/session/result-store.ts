// Supports: SPEC-SES-001 (protected storage access), gap E-181.
import { storeMkdir as mkdirSync, storeWrite as writeFileSync } from "./private-storage";
// Implements: SPEC-OUT-001 (FA-01, EF-05 large results stored in the session folder, CA-03), SPEC-PER-010 (FA-01 folder of the session, readable)
// Supports: SPEC-OUT-008 (§ 5.3 point 7 complete output stored apart)


import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { storeReference } from "./private-storage";

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
    writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
    return storeReference(path);
  }
  storeBinary(bytes: Uint8Array, extension: string): string {
    if (!/^(png|jpg|gif|webp|bin)$/.test(extension) || bytes.length > 20 * 1024 * 1024) throw new Error("Invalid binary resource.");
    mkdirSync(this.dir, { recursive: true, mode: 0o700 }); const path = join(this.dir, randomUUID() + "." + extension);
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" }); return storeReference(path);
  }
}
