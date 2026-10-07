// Implements: SPEC-IHM-007 (§ 5.1 text model, § 5.2 moves, § 5.3 editing, § 5.4 multiline, EF-01, EF-02, EF-03, RG-01, RG-03, ERR-01, CA-02, CA-05)
// Text of the input area and its caret. Positions always fall on grapheme boundaries, so that moves stay right with
// double-width, zero-width and composed characters; word moves follow the word boundaries of the text. Undo and redo
// work on coherent groups: a typed word, a deleted word, a pasted text.

import { graphemes, widthOf } from "./text";

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

interface Snapshot {
  readonly text: string;
  readonly caret: number;
}

type EditKind = "insert-word" | "insert-space" | "delete-back" | "delete-forward" | "other";

export class Editor {
  #text = "";
  /** Caret as an offset in the text, always on a grapheme boundary (RG-03). */
  #caret = 0;
  /** Column kept by vertical moves (§ 5.2). */
  #goal: number | undefined;
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #lastKind: EditKind | undefined;

  constructor(readonly maxChars = 100_000) {}

  get text(): string {
    return this.#text;
  }

  get caret(): number {
    return this.#caret;
  }

  /** Caret as an index of grapheme, for the layout. */
  get caretGrapheme(): number {
    return graphemes(this.#text.slice(0, this.#caret)).length;
  }

  get isEmpty(): boolean {
    return this.#text === "";
  }

  /** Line of the caret and number of lines (line breaks only). */
  get lineInfo(): { line: number; lines: number } {
    const before = this.#text.slice(0, this.#caret);
    return { line: before.split("\n").length - 1, lines: this.#text.split("\n").length };
  }

  /** Replaces the whole content (history, restored draft); recorded as one group. */
  set(text: string, caret = text.length): void {
    this.#record("other");
    this.#text = text;
    this.#caret = Math.max(0, Math.min(caret, text.length));
    this.#goal = undefined;
  }

  /** Moves the caret to `offset`, brought back to the nearest grapheme boundary before it (RG-03). */
  setCaret(offset: number): void {
    const target = Math.max(0, Math.min(offset, this.#text.length));
    let at = 0;
    for (const g of graphemes(this.#text)) {
      if (at + g.length > target) break;
      at += g.length;
    }
    this.#move(at);
  }

  /** Replaces `[start, end)` by `text` as one group of edits (a command of the modal mode, SPEC-IHM-013 FA-05). */
  replace(start: number, end: number, text: string, caret = start + text.length): boolean {
    const next = this.#text.slice(0, start) + text + this.#text.slice(end);
    if (next.length > this.maxChars) return false;
    this.#record("other");
    this.#text = next;
    this.#caret = Math.max(0, Math.min(caret, next.length));
    this.#goal = undefined;
    this.#lastKind = undefined;
    return true;
  }

  /** Empties the content; recoverable by undo (§ 5.5). */
  clear(): void {
    if (this.#text === "") return;
    this.set("");
  }

  /** Inserts text at the caret; false when the maximal size would be exceeded (ERR-01). */
  insert(text: string): boolean {
    if (text === "") return true;
    if (this.#text.length + text.length > this.maxChars) return false;
    const kind: EditKind = text.length > 1 ? "other" : /\s/.test(text) ? "insert-space" : "insert-word";
    this.#record(kind);
    this.#text = this.#text.slice(0, this.#caret) + text + this.#text.slice(this.#caret);
    this.#caret += text.length;
    this.#goal = undefined;
    return true;
  }

  newline(): boolean {
    return this.insert("\n");
  }

  backspace(): void {
    if (this.#caret === 0) return;
    this.#record("delete-back");
    const start = this.#previousBoundary(this.#caret);
    this.#text = this.#text.slice(0, start) + this.#text.slice(this.#caret);
    this.#caret = start;
    this.#goal = undefined;
  }

  deleteForward(): void {
    if (this.#caret >= this.#text.length) return;
    this.#record("delete-forward");
    const end = this.#nextBoundary(this.#caret);
    this.#text = this.#text.slice(0, this.#caret) + this.#text.slice(end);
    this.#goal = undefined;
  }

  deleteWordBack(): void {
    const start = this.#wordStartBefore(this.#caret);
    if (start === this.#caret) return;
    this.#record("other");
    this.#text = this.#text.slice(0, start) + this.#text.slice(this.#caret);
    this.#caret = start;
    this.#goal = undefined;
  }

  deleteWordForward(): void {
    const end = this.#wordEndAfter(this.#caret);
    if (end === this.#caret) return;
    this.#record("other");
    this.#text = this.#text.slice(0, this.#caret) + this.#text.slice(end);
    this.#goal = undefined;
  }

  killToLineEnd(): void {
    let end = this.#text.indexOf("\n", this.#caret);
    if (end === -1) end = this.#text.length;
    if (end === this.#caret && end < this.#text.length) end++; // at the end of a line: join the next one
    if (end === this.#caret) return;
    this.#record("other");
    this.#text = this.#text.slice(0, this.#caret) + this.#text.slice(end);
  }

  killToLineStart(): void {
    const start = this.#lineStart(this.#caret);
    if (start === this.#caret) return;
    this.#record("other");
    this.#text = this.#text.slice(0, start) + this.#text.slice(this.#caret);
    this.#caret = start;
  }

  /** Exchanges the two graphemes around the caret. */
  transpose(): void {
    if (this.#caret === 0 || this.#text.length < 2) return;
    const at = this.#caret >= this.#text.length ? this.#previousBoundary(this.#caret) : this.#caret;
    const a = this.#previousBoundary(at);
    const b = this.#nextBoundary(at);
    if (a === at || b === at) return;
    this.#record("other");
    this.#text = this.#text.slice(0, a) + this.#text.slice(at, b) + this.#text.slice(a, at) + this.#text.slice(b);
    this.#caret = b;
  }

  left(): void {
    this.#move(this.#previousBoundary(this.#caret));
  }

  right(): void {
    this.#move(this.#nextBoundary(this.#caret));
  }

  wordLeft(): void {
    this.#move(this.#wordStartBefore(this.#caret));
  }

  wordRight(): void {
    this.#move(this.#wordEndAfter(this.#caret));
  }

  home(): void {
    this.#move(this.#lineStart(this.#caret));
  }

  end(): void {
    const end = this.#text.indexOf("\n", this.#caret);
    this.#move(end === -1 ? this.#text.length : end);
  }

  start(): void {
    this.#move(0);
  }

  finish(): void {
    this.#move(this.#text.length);
  }

  /** Line above, keeping the wanted column; false on the first line (the history then takes over). */
  up(): boolean {
    const start = this.#lineStart(this.#caret);
    if (start === 0) return false;
    this.#vertical(this.#lineStart(start - 1));
    return true;
  }

  /** Line below; false on the last line. */
  down(): boolean {
    const end = this.#text.indexOf("\n", this.#caret);
    if (end === -1) return false;
    this.#vertical(end + 1);
    return true;
  }

  undo(): boolean {
    const s = this.#undo.pop();
    if (!s) return false;
    this.#redo.push({ text: this.#text, caret: this.#caret });
    this.#restore(s);
    return true;
  }

  redo(): boolean {
    const s = this.#redo.pop();
    if (!s) return false;
    this.#undo.push({ text: this.#text, caret: this.#caret });
    this.#restore(s);
    return true;
  }

  /** Ends the current group of edits: the next one starts a new group (after a submit, a move, a change of view). */
  breakGroup(): void {
    this.#lastKind = undefined;
  }

  #restore(s: Snapshot): void {
    this.#text = s.text;
    this.#caret = s.caret;
    this.#goal = undefined;
    this.#lastKind = undefined;
  }

  /**
   * EF-03: a snapshot opens a new group when the kind of edit changes; typed characters form one group per word (a space
   * after a word starts the next group), successive deletions one group.
   */
  #record(kind: EditKind): void {
    const sameGroup = kind !== "other" && (kind === this.#lastKind || (kind === "insert-space" && this.#lastKind === "insert-word"));
    if (!sameGroup) {
      this.#undo.push({ text: this.#text, caret: this.#caret });
      if (this.#undo.length > 500) this.#undo.shift();
    }
    this.#redo = [];
    this.#lastKind = kind;
  }

  #move(to: number): void {
    this.#caret = Math.max(0, Math.min(to, this.#text.length));
    this.#goal = undefined;
    this.#lastKind = undefined;
  }

  #vertical(lineStart: number): void {
    const goal = this.#goal ?? this.#column(this.#caret);
    let end = this.#text.indexOf("\n", lineStart);
    if (end === -1) end = this.#text.length;
    // The offset of the line whose display column is the closest to the goal without exceeding it.
    let at = lineStart;
    let col = 0;
    for (const g of graphemes(this.#text.slice(lineStart, end))) {
      const w = widthOf(g);
      if (col + w > goal) break;
      col += w;
      at += g.length;
    }
    this.#caret = at;
    this.#goal = goal;
    this.#lastKind = undefined;
  }

  /** Display column of an offset in its line. */
  #column(offset: number): number {
    let col = 0;
    for (const g of graphemes(this.#text.slice(this.#lineStart(offset), offset))) col += widthOf(g);
    return col;
  }

  #lineStart(offset: number): number {
    return this.#text.lastIndexOf("\n", offset - 1) + 1;
  }

  #previousBoundary(offset: number): number {
    if (offset <= 0) return 0;
    const before = graphemes(this.#text.slice(0, offset));
    return offset - (before[before.length - 1]?.length ?? 0);
  }

  #nextBoundary(offset: number): number {
    if (offset >= this.#text.length) return this.#text.length;
    const after = graphemes(this.#text.slice(offset));
    return offset + (after[0]?.length ?? 0);
  }

  /** Start of the word before the offset (CA-02: the real word boundaries, double-width characters included). */
  #wordStartBefore(offset: number): number {
    let start = 0;
    for (const s of wordSegmenter.segment(this.#text)) {
      if (s.index >= offset) break;
      if (s.isWordLike) start = s.index;
    }
    return start;
  }

  #wordEndAfter(offset: number): number {
    for (const s of wordSegmenter.segment(this.#text)) {
      const end = s.index + s.segment.length;
      if (end > offset && s.isWordLike) return end;
    }
    return this.#text.length;
  }
}
