// Supports: SPEC-IHM-038 (CA-01, append-only rendering), gap E-161.
// Supports: SPEC-OBS-010 (CA-01, measured frame duration histogram), gap E-160.
// Implements: SPEC-IHM-001 (§ 5.1 render cycle, § 5.4 resize, § 5.5 restoration, EF-01, EF-02, EF-06, FA-03, FA-04, FA-05, ERR-02, RG-02, RG-03, ENF-02, CA-01, CA-04, CA-05), SPEC-IHM-002 (§ 5.4 long stream, EF-01, EF-03, EF-05, RG-01, CA-01, CA-02, CA-04)
// The screen: a live area at the bottom of the terminal, rewritten by difference, and the finished content written once
// above it, then left to the native scrollback of the terminal (selectable and copyable like any output). Frames are
// grouped under a maximal rate; nothing runs while nothing changes.

import type { Capabilities } from "./capabilities";
import { sgr } from "./style";
import type { Cell, Line } from "./text";

export interface TerminalOutput {
  write(data: string): void;
  readonly columns: number;
  readonly rows: number;
}

export interface Scheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realScheduler: Scheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

export interface Frame {
  readonly lines: readonly Line[];
  readonly cursor?: { readonly row: number; readonly col: number };
}

export interface ScreenStats {
  frames: number;
  /** Cells written by the last frame. */
  lastCells: number;
  /** Lines of the live area laid out by the last frame. */
  lastLines: number;
  fullRedraws: number;
  /** Invalidations merged into a pending frame (FA-04). */
  coalesced: number;
  durationMs: number;
  slowFrames: number;
  buckets: number[];
}

const ESC = "\u001b[";
const DEFAULT_KEY = "";

/** Length of a line without its trailing blank cells of default style. */
function trimmedLength(line: Line | undefined): number {
  if (!line) return 0;
  let n = line.length;
  while (n > 0 && line[n - 1]!.ch === " " && line[n - 1]!.key === DEFAULT_KEY) n--;
  return n;
}

const BLANK: Cell = { ch: " ", w: 1, key: DEFAULT_KEY };
const sameCell = (a: Cell | undefined, b: Cell | undefined) => (a ?? BLANK).ch === (b ?? BLANK).ch && (a ?? BLANK).key === (b ?? BLANK).key;

export class Screen {
  readonly stats: ScreenStats = { frames: 0, lastCells: 0, lastLines: 0, fullRedraws: 0, coalesced: 0, durationMs: 0, slowFrames: 0, buckets: Array.from({ length: 8 }, () => 0) };
  readonly #slowFrameMs: number;
  readonly #term: TerminalOutput;
  readonly #caps: Capabilities;
  readonly #sequential: boolean;
  readonly #interval: number;
  readonly #scheduler: Scheduler;
  readonly #source: (size: { columns: number; rows: number }) => Frame;
  readonly #onBroken: (error: unknown) => void;
  /** Lines currently shown in the live area. */
  #prev: Line[] = [];
  /** Rows that exist in the live area (at least the current line). */
  #height = 1;
  /** Hardware cursor, relative to the top of the live area. */
  #row = 0;
  #col = 0;
  #timer: unknown;
  #last = -Infinity;
  #started = false;
  #stopped = false;
  #broken = false;
  #columns: number;
  /** A full-screen view holds the terminal: nothing is written; finished lines wait (SPEC-IHM-006 EF-05). */
  #suspended = false;
  #deferred: Line[] = [];
  #resizedWhileSuspended = false;

  constructor(o: {
    terminal: TerminalOutput;
    capabilities: Capabilities;
    maxFramesPerSecond: number;
    source: (size: { columns: number; rows: number }) => Frame;
    scheduler?: Scheduler;
    onBroken?: (error: unknown) => void;
    slowFrameMs?: number;
    sequential?: boolean;
  }) {
    this.#term = o.terminal;
    this.#sequential = o.sequential ?? false;
    this.#slowFrameMs = o.slowFrameMs ?? 50;
    this.#caps = o.capabilities;
    this.#interval = 1000 / Math.max(1, o.maxFramesPerSecond);
    this.#scheduler = o.scheduler ?? realScheduler;
    this.#source = o.source;
    this.#onBroken = o.onBroken ?? (() => {});
    this.#columns = this.#size().columns;
  }

  /** ERR-01: unknown dimensions are taken as 80 × 24. */
  #size(): { columns: number; rows: number } {
    const columns = this.#term.columns > 0 ? this.#term.columns : 80;
    const rows = this.#term.rows > 0 ? this.#term.rows : 24;
    return { columns, rows };
  }

  get broken(): boolean {
    return this.#broken;
  }

  start(): void {
    if (this.#started) return;
    this.#started = true;
    if (!this.#sequential && this.#caps.bracketedPaste) this.#write(`${ESC}?2004h`);
  }

  /**
   * Restores the terminal (EF-02, RG-02): the live area is erased, then the attributes, the cursor and the modes are
   * reset. Idempotent, so that it can run on a normal exit, an error or a signal.
   */
  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = undefined;
    if (this.#sequential) return;
    let out = "";
    if (!this.#broken) out += this.#moveTo(0, 0) + `${ESC}J`;
    out += `${ESC}0m${ESC}?25h`;
    if (this.#caps.bracketedPaste) out += `${ESC}?2004l`;
    if (this.#caps.synchronizedOutput) out += `${ESC}?2026l`;
    this.#prev = [];
    this.#height = 1;
    this.#write(out, true);
  }

  /** The terminal is lent to a full-screen view (alternate buffer): no writing until `resume`. */
  suspend(): void {
    this.#suspended = true;
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  /** The view is closed and the screen found again: the waiting lines are written, the live area drawn. */
  resume(): void {
    if (!this.#suspended) return;
    this.#suspended = false;
    if (this.#resizedWhileSuspended) {
      this.#resizedWhileSuspended = false;
      this.resized();
    }
    const waiting = this.#deferred;
    this.#deferred = [];
    if (waiting.length > 0) this.commit(waiting);
    else this.flush();
  }

  /** Marks the live area to be recomputed; frames are grouped under the maximal rate (EF-06, FA-04). */
  invalidate(): void {
    if (this.#stopped || this.#broken || this.#suspended) return;
    if (this.#timer !== undefined) {
      this.stats.coalesced++;
      return;
    }
    const delay = Math.max(0, this.#last + this.#interval - this.#scheduler.now());
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = undefined;
      this.flush();
    }, delay);
  }

  /** Renders the live area now. */
  flush(): void {
    if (this.#stopped || this.#broken || this.#suspended) return;
    if (this.#timer !== undefined) this.#scheduler.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#last = this.#scheduler.now();
    const started = performance.now();
    const size = this.#size();
    const frame = this.#source(size);
    this.#render(frame, size);
    const duration = Math.max(0, performance.now() - started);
    this.stats.durationMs += duration; if (duration > this.#slowFrameMs) this.stats.slowFrames++;
    const bucket = [1, 5, 10, 20, 50, 100, 500].findIndex(limit => duration <= limit);
    this.stats.buckets[bucket < 0 ? 7 : bucket]!++;
  }

  /**
   * Writes finished lines above the live area, once (§ 5.4 point 1, RG-01): they go to the native scrollback and are
   * never written again. The live area is then drawn again below them.
   */
  commit(lines: readonly Line[]): void {
    if (this.#stopped || this.#broken || lines.length === 0) return;
    if (this.#suspended) {
      this.#deferred.push(...lines);
      return;
    }
    const { columns } = this.#size();
    if (this.#sequential) { this.#write(lines.map(line => line.map(cell => cell.ch).join("").trimEnd()).join("\r\n") + "\r\n"); this.flush(); return; }
    let out = this.#begin() + this.#moveTo(0, 0) + `${ESC}J`;
    let cells = 0;
    for (const line of lines) {
      const n = Math.min(trimmedLength(line), columns);
      out += this.#cells(line, 0, n) + `${ESC}0m\r\n`;
      cells += n;
    }
    this.#prev = [];
    this.#height = 1;
    this.#row = 0;
    this.#col = 0;
    this.#write(out + this.#end());
    this.stats.lastCells = cells;
    this.flush();
  }

  /**
   * After a change of dimensions (§ 5.4, CA-05): the live area is erased from its top, found again in the new geometry
   * when the terminal rewraps its lines, then fully drawn again. The content already committed is not touched (FA-03).
   */
  resized(): void {
    if (this.#stopped || this.#broken) return;
    if (this.#sequential) { this.flush(); return; }
    if (this.#suspended) {
      this.#resizedWhileSuspended = true;
      return;
    }
    const { columns } = this.#size();
    let above = this.#row;
    if (this.#caps.reflowOnResize && columns < this.#columns) {
      above = 0;
      for (let i = 0; i < this.#row; i++) above += Math.max(1, Math.ceil(trimmedLength(this.#prev[i]) / columns));
      above += Math.floor(this.#col / columns);
    }
    this.#columns = columns;
    const out = this.#begin() + "\r" + (above > 0 ? `${ESC}${above}A` : "") + `${ESC}J` + this.#end();
    this.#prev = [];
    this.#height = 1;
    this.#row = 0;
    this.#col = 0;
    this.stats.fullRedraws++;
    this.#write(out);
    this.flush();
  }

  #begin(): string {
    return (this.#caps.synchronizedOutput ? `${ESC}?2026h` : "") + `${ESC}?25l`;
  }

  #end(cursorVisible = false): string {
    return (cursorVisible ? `${ESC}?25h` : "") + (this.#caps.synchronizedOutput ? `${ESC}?2026l` : "");
  }

  /** Relative move inside the live area: rows that exist only (RG-03). */
  #moveTo(row: number, col: number): string {
    let out = "";
    if (row < this.#row) out += `${ESC}${this.#row - row}A`;
    else if (row > this.#row) out += `${ESC}${row - this.#row}B`;
    if (col !== this.#col || out !== "") out += col === 0 ? "\r" : `${ESC}${col + 1}G`;
    this.#row = row;
    this.#col = col;
    return out;
  }

  /** Sequences writing the cells `from` (included) to `to` (excluded), styles included. */
  #cells(line: Line, from: number, to: number): string {
    let out = "";
    let key: string | undefined;
    for (let i = from; i < to; i++) {
      const c = line[i]!;
      if (c.w === 0) continue;
      if (c.key !== key) {
        out += sgr(c.style, this.#caps.colors);
        key = c.key;
      }
      out += c.ch;
    }
    if (key !== undefined && key !== DEFAULT_KEY) out += `${ESC}0m`;
    return out;
  }

  #render(frame: Frame, size: { columns: number; rows: number }): void {
    if (this.#sequential) {
      const before = this.#prev.map(line => line.map(cell => cell.ch).join("").trimEnd());
      const after = frame.lines.map(line => line.map(cell => cell.ch).join("").trimEnd());
      const changed = after.filter((line, index) => line && line !== before[index]);
      if (changed.length) this.#write(changed.join("\r\n") + "\r\n");
      this.#prev = [...frame.lines]; this.stats.frames++; return;
    }
    // RG-03: never beyond the known dimensions; the fixed zones are at the bottom, so the top lines go first.
    let lines = frame.lines.map((l) => (l.length > size.columns ? l.slice(0, size.columns) : l));
    let cursor = frame.cursor;
    if (lines.length > size.rows) {
      const drop = lines.length - size.rows;
      lines = lines.slice(drop);
      cursor = cursor && cursor.row >= drop ? { row: cursor.row - drop, col: cursor.col } : undefined;
    }
    let out = this.#begin();
    let cells = 0;
    const prev = this.#prev;
    for (let i = 0; i < lines.length; i++) {
      const next = lines[i]!;
      const nextEnd = trimmedLength(next);
      if (i >= this.#height) {
        // A new row below the live area: a line break creates it, scrolling the terminal when needed.
        out += this.#moveTo(this.#height - 1, this.#col) + "\r\n";
        this.#height++;
        this.#row = i;
        this.#col = 0;
        out += this.#cells(next, 0, nextEnd);
        cells += nextEnd;
        this.#col = Math.min(nextEnd, size.columns - 1);
        continue;
      }
      const old = prev[i];
      const oldEnd = trimmedLength(old);
      const span = Math.max(nextEnd, oldEnd);
      let a = 0;
      while (a < span && sameCell(old?.[a], next[a])) a++;
      if (a === span) continue; // EF-01: an unchanged line is not written
      let z = span - 1;
      while (z > a && sameCell(old?.[z], next[z])) z--;
      // A double-width grapheme is written whole.
      if (a > 0 && (next[a]?.w === 0 || old?.[a]?.w === 0)) a--;
      if (next[z]?.w === 2 || old?.[z]?.w === 2) z++;
      out += this.#moveTo(i, a);
      if (z + 1 >= nextEnd) {
        out += this.#cells(next, a, nextEnd);
        cells += Math.max(0, nextEnd - a);
        this.#col = Math.min(Math.max(a, nextEnd), size.columns - 1);
        if (oldEnd > nextEnd) out += `${ESC}K`;
      } else {
        out += this.#cells(next, a, z + 1);
        cells += z + 1 - a;
        this.#col = Math.min(z + 1, size.columns - 1);
      }
    }
    if (lines.length < this.#height) {
      // Rows that are no longer used are erased.
      out += this.#moveTo(Math.max(0, lines.length), 0) + `${ESC}J`;
      this.#height = Math.max(1, lines.length);
    }
    if (cursor) out += this.#moveTo(cursor.row, Math.min(cursor.col, size.columns - 1));
    out += this.#end(cursor !== undefined);
    this.#prev = lines;
    this.stats.frames++;
    this.stats.lastCells = cells;
    this.stats.lastLines = lines.length;
    this.#write(out);
  }

  #write(data: string, ignoreBroken = false): void {
    if (this.#broken && !ignoreBroken) return;
    try {
      this.#term.write(data);
    } catch (e) {
      // ERR-02, FA-03: the display stops; what was shown is no longer known.
      this.#broken = true;
      this.#prev = [];
      this.#onBroken(e);
    }
  }
}

/** Equality of two lines by content and style (tests and composition). */
export function sameLine(a: Line, b: Line): boolean {
  const n = Math.max(trimmedLength(a), trimmedLength(b));
  for (let i = 0; i < n; i++) if (!sameCell(a[i], b[i])) return false;
  return true;
}
