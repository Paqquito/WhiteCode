// Implements: SPEC-IHM-006 (§ 5.1 opening and closing on the alternate screen, § 5.2 content, § 5.3 navigation, § 5.4 folding, § 5.5 search, FA-01 to FA-05, EF-01 to EF-07, ERR-02, ERR-03, RG-01 to RG-03, ENF-01, ENF-02, CA-01 to CA-06),
//             SPEC-IHM-002 (§ 5.5 keyboard navigation of a view with its own scrolling, EF-07, CA-05 wide content scrolled horizontally)
// The full-screen view of the transcript: every item of the session with its author, time, kind and content; long
// contents folded with a summary; moves by line, page, item and turn; an incremental search that unfolds what it finds;
// a horizontal scroll for the wide contents. It is read-only, opened on the alternate screen so that closing it gives the
// previous screen back exactly, and the session goes on behind it.

import type { Terminal } from "../platform/terminal";
import type { Capabilities } from "../ui/capabilities";
import type { InputEvent } from "../ui/keys";
import { layoutNode, text, type LayoutContext, type Node } from "../ui/layout";
import { Screen } from "../ui/screen";
import { blank, spansToLines, type Cell, type Span } from "../ui/text";

export type ItemKind = "user" | "model" | "tool" | "result" | "notice" | "permission" | "shell" | "thinking" | "marker";

export interface TranscriptItem {
  readonly id: number;
  readonly kind: ItemKind;
  readonly title: string;
  /** Content of the item; sensitive values already masked (EF-06, RG-03). */
  readonly body: string;
  readonly at: number;
  readonly turn: number;
}

export interface ViewSettings {
  /** `ui.transcript.defaultDetail`: `summary`, `normal` or `full`. */
  readonly defaultDetail: string;
  readonly collapseThreshold: number;
  readonly showThinking: boolean;
}

/** State kept for the session (§ 5.3: the position is kept). */
export interface ViewState {
  top: number;
  scrollX: number;
  /** The reader is at the bottom: new items follow; otherwise the position stays (FA-01). */
  atBottom: boolean;
  readonly folded: Map<number, boolean>;
}

export const newViewState = (): ViewState => ({ top: 0, scrollX: 0, atBottom: true, folded: new Map() });

const AUTHOR: Readonly<Record<ItemKind, string>> = {
  user: "Vous",
  model: "Modèle",
  tool: "Appel d'outil",
  result: "Résultat",
  notice: "Produit",
  permission: "Permission",
  shell: "Mode shell",
  thinking: "Raisonnement",
  marker: "Repère",
};

interface Row {
  readonly cells: Cell[];
  readonly item: number;
}

const time = (at: number) => new Date(at).toTimeString().slice(0, 8);

export class TranscriptView {
  readonly #term: Terminal;
  readonly #items: () => readonly TranscriptItem[];
  readonly #settings: ViewSettings;
  readonly #state: ViewState;
  readonly #markdown?: (content: string) => Node;
  readonly #ctx: LayoutContext;
  readonly #onClose: () => void;
  readonly #title: string;
  #screen: Screen | undefined;
  #cache = new Map<string, Cell[][]>();
  #rows: Row[] = [];
  #search: { term: string; editing: boolean; index: number } | undefined;
  #jump: string | undefined;

  constructor(o: {
    readonly terminal: Terminal;
    readonly capabilities: Capabilities;
    readonly items: () => readonly TranscriptItem[];
    readonly settings: ViewSettings;
    readonly state: ViewState;
    readonly title: string;
    readonly markdown?: (content: string) => Node;
    readonly onClose: () => void;
  }) {
    this.#term = o.terminal;
    this.#items = o.items;
    this.#settings = o.settings;
    this.#state = o.state;
    this.#markdown = o.markdown;
    this.#ctx = { unicode: o.capabilities.unicode, narrow: false };
    this.#onClose = o.onClose;
    this.#title = o.title;
    this.#screen = new Screen({ terminal: o.terminal, capabilities: o.capabilities, maxFramesPerSecond: 60, source: (size) => ({ lines: this.#frame(size) }) });
  }

  /** § 5.1, FA-03: the alternate screen, so that the closing gives the previous screen back exactly (EF-02, CA-03). */
  open(): void {
    this.#term.write("\u001b[?1049h\u001b[H\u001b[2J");
    this.#screen!.flush();
  }

  close(): void {
    this.#term.write("\u001b[0m\u001b[?1049l");
    this.#screen = undefined;
    this.#onClose();
  }

  /** New items (FA-01) or a change of dimensions (FA-05). */
  refresh(): void {
    this.#screen?.invalidate();
  }

  resized(): void {
    // FA-05, CA-06: the current item stays in view once the lines are computed again for the new width.
    const current = this.#rows[this.#state.top]?.item;
    this.#cache.clear();
    this.#build(this.#width());
    if (current !== undefined) this.#state.top = Math.max(0, this.#rows.findIndex((r) => r.item === current));
    this.#screen?.flush();
  }

  #width(): number {
    return Math.max(10, (this.#term.columns || 80) + this.#state.scrollX);
  }

  #isFolded(item: TranscriptItem, lines: number): boolean {
    const override = this.#state.folded.get(item.id);
    if (override !== undefined) return override;
    if (this.#settings.defaultDetail === "full") return false;
    if (this.#settings.defaultDetail === "summary") return item.body !== "";
    return lines > this.#settings.collapseThreshold;
  }

  /** The lines of an item: a head with author, kind and time, then its content or the summary of its folded content. */
  #itemLines(item: TranscriptItem, index: number, width: number): Cell[][] {
    const contentLines = item.body === "" ? 0 : item.body.split("\n").length;
    const folded = this.#isFolded(item, contentLines);
    const key = `${item.id}|${width}|${folded}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;
    const head: Span[] = [
      { text: `${folded && contentLines > 0 ? "▸" : contentLines > 0 ? "▾" : "·"} `, style: { dim: true } },
      { text: `[${item.turn}] `, style: { dim: true } },
      { text: AUTHOR[item.kind], style: { bold: true } },
      { text: item.title ? ` — ${item.title}` : "" },
      { text: `  ${time(item.at)}`, style: { dim: true } },
    ];
    const lines = layoutNode(text(head), width, this.#ctx).lines;
    if (contentLines > 0) {
      if (folded) lines.push(...layoutNode(text([{ text: `    … ${contentLines} ligne${contentLines > 1 ? "s" : ""} repliée${contentLines > 1 ? "s" : ""} (Entrée pour déplier)`, style: { dim: true, italic: true } }]), width, this.#ctx).lines);
      else {
        const body = item.kind === "model" && this.#markdown ? this.#markdown(item.body) : text(item.body, { overflow: item.kind === "result" || item.kind === "shell" || item.kind === "tool" ? "clip" : "wrap" });
        const laid = layoutNode(body, Math.max(1, width - 4), this.#ctx).lines;
        for (const l of laid) lines.push([...spansToLines([{ text: "    " }])[0]!, ...l]);
      }
    }
    lines.push([]);
    void index;
    this.#cache.set(key, lines);
    return lines;
  }

  #build(width: number): void {
    const rows: Row[] = [];
    this.#items().forEach((item, i) => {
      if (item.kind === "thinking" && !this.#settings.showThinking) return;
      for (const cells of this.#itemLines(item, i, width)) rows.push({ cells, item: i });
    });
    this.#rows = rows;
  }

  /** Occurrences of the search term, in every item, folded or not (EF-04). */
  #matches(): number[] {
    const term = this.#search?.term.toLowerCase() ?? "";
    if (term === "") return [];
    return this.#items()
      .map((it, i) => ((`${it.title}\n${it.body}`.toLowerCase().includes(term) ? i : -1)))
      .filter((i) => i >= 0);
  }

  #highlight(cells: readonly Cell[]): Cell[] {
    const term = this.#search?.term.toLowerCase();
    if (!term) return cells.slice();
    const out = cells.slice();
    const chars: Array<{ ch: string; cell: number }> = [];
    cells.forEach((c, k) => {
      for (const ch of c.ch) chars.push({ ch, cell: k });
    });
    const s = chars.map((c) => c.ch).join("").toLowerCase();
    for (let at = s.indexOf(term); at !== -1; at = s.indexOf(term, at + term.length)) {
      for (let k = at; k < at + term.length; k++) {
        const ci = chars[k]!.cell;
        const c = out[ci]!;
        out[ci] = { ...c, style: { ...(c.style ?? {}), inverse: true }, key: `${c.key}/hl` };
      }
    }
    return out;
  }

  #frame(size: { columns: number; rows: number }): Cell[][] {
    const width = this.#width();
    this.#build(width);
    const items = this.#items();
    // ERR-02: below three lines, no room for the bands and a content.
    if (size.rows < 3) return [spansToLines([{ text: "Fenêtre trop petite pour cette vue." }])[0]!];
    const bodyHeight = size.rows - 2 - (this.#search || this.#jump !== undefined ? 1 : 0);
    const maxTop = Math.max(0, this.#rows.length - bodyHeight);
    if (this.#state.atBottom) this.#state.top = maxTop;
    this.#state.top = Math.max(0, Math.min(this.#state.top, maxTop));
    // At the bottom, the current item is the last one; otherwise the one at the top of the view.
    const current = this.#state.atBottom && items.length > 0 ? (this.#rows[this.#rows.length - 1]?.item ?? 0) : (this.#rows[this.#state.top]?.item ?? 0);
    const header: Span[] = [
      { text: ` ${this.#title}`, style: { bold: true, inverse: true } },
      { text: ` · élément ${items.length === 0 ? 0 : current + 1}/${items.length} · tour ${items[current]?.turn ?? 0}${this.#state.scrollX > 0 ? ` · décalage ${this.#state.scrollX}` : ""} `, style: { inverse: true } },
    ];
    const lines: Cell[][] = [this.#line(header, size.columns, true)];
    if (items.length === 0) lines.push(spansToLines([{ text: "Aucun échange à afficher." }])[0]!); // ERR-03
    for (const r of this.#rows.slice(this.#state.top, this.#state.top + bodyHeight)) {
      const shifted = this.#highlight(r.cells).slice(this.#state.scrollX);
      lines.push(shifted.slice(0, size.columns));
    }
    while (lines.length < size.rows - 1 - (this.#search || this.#jump !== undefined ? 1 : 0)) lines.push([]);
    if (this.#search) {
      const n = this.#matches().length;
      lines.push(this.#line([{ text: " Recherche : ", style: { bold: true } }, { text: this.#search.term }, { text: `  ${n > 0 ? this.#search.index + 1 : 0}/${n} élément${n > 1 ? "s" : ""}`, style: { dim: true } }], size.columns));
    } else if (this.#jump !== undefined) lines.push(this.#line([{ text: " Aller au tour : ", style: { bold: true } }, { text: this.#jump }], size.columns));
    // EF-07: the keys of the navigation, always shown.
    lines.push(this.#line([{ text: " ↑↓ ligne · PgPréc/PgSuiv page · Début/Fin · Tab élément · Entrée replier · e/c tout · / chercher · n/N · : tour · ←→ défiler · Échap fermer ", style: { inverse: true } }], size.columns, true));
    return lines;
  }

  #line(spans: Span[], width: number, fill = false): Cell[] {
    const cells = spansToLines(spans)[0]!.slice(0, width);
    if (fill) while (cells.length < width) cells.push(blank(spans[spans.length - 1]?.style));
    return cells;
  }

  #moveTo(top: number): void {
    const bodyHeight = (this.#term.rows || 24) - 2;
    const maxTop = Math.max(0, this.#rows.length - bodyHeight);
    this.#state.top = Math.max(0, Math.min(top, maxTop));
    this.#state.atBottom = this.#state.top >= maxTop;
  }

  #toItem(index: number): void {
    const at = this.#rows.findIndex((r) => r.item === index);
    if (at !== -1) this.#moveTo(at);
  }

  /** § 5.5: the search goes to an occurrence and unfolds its item (EF-04, CA-02). */
  #goToMatch(step: number): void {
    const matches = this.#matches();
    if (matches.length === 0 || !this.#search) return;
    this.#search.index = (this.#search.index + step + matches.length) % matches.length;
    const item = this.#items()[matches[this.#search.index]!]!;
    this.#state.folded.set(item.id, false);
    this.#build(this.#width());
    this.#toItem(matches[this.#search.index]!);
  }

  key(e: InputEvent): void {
    if (!this.#screen) return;
    if (e.kind === "paste") return; // RG-01: read-only
    const page = Math.max(1, (this.#term.rows || 24) - 3);
    const current = this.#rows[this.#state.top]?.item ?? 0;
    const items = this.#items();
    if (this.#search?.editing) {
      if (e.name === "escape") this.#search = undefined;
      else if (e.name === "enter") this.#search.editing = false;
      else if (e.name === "backspace") this.#search.term = this.#search.term.slice(0, -1);
      else if (e.text !== undefined && !e.ctrl && !e.alt) {
        this.#search.term += e.text;
        this.#search.index = -1;
        this.#goToMatch(1);
      }
      this.#screen.flush();
      return;
    }
    if (this.#jump !== undefined) {
      if (e.name === "enter") {
        const turn = Number(this.#jump);
        const index = items.findIndex((it) => it.turn === turn);
        if (index !== -1) this.#toItem(index);
        this.#jump = undefined;
      } else if (e.name === "escape") this.#jump = undefined;
      else if (e.name === "backspace") this.#jump = this.#jump.slice(0, -1);
      else if (e.text && /^\d$/.test(e.text)) this.#jump += e.text;
      this.#screen.flush();
      return;
    }
    switch (e.text !== undefined && !e.ctrl && !e.alt ? e.text : e.name) {
      case "escape":
      case "q":
        if (this.#search) this.#search = undefined;
        else return this.close();
        break;
      case "c":
        if (e.ctrl) return this.close();
        for (const it of items) this.#state.folded.set(it.id, true);
        break;
      case "up":
      case "k":
        this.#moveTo(this.#state.top - 1);
        break;
      case "down":
      case "j":
        this.#moveTo(this.#state.top + 1);
        break;
      case "pageup":
        this.#moveTo(this.#state.top - page);
        break;
      case "pagedown":
      case " ":
        this.#moveTo(this.#state.top + page);
        break;
      case "home":
      case "g":
        this.#moveTo(0);
        break;
      case "end":
      case "G":
        this.#moveTo(Number.MAX_SAFE_INTEGER);
        break;
      case "tab":
        if (e.shift) this.#toItem(Math.max(0, current - 1));
        else this.#toItem(Math.min(items.length - 1, current + 1));
        break;
      case "enter": {
        const it = items[current];
        if (it) {
          const lines = it.body === "" ? 0 : it.body.split("\n").length;
          this.#state.folded.set(it.id, !this.#isFolded(it, lines));
          this.#build(this.#width());
          this.#toItem(current);
        }
        break;
      }
      case "e":
        for (const it of items) this.#state.folded.set(it.id, false);
        break;
      case "left":
        this.#state.scrollX = Math.max(0, this.#state.scrollX - 8);
        break;
      case "right":
        this.#state.scrollX += 8;
        break;
      case "/":
        this.#search = { term: "", editing: true, index: -1 };
        break;
      case "n":
        this.#goToMatch(1);
        break;
      case "N":
        this.#goToMatch(-1);
        break;
      case ":":
        this.#jump = "";
        break;
      default:
        return; // FA-04 of SPEC-IHM-014: a key without action in this context is ignored
    }
    this.#screen?.flush();
  }
}
