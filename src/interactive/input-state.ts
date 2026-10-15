// Supports: SPEC-SES-001 (protected storage access), gap E-181.
import { ArchiveFailure } from "../session/archive-crypto";
import { storeExists as existsSync, storeMkdir as mkdirSync, storeRead as readFileSync, storeRename as renameSync, storeWrite as writeFileSync } from "../session/private-storage";
// Implements: SPEC-IHM-007 (EF-04, § 5.6 draft kept with the session, CA-04), SPEC-IHM-011 (EF-06, ENF-02, FA-06, CA-07)
// The draft, the queue and the stashed drafts of a session, in its private folder: written on each change (the draft
// after a short pause), atomically, and read back when the session is reopened, without anything being sent.


import { dirname, join } from "node:path";
import type { InputState } from "./app";

const FILE = "input-state.json";

export function inputStatePath(sessionDir: string): string {
  return join(sessionDir, FILE);
}

/** The session folder of a transcript file (`<id>.jsonl` → `<id>/`). */
export function sessionDirOf(transcriptPath: string): string {
  return transcriptPath.replace(/\.jsonl$/, "");
}

export function readInputState(path: string): InputState | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<InputState>;
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((s): s is string => typeof s === "string") : []);
    return { draft: typeof v.draft === "string" ? v.draft : "", queue: strings(v.queue), stash: strings(v.stash) };
  } catch (error) {
    if (error instanceof ArchiveFailure) throw error;
    return undefined;
  }
}

export class InputStateWriter {
  #timer: ReturnType<typeof setTimeout> | undefined;
  #pending: InputState | undefined;
  #last = "";

  constructor(
    readonly path: string,
    readonly persistDraft: boolean,
    readonly delayMs = 300,
  ) {}

  /** A change of the queue or of the stash is written at once (ENF-02); a change of the draft alone after a pause. */
  update(state: InputState): void {
    const s: InputState = this.persistDraft ? state : { ...state, draft: "" };
    const previous = this.#pending ?? (this.#last ? (JSON.parse(this.#last) as InputState) : undefined);
    this.#pending = s;
    const structural = !previous || JSON.stringify(previous.queue) !== JSON.stringify(s.queue) || JSON.stringify(previous.stash) !== JSON.stringify(s.stash);
    if (structural) this.flush();
    else if (!this.#timer) this.#timer = setTimeout(() => this.flush(), this.delayMs);
  }

  flush(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const s = this.#pending;
    this.#pending = undefined;
    if (!s) return;
    const text = JSON.stringify(s);
    if (text === this.#last) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, text, { mode: 0o600 });
      renameSync(tmp, this.path);
      this.#last = text;
    } catch {
      // The state of the input is a convenience: a failed write never stops the session.
    }
  }
}
