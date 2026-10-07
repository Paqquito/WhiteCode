// Implements: SPEC-IHM-013 (§ 5.1 modes, § 5.2 moves, § 5.3 operators and text objects, § 5.4 repetition and registers, FA-01 to FA-05, EF-01, EF-03 to EF-07, ERR-01 to ERR-03, RG-01 to RG-03, CA-01, CA-02, CA-04 to CA-06)
// The modal editing of the input area, for users of modal editors: an insertion mode, a command mode with moves,
// operators, text objects, counts, registers and repetition, and a visual selection. An unknown command never changes
// the content; the content sent is always the one shown.

import type { Editor } from "./editor";
import type { KeyEvent } from "./keys";
import { graphemes } from "./text";

export type ModalMode = "insert" | "normal" | "visual" | "visual-line";

const ESC = "\u001b";
const ENTER = "\r";
const REDO = "\u0012";

type Result = { readonly kind: "incomplete" } | { readonly kind: "invalid" } | { readonly kind: "done"; readonly length: number };

interface Register {
  readonly text: string;
  readonly linewise: boolean;
}

/** Class of a grapheme for the word moves: 0 blank, 1 word character, 2 other. */
function cls(g: string, big: boolean): number {
  if (/^\s+$/u.test(g)) return 0;
  if (big) return 1;
  return /^[\p{L}\p{N}_]/u.test(g) ? 1 : 2;
}

export class ModalEngine {
  mode: ModalMode;
  /** Keys of a command being composed (FA-03), shown by the indicator. */
  pending = "";
  readonly #ed: Editor;
  readonly #countLimit: number;
  readonly #start: "insert" | "normal";
  readonly #registers = new Map<string, Register>();
  #lastChange: { keys: string; inserted?: string } | undefined;
  #lastFind: { op: string; ch: string } | undefined;
  /** The insertion started by a change (`c`, `o`…), to repeat it with `.`. */
  #insertOrigin: { keys: string; text: string; caret: number } | undefined;
  #visualAnchor = 0;

  constructor(editor: Editor, o: { readonly countLimit: number; readonly startMode: "insert" | "normal" }) {
    this.#ed = editor;
    this.#countLimit = o.countLimit;
    this.#start = o.startMode;
    this.mode = o.startMode;
  }

  /** EF-01, CA-01: the mode, as a text and not only by colour. */
  label(): string {
    const name = this.mode === "insert" ? "INSERTION" : this.mode === "normal" ? "COMMANDE" : this.mode === "visual" ? "VISUEL" : "VISUEL LIGNE";
    return `-- ${name} --${this.pending ? ` ${this.pending}` : ""}`;
  }

  /** RG-03: after a message is sent, the configured starting mode comes back. */
  reset(): void {
    this.mode = this.#start;
    this.pending = "";
  }

  /**
   * A key in the modal input. `submit`: the message is to be sent (FA-01); `pass`: the key belongs to the ordinary editing
   * of the insertion mode; `handled`: done here.
   */
  key(k: KeyEvent): "submit" | "handled" | "pass" {
    if (this.mode === "insert") {
      if (k.name === "escape" && !k.ctrl && !k.alt) {
        this.#leaveInsert();
        return "handled";
      }
      return "pass";
    }
    if (k.name === "enter" && !k.alt && !k.shift && this.pending === "") return "submit";
    const token = k.name === "escape" ? ESC : k.name === "enter" ? ENTER : k.ctrl && k.name === "r" ? REDO : k.text !== undefined && !k.ctrl && !k.alt ? k.text : undefined;
    if (token === undefined) return "handled"; // ERR-01: ignored
    if (token === ESC) {
      // FA-03: an escape cancels a sequence; in a visual mode, it leaves it.
      if (this.pending === "" && this.mode !== "normal") this.mode = "normal";
      this.pending = "";
      return "handled";
    }
    this.pending += token;
    const r = this.#run(this.pending, false);
    if (r.kind !== "incomplete") this.pending = ""; // FA-02, EF-04: an unknown command is dropped without effect
    return "handled";
  }

  #leaveInsert(): void {
    if (this.#insertOrigin) {
      const o = this.#insertOrigin;
      const now = this.#ed.text;
      const inserted = now.length >= o.text.length ? now.slice(o.caret, o.caret + (now.length - o.text.length)) : "";
      this.#lastChange = { keys: o.keys, inserted };
      this.#insertOrigin = undefined;
    }
    this.mode = "normal";
    // As in modal editors, the caret steps back onto the last inserted character.
    const t = this.#ed.text;
    const c = this.#ed.caret;
    if (c > 0 && t[c - 1] !== "\n") this.#ed.setCaret(this.#prevBoundary(c));
  }

  // ---- Text geometry --------------------------------------------------------------------------------------------------

  #prevBoundary(offset: number): number {
    const before = graphemes(this.#ed.text.slice(0, offset));
    return offset - (before[before.length - 1]?.length ?? 0);
  }

  #nextBoundary(offset: number): number {
    const after = graphemes(this.#ed.text.slice(offset));
    return offset + (after[0]?.length ?? 0);
  }

  #lineStart(offset: number): number {
    return this.#ed.text.lastIndexOf("\n", offset - 1) + 1;
  }

  #lineEnd(offset: number): number {
    const e = this.#ed.text.indexOf("\n", offset);
    return e === -1 ? this.#ed.text.length : e;
  }

  /** The graphemes of the text with their offsets. */
  #cells(): Array<{ g: string; at: number }> {
    const out: Array<{ g: string; at: number }> = [];
    let at = 0;
    for (const g of graphemes(this.#ed.text)) {
      out.push({ g, at });
      at += g.length;
    }
    return out;
  }

  #index(cells: Array<{ at: number }>, offset: number): number {
    const i = cells.findIndex((c) => c.at >= offset);
    return i === -1 ? cells.length : i;
  }

  // ---- Moves (§ 5.2) ---------------------------------------------------------------------------------------------------

  /** A move from `from`, `count` times: the target and how an operator takes it. */
  #motion(m: string, count: number, from: number): { to: number; inclusive?: boolean; linewise?: boolean } | undefined {
    const t = this.#ed.text;
    const cells = this.#cells();
    let i = this.#index(cells, from);
    const at = (k: number) => (k >= cells.length ? t.length : cells[k]!.at);
    switch (m) {
      case "h":
      case "\u007f": {
        const ls = this.#lineStart(from);
        let to = from;
        for (let n = 0; n < count && to > ls; n++) to = this.#prevBoundary(to);
        return { to };
      }
      case "l":
      case " ": {
        const le = this.#lineEnd(from);
        let to = from;
        for (let n = 0; n < count && to < le; n++) to = this.#nextBoundary(to);
        return { to };
      }
      case "0":
        return { to: this.#lineStart(from) };
      case "^": {
        const ls = this.#lineStart(from);
        const m2 = /^[ \t]*/.exec(t.slice(ls))!;
        return { to: ls + m2[0].length };
      }
      case "$": {
        let to = this.#lineEnd(from);
        for (let n = 1; n < count && to < t.length; n++) to = this.#lineEnd(to + 1);
        return { to: Math.max(this.#lineStart(to), this.#prevBoundary(to)), inclusive: true };
      }
      case "w":
      case "W": {
        const big = m === "W";
        for (let n = 0; n < count && i < cells.length; n++) {
          const c0 = cls(cells[i]!.g, big);
          if (c0 !== 0) while (i < cells.length && cls(cells[i]!.g, big) === c0) i++;
          while (i < cells.length && cls(cells[i]!.g, big) === 0) i++;
        }
        return { to: at(i) };
      }
      case "b":
      case "B": {
        const big = m === "B";
        for (let n = 0; n < count && i > 0; n++) {
          i--;
          while (i > 0 && cls(cells[i]!.g, big) === 0) i--;
          const c0 = cls(cells[i]!.g, big);
          while (i > 0 && cls(cells[i - 1]!.g, big) === c0) i--;
        }
        return { to: at(i) };
      }
      case "e":
      case "E": {
        const big = m === "E";
        for (let n = 0; n < count && i < cells.length - 1; n++) {
          i++;
          while (i < cells.length - 1 && cls(cells[i]!.g, big) === 0) i++;
          const c0 = cls(cells[i]!.g, big);
          while (i < cells.length - 1 && cls(cells[i + 1]!.g, big) === c0) i++;
        }
        return { to: at(i), inclusive: true };
      }
      case "gg":
        return { to: 0, linewise: true };
      case "G":
        return { to: this.#lineStart(t.length), linewise: true };
      case "j":
      case "k": {
        let to = from;
        const col = graphemes(t.slice(this.#lineStart(from), from)).length;
        for (let n = 0; n < count; n++) {
          if (m === "j") {
            const le = this.#lineEnd(to);
            if (le >= t.length) return n === 0 ? undefined : { to, linewise: true };
            to = le + 1;
          } else {
            const ls = this.#lineStart(to);
            if (ls === 0) return n === 0 ? undefined : { to, linewise: true };
            to = this.#lineStart(ls - 1);
          }
        }
        const line = graphemes(t.slice(to, this.#lineEnd(to)));
        return { to: to + line.slice(0, col).join("").length, linewise: true };
      }
      case "%": {
        const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}", ")": "(", "]": "[", "}": "{" };
        let k = i;
        while (k < cells.length && !pairs[cells[k]!.g] && cells[k]!.g !== "\n") k++;
        const open = cells[k]?.g;
        if (!open || !pairs[open]) return undefined;
        const forward = "([{".includes(open);
        let depth = 0;
        for (let j = k; forward ? j < cells.length : j >= 0; j += forward ? 1 : -1) {
          if (cells[j]!.g === open) depth++;
          else if (cells[j]!.g === pairs[open]) depth--;
          if (depth === 0) return { to: cells[j]!.at, inclusive: true };
        }
        return undefined;
      }
      default:
        return this.#find(m, count, from);
    }
  }

  /** f, F, t, T and their repetition ; and , on the line. */
  #find(m: string, count: number, from: number): { to: number; inclusive?: boolean } | undefined {
    let op = m[0]!;
    let ch = m.slice(1);
    if (m === ";" || m === ",") {
      if (!this.#lastFind) return undefined;
      ({ op, ch } = this.#lastFind);
      if (m === ",") op = op === "f" ? "F" : op === "F" ? "f" : op === "t" ? "T" : "t";
    } else {
      if (!"fFtT".includes(op) || ch === "") return undefined;
      this.#lastFind = { op, ch };
    }
    const t = this.#ed.text;
    const ls = this.#lineStart(from);
    const le = this.#lineEnd(from);
    let pos = from;
    for (let n = 0; n < count; n++) {
      if (op === "f" || op === "t") {
        const k = t.indexOf(ch, pos + 1);
        if (k === -1 || k >= le) return undefined;
        pos = k;
      } else {
        const k = t.lastIndexOf(ch, pos - 1);
        if (k < ls) return undefined;
        pos = k;
      }
    }
    if (op === "t") pos = this.#prevBoundary(pos);
    if (op === "T") pos = this.#nextBoundary(pos);
    return { to: pos, inclusive: op === "f" || op === "t" };
  }

  // ---- Text objects (§ 5.3) -------------------------------------------------------------------------------------------

  #object(kind: "i" | "a", o: string, from: number): [number, number] | undefined {
    const t = this.#ed.text;
    const cells = this.#cells();
    const i = Math.min(this.#index(cells, from), cells.length - 1);
    if (i < 0) return undefined;
    if (o === "w" || o === "W") {
      const big = o === "W";
      const c0 = cls(cells[i]!.g, big);
      let s = i;
      let e = i;
      while (s > 0 && cls(cells[s - 1]!.g, big) === c0 && cells[s - 1]!.g !== "\n") s--;
      while (e < cells.length - 1 && cls(cells[e + 1]!.g, big) === c0 && cells[e + 1]!.g !== "\n") e++;
      let end = e + 1;
      let start = s;
      if (kind === "a") {
        let k = end;
        while (k < cells.length && cls(cells[k]!.g, big) === 0 && cells[k]!.g !== "\n") k++;
        if (k > end) end = k;
        else while (start > 0 && cls(cells[start - 1]!.g, big) === 0 && cells[start - 1]!.g !== "\n") start--;
      }
      return [cells[start]!.at, end >= cells.length ? t.length : cells[end]!.at];
    }
    if (o === '"' || o === "'" || o === "`") {
      const ls = this.#lineStart(from);
      const le = this.#lineEnd(from);
      const line = t.slice(ls, le);
      const quotes: number[] = [];
      for (let k = 0; k < line.length; k++) if (line[k] === o && line[k - 1] !== "\\") quotes.push(ls + k);
      for (let k = 0; k + 1 < quotes.length; k += 2) {
        const [a, b] = [quotes[k]!, quotes[k + 1]!];
        if (from >= a && from <= b) return kind === "i" ? [a + 1, b] : [a, b + 1];
      }
      return undefined;
    }
    const pairs: Record<string, [string, string]> = { "(": ["(", ")"], ")": ["(", ")"], b: ["(", ")"], "[": ["[", "]"], "]": ["[", "]"], "{": ["{", "}"], "}": ["{", "}"], B: ["{", "}"], "<": ["<", ">"], ">": ["<", ">"] };
    const pair = pairs[o];
    if (pair) {
      let depth = 0;
      let open = -1;
      for (let k = from; k >= 0; k--) {
        if (t[k] === pair[1] && k !== from) depth++;
        else if (t[k] === pair[0]) {
          if (depth === 0) {
            open = k;
            break;
          }
          depth--;
        }
      }
      if (open === -1) return undefined; // ERR-03: no change
      depth = 0;
      for (let k = open + 1; k < t.length; k++) {
        if (t[k] === pair[0]) depth++;
        else if (t[k] === pair[1]) {
          if (depth === 0) return kind === "i" ? [open + 1, k] : [open, k + 1];
          depth--;
        }
      }
      return undefined;
    }
    if (o === "p") {
      const lines = t.split("\n");
      let offset = 0;
      const starts = lines.map((l) => {
        const s = offset;
        offset += l.length + 1;
        return s;
      });
      let li = starts.findIndex((s, k) => from >= s && from <= s + lines[k]!.length);
      if (li === -1) li = lines.length - 1;
      const blank = (k: number) => lines[k]!.trim() === "";
      const kindOf = blank(li);
      let a = li;
      let b = li;
      while (a > 0 && blank(a - 1) === kindOf) a--;
      while (b < lines.length - 1 && blank(b + 1) === kindOf) b++;
      if (kind === "a") while (b < lines.length - 1 && blank(b + 1) !== kindOf) b++;
      return [starts[a]!, Math.min(t.length, starts[b]! + lines[b]!.length + 1)];
    }
    return undefined;
  }

  // ---- Commands -------------------------------------------------------------------------------------------------------

  /** Parses and runs a command; `replay`: a repetition by `.`. */
  #run(keys: string, replay: boolean): Result {
    let p = 0;
    const count = (): number | undefined | "incomplete" => {
      const m = /^[1-9][0-9]*/.exec(keys.slice(p));
      if (!m) return undefined;
      p += m[0].length;
      if (p >= keys.length) return "incomplete";
      return Math.min(Number(m[0]), this.#countLimit); // ERR-02
    };
    const c1 = count();
    if (c1 === "incomplete") return { kind: "incomplete" };
    let register = '"';
    if (keys[p] === '"') {
      if (p + 1 >= keys.length) return { kind: "incomplete" };
      register = keys[p + 1]!;
      if (!/[a-z"]/.test(register)) return { kind: "invalid" };
      p += 2;
      if (p >= keys.length) return { kind: "incomplete" };
    }
    const rest = keys.slice(p);
    const n = c1 ?? 1;
    const cmd = rest[0]!;
    const ed = this.#ed;
    const from = ed.caret;
    const visual = this.mode === "visual" || this.mode === "visual-line";

    // Visual mode: the operators apply to the selection.
    if (visual && "dxcy><~".includes(cmd)) {
      let [a, b] = [Math.min(this.#visualAnchor, from), Math.max(this.#visualAnchor, from)];
      b = this.#nextBoundary(b);
      if (this.mode === "visual-line") {
        a = this.#lineStart(a);
        b = Math.min(ed.text.length, this.#lineEnd(Math.max(a, b - 1)) + 1);
      }
      const lineVisual = this.mode === "visual-line";
      this.mode = "normal";
      this.#apply(cmd === "x" ? "d" : cmd === "~" ? "g~" : cmd, a, b, lineVisual, register, keys, replay);
      return { kind: "done", length: keys.length };
    }

    // Moves.
    const motionKeys = rest.startsWith("g") ? (rest.length < 2 ? "incomplete" : rest.slice(0, 2)) : "fFtT".includes(cmd) ? (rest.length < 2 ? "incomplete" : rest.slice(0, 2)) : cmd;
    if (motionKeys === "incomplete") return { kind: "incomplete" };
    if (/^(h|l|j|k|0|\^|\$|w|W|b|B|e|E|gg|G|%|;|,|[fFtT].| |\u007f)$/su.test(motionKeys) && !(motionKeys === "0" && c1 !== undefined)) {
      const target = this.#motion(motionKeys, n, from);
      if (!target) return { kind: "invalid" };
      ed.setCaret(target.to);
      return { kind: "done", length: keys.length };
    }

    switch (cmd) {
      case "i":
      case "a":
      case "I":
      case "A":
      case "o":
      case "O": {
        const t = ed.text;
        if (cmd === "a") ed.setCaret(t[from] === "\n" || from >= t.length ? from : this.#nextBoundary(from));
        if (cmd === "I") ed.setCaret(this.#motion("^", 1, from)!.to);
        if (cmd === "A") ed.setCaret(this.#lineEnd(from));
        if (cmd === "o") ed.replace(this.#lineEnd(from), this.#lineEnd(from), "\n");
        if (cmd === "O") ed.replace(this.#lineStart(from), this.#lineStart(from), "\n", this.#lineStart(from));
        this.#enterInsert(keys);
        return { kind: "done", length: keys.length };
      }
      case "v":
      case "V":
        this.#visualAnchor = from;
        this.mode = cmd === "v" ? "visual" : "visual-line";
        return { kind: "done", length: keys.length };
      case "u":
        for (let k = 0; k < n; k++) ed.undo(); // FA-05: the groups of the standard mode
        return { kind: "done", length: keys.length };
      case REDO:
        for (let k = 0; k < n; k++) ed.redo();
        return { kind: "done", length: keys.length };
      case ".": {
        const last = this.#lastChange;
        if (!last) return { kind: "invalid" };
        for (let k = 0; k < n; k++) {
          this.#run(last.keys, true);
          if (last.inserted !== undefined) {
            ed.insert(last.inserted);
            this.mode = "normal";
          }
        }
        return { kind: "done", length: keys.length };
      }
      case "x":
      case "X":
      case "s": {
        const le = this.#lineEnd(from);
        if (cmd === "X") {
          const a = this.#motion("h", n, from)!.to;
          this.#apply("d", a, from, false, register, keys, replay);
        } else {
          let b = from;
          for (let k = 0; k < n && b < le; k++) b = this.#nextBoundary(b);
          this.#apply(cmd === "s" ? "c" : "d", from, b, false, register, keys, replay);
        }
        return { kind: "done", length: keys.length };
      }
      case "D":
      case "C":
        this.#apply(cmd === "D" ? "d" : "c", from, this.#lineEnd(from), false, register, keys, replay);
        return { kind: "done", length: keys.length };
      case "S":
      case "Y":
        return this.#run(`${c1 ?? ""}${register !== '"' ? `"${register}` : ""}${cmd === "S" ? "cc" : "yy"}`, replay);
      case "p":
      case "P": {
        const r = this.#registers.get(register);
        if (!r) return { kind: "invalid" };
        const text = r.text.repeat(n);
        if (r.linewise) {
          const at = cmd === "p" ? Math.min(ed.text.length, this.#lineEnd(from) + 1) : this.#lineStart(from);
          const insertion = cmd === "p" && at === ed.text.length && !ed.text.endsWith("\n") ? `\n${text.replace(/\n$/, "")}` : text;
          ed.replace(at, at, insertion, at + (insertion.startsWith("\n") ? 1 : 0));
        } else {
          const at = cmd === "p" && from < ed.text.length && ed.text[from] !== "\n" ? this.#nextBoundary(from) : from;
          ed.replace(at, at, text, at + text.length - 1);
        }
        this.#lastChange = { keys };
        return { kind: "done", length: keys.length };
      }
      case "r": {
        if (rest.length < 2) return { kind: "incomplete" };
        let b = from;
        for (let k = 0; k < n; k++) b = this.#nextBoundary(b);
        if (b > this.#lineEnd(from)) return { kind: "invalid" };
        ed.replace(from, b, rest[1]!.repeat(n), from);
        this.#lastChange = { keys };
        return { kind: "done", length: keys.length };
      }
      case "~": {
        let b = from;
        for (let k = 0; k < n && b < this.#lineEnd(from); k++) b = this.#nextBoundary(b);
        const part = ed.text.slice(from, b);
        ed.replace(from, b, [...part].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join(""), b);
        this.#lastChange = { keys };
        return { kind: "done", length: keys.length };
      }
      case "J": {
        const le = this.#lineEnd(from);
        if (le >= ed.text.length) return { kind: "invalid" };
        const next = /^[ \t]*/.exec(ed.text.slice(le + 1))![0].length;
        ed.replace(le, le + 1 + next, " ", le);
        this.#lastChange = { keys };
        return { kind: "done", length: keys.length };
      }
      case "d":
      case "c":
      case "y":
      case ">":
      case "<":
        return this.#operator(cmd, rest.slice(1), c1, register, keys, replay);
      case "g": {
        if (rest.length < 2) return { kind: "incomplete" };
        if (rest[1] === "~" || rest[1] === "u" || rest[1] === "U") return this.#operator(`g${rest[1]}`, rest.slice(2), c1, register, keys, replay);
        return { kind: "invalid" };
      }
      default:
        return { kind: "invalid" };
    }
  }

  /** An operator with its move, its text object, or doubled for whole lines (§ 5.3). */
  #operator(op: string, rest: string, c1: number | undefined, register: string, keys: string, replay: boolean): Result {
    const ed = this.#ed;
    const from = ed.caret;
    const m = /^[1-9][0-9]*/.exec(rest);
    const c2 = m ? Math.min(Number(m[0]), this.#countLimit) : undefined;
    const r = rest.slice(m?.[0].length ?? 0);
    if (r === "") return { kind: "incomplete" };
    const n = Math.min((c1 ?? 1) * (c2 ?? 1), this.#countLimit);
    const last = op.length === 2 ? op[1]! : op;
    if (r[0] === last) {
      // Whole lines: dd, cc, yy, >>, <<, g~~.
      const a = this.#lineStart(from);
      let b = this.#lineEnd(from);
      for (let k = 1; k < n && b < ed.text.length; k++) b = this.#lineEnd(b + 1);
      const end = op === "c" ? b : Math.min(ed.text.length, b + 1);
      this.#apply(op, a, end, op !== "c", register, keys, replay);
      return { kind: "done", length: keys.length };
    }
    if (r[0] === "i" || r[0] === "a") {
      if (r.length < 2) return { kind: "incomplete" };
      const range = this.#object(r[0] as "i" | "a", r[1]!, from);
      if (!range) return { kind: "invalid" };
      this.#apply(op, range[0], range[1], false, register, keys, replay);
      return { kind: "done", length: keys.length };
    }
    let motion = r[0] === "g" || "fFtT".includes(r[0]!) ? r.slice(0, 2) : r[0]!;
    if (motion.length < (r[0] === "g" || "fFtT".includes(r[0]!) ? 2 : 1)) return { kind: "incomplete" };
    // `cw` changes to the end of the word, as in modal editors.
    if (op === "c" && (motion === "w" || motion === "W") && !/\s/.test(ed.text[from] ?? " ")) motion = motion === "w" ? "e" : "E";
    const target = this.#motion(motion, n, from);
    if (!target) return { kind: "invalid" };
    let a = Math.min(from, target.to);
    let b = Math.max(from, target.to);
    if (target.inclusive) b = this.#nextBoundary(b);
    if (target.linewise) {
      a = this.#lineStart(a);
      b = Math.min(ed.text.length, this.#lineEnd(b) + 1);
    }
    this.#apply(op, a, b, target.linewise === true, register, keys, replay);
    return { kind: "done", length: keys.length };
  }

  /** Applies an operator to `[a, b)` (one group of edits); the deleted or copied text goes to the register (§ 5.4). */
  #apply(op: string, a: number, b: number, linewise: boolean, register: string, keys: string, replay: boolean): void {
    const ed = this.#ed;
    const t = ed.text;
    const text = t.slice(a, b);
    if (op !== ">" && op !== "<" && !op.startsWith("g")) {
      this.#registers.set(register, { text, linewise });
      if (register !== '"') this.#registers.set('"', { text, linewise });
    }
    if (op === "y") {
      ed.setCaret(a);
      return;
    }
    if (op === "d") ed.replace(a, b, "", Math.min(a, Math.max(0, t.length - (b - a) - 1)));
    else if (op === "c") {
      ed.replace(a, b, "", a);
      if (!replay) this.#enterInsert(keys);
    } else if (op === ">" || op === "<") {
      const ls = this.#lineStart(a);
      const block = t.slice(ls, b);
      const changed = block
        .split("\n")
        .map((l, k, all) => (k === all.length - 1 && l === "" ? l : op === ">" ? `  ${l}` : l.replace(/^( {1,2}|\t)/, "")))
        .join("\n");
      ed.replace(ls, b, changed, ls);
    } else if (op === "g~" || op === "gu" || op === "gU") {
      const changed = op === "gu" ? text.toLowerCase() : op === "gU" ? text.toUpperCase() : [...text].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("");
      ed.replace(a, b, changed, a);
    }
    if (!replay && op !== "c") this.#lastChange = { keys };
  }

  #enterInsert(keys: string): void {
    this.mode = "insert";
    this.#insertOrigin = { keys, text: this.#ed.text, caret: this.#ed.caret };
  }
}
