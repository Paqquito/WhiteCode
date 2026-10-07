// Minimal terminal emulator of the tests: interprets the sequences the renderer emits (cursor moves, erasures, styles,
// modes), keeps a grid, a scrollback and counters of written cells, so that frames can be compared cell by cell.

interface VCell {
  ch: string;
  /** SGR parameters in force when the cell was written ("" = default). */
  sgr: string;
}

const blankCell = (): VCell => ({ ch: " ", sgr: "" });

function widthOf(g: string): number {
  return Math.min(2, Bun.stringWidth(g));
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class VTerm {
  grid: VCell[][];
  readonly scrollback: string[] = [];
  row = 0;
  col = 0;
  wrapPending = false;
  sgr = "";
  readonly modes = new Set<string>();
  cursorVisible = true;
  /** Cells printed per screen row since the last `resetCounters()`. */
  written: number[];
  /** Every chunk received. */
  readonly chunks: string[] = [];
  raw = false;
  #pending = "";

  constructor(
    public columns: number,
    public rows: number,
  ) {
    this.grid = Array.from({ length: rows }, () => Array.from({ length: columns }, blankCell));
    this.written = new Array(rows).fill(0);
  }

  resetCounters(): void {
    this.written = new Array(this.rows).fill(0);
  }

  /** Changes the dimensions without rewrapping (the content is cut or padded). */
  resize(columns: number, rows: number): void {
    const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: columns }, (_, c) => this.grid[r + Math.max(0, this.rows - rows)]?.[c] ?? blankCell()));
    if (rows < this.rows) for (let r = 0; r < this.rows - rows; r++) this.scrollback.push(this.#rowText(this.grid[r]!));
    this.row = Math.max(0, Math.min(rows - 1, this.row - Math.max(0, this.rows - rows)));
    this.col = Math.min(columns - 1, this.col);
    this.grid = grid;
    this.columns = columns;
    this.rows = rows;
    this.written = new Array(rows).fill(0);
  }

  write(data: string): void {
    this.chunks.push(data);
    const s = this.#pending + data;
    this.#pending = "";
    let i = 0;
    while (i < s.length) {
      const c = s[i]!;
      if (c === "\u001b") {
        const end = this.#sequenceEnd(s, i);
        if (end === -1) {
          this.#pending = s.slice(i);
          return;
        }
        this.#escape(s.slice(i, end));
        i = end;
        continue;
      }
      if (c === "\r") {
        this.col = 0;
        this.wrapPending = false;
        i++;
        continue;
      }
      if (c === "\n") {
        this.#lineFeed();
        this.wrapPending = false;
        i++;
        continue;
      }
      if (c === "\b") {
        this.col = Math.max(0, this.col - 1);
        i++;
        continue;
      }
      if (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f) throw new Error(`control character written to the terminal: ${JSON.stringify(c)}`);
      // One grapheme at a time.
      let j = i;
      while (j < s.length && s[j] !== "\u001b" && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) !== 0x7f) j++;
      for (const { segment } of segmenter.segment(s.slice(i, j))) this.#print(segment);
      i = j;
    }
  }

  #sequenceEnd(s: string, i: number): number {
    if (i + 1 >= s.length) return -1;
    const kind = s[i + 1];
    if (kind === "[") {
      for (let k = i + 2; k < s.length; k++) if (s.charCodeAt(k) >= 0x40 && s.charCodeAt(k) <= 0x7e) return k + 1;
      return -1;
    }
    if (kind === "]") {
      for (let k = i + 2; k < s.length; k++) {
        if (s[k] === "\u0007") return k + 1;
        if (s[k] === "\u001b" && s[k + 1] === "\\") return k + 2;
      }
      return -1;
    }
    return i + 2;
  }

  #escape(seq: string): void {
    if (seq[1] !== "[") return; // OSC and other sequences: ignored
    const final = seq[seq.length - 1]!;
    const body = seq.slice(2, -1);
    if (body.startsWith("?")) {
      for (const m of body.slice(1).split(";")) {
        if (final === "h") this.modes.add(m);
        if (final === "l") this.modes.delete(m);
        if (m === "25") this.cursorVisible = final === "h";
      }
      return;
    }
    const n = (d: number) => (body === "" ? d : Number(body.split(";")[0]) || d);
    this.wrapPending = false;
    switch (final) {
      case "A":
        this.row = Math.max(0, this.row - n(1));
        break;
      case "B":
        this.row = Math.min(this.rows - 1, this.row + n(1));
        break;
      case "C":
        this.col = Math.min(this.columns - 1, this.col + n(1));
        break;
      case "D":
        this.col = Math.max(0, this.col - n(1));
        break;
      case "G":
        this.col = Math.min(this.columns - 1, n(1) - 1);
        break;
      case "H": {
        const [r, c] = body.split(";").map((v) => Number(v) || 1);
        this.row = Math.min(this.rows - 1, (r ?? 1) - 1);
        this.col = Math.min(this.columns - 1, (c ?? 1) - 1);
        break;
      }
      case "K": {
        const mode = n(0);
        const line = this.grid[this.row]!;
        for (let c = 0; c < this.columns; c++) if ((mode === 0 && c >= this.col) || (mode === 1 && c <= this.col) || mode === 2) line[c] = blankCell();
        break;
      }
      case "J": {
        const mode = n(0);
        for (let r = 0; r < this.rows; r++)
          for (let c = 0; c < this.columns; c++) {
            const after = r > this.row || (r === this.row && c >= this.col);
            if ((mode === 0 && after) || (mode === 1 && !after) || mode >= 2) this.grid[r]![c] = blankCell();
          }
        break;
      }
      case "m":
        this.sgr = body === "0" || body === "" ? "" : body.replace(/^0;/, "");
        break;
    }
  }

  #lineFeed(): void {
    if (this.row === this.rows - 1) {
      this.scrollback.push(this.#rowText(this.grid.shift()!));
      this.grid.push(Array.from({ length: this.columns }, blankCell));
      this.written.shift();
      this.written.push(0);
    } else this.row++;
  }

  #print(g: string): void {
    const w = widthOf(g);
    if (w === 0) {
      const prev = this.grid[this.row]![Math.max(0, this.col - 1)]!;
      prev.ch += g;
      return;
    }
    if (this.wrapPending || this.col + w > this.columns) {
      this.col = 0;
      this.#lineFeed();
      this.wrapPending = false;
    }
    this.grid[this.row]![this.col] = { ch: g, sgr: this.sgr };
    this.written[this.row]!++;
    if (w === 2 && this.col + 1 < this.columns) this.grid[this.row]![this.col + 1] = { ch: "", sgr: this.sgr };
    if (this.col + w >= this.columns) {
      this.col = this.columns - 1;
      this.wrapPending = true;
    } else this.col += w;
  }

  #rowText(row: readonly VCell[]): string {
    return row.map((c) => c.ch).join("").replace(/\s+$/, "");
  }

  /** Visible rows, trailing spaces removed. */
  screen(): string[] {
    return this.grid.map((r) => this.#rowText(r));
  }

  /** Scrollback then visible rows, without the empty rows at the bottom. */
  all(): string[] {
    const rows = [...this.scrollback, ...this.screen()];
    while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
    return rows;
  }

  /** SGR parameters of the cell at `row`, `col`. */
  styleAt(row: number, col: number): string {
    return this.grid[row]![col]!.sgr;
  }
}

/** A terminal for the renderer and the interactive driver, backed by a `VTerm`. */
export function fakeTerminal(columns = 80, rows = 24) {
  const vt = new VTerm(columns, rows);
  const inputListeners = new Set<(data: string) => void>();
  const resizeListeners = new Set<() => void>();
  const exitListeners = new Set<() => void>();
  return {
    vt,
    write: (data: string) => vt.write(data),
    get columns() {
      return vt.columns;
    },
    get rows() {
      return vt.rows;
    },
    onInput(l: (data: string) => void) {
      inputListeners.add(l);
      return () => void inputListeners.delete(l);
    },
    onResize(l: () => void) {
      resizeListeners.add(l);
      return () => void resizeListeners.delete(l);
    },
    setRawMode(on: boolean) {
      vt.raw = on;
    },
    onProcessExit(l: () => void) {
      exitListeners.add(l);
      return () => void exitListeners.delete(l);
    },
    /** Keys or pasted text, as the terminal would send them. */
    type(data: string) {
      for (const l of [...inputListeners]) l(data);
    },
    resize(c: number, r: number) {
      vt.resize(c, r);
      for (const l of [...resizeListeners]) l();
    },
    exitProcess() {
      for (const l of [...exitListeners]) l();
    },
  };
}
