// Implements: SPEC-IHM-008 (§ 5.2 browsing, § 5.3 incremental reverse search, § 10 position and search band, FA-01, FA-02, FA-03, EF-02 to EF-04, EF-07, ERR-03, RG-02, CA-01 to CA-03, CA-05),
//             SPEC-IHM-009 (§ 5.3 presentation, § 5.4 insertion, FA-01, FA-02, FA-04, EF-01, EF-04, EF-05, EF-09, RG-02, CA-04, CA-05, CA-07), SPEC-IHM-007 (EF-04, CA-03)
// Help for the input area: browsing and searching the history of the inputs, and the list of completion. Nothing here
// ever sends a message: a recalled entry or an inserted proposal waits in the input area.

import type { Editor } from "../ui/editor";
import { box, text, type Node } from "../ui/layout";
import type { Span } from "../ui/text";
import { detectTrigger, rankCandidates, type Candidate, type FileIndex, type Trigger, type UsageStats } from "./completion";
import type { InputHistory } from "./history";
import type { KeyContext } from "./keymap";

export interface AssistOptions {
  readonly editor: Editor;
  readonly history?: InputHistory;
  /** Global history: the folder of origin is shown (§ 10 of SPEC-IHM-008). */
  readonly showFolder?: boolean;
  readonly completion?: {
    readonly maxVisible: number;
    readonly fuzzy: boolean;
    readonly commands: () => readonly Candidate[];
    readonly files: () => FileIndex;
  };
  readonly maxChars: number;
  readonly usage?: Map<string, UsageStats>;
  readonly notice: (message: string) => void;
  readonly now?: () => number;
}

interface ListState {
  readonly trigger: Trigger;
  readonly items: readonly Candidate[];
  selected: number;
  readonly partial: boolean;
}

interface SearchState {
  term: string;
  index: number;
  readonly draft: string;
  readonly caret: number;
}

export class InputAssist {
  readonly #o: AssistOptions;
  /** History browsing: position (-1 = the draft) and the draft kept aside (EF-02). */
  #browse: { index: number; readonly draft: string } | undefined;
  #search: SearchState | undefined;
  #list: ListState | undefined;
  /** The list was closed by the user for this text and this caret (FA-04): it stays closed until they change. */
  #dismissed: string | undefined;

  constructor(o: AssistOptions) {
    this.#o = o;
  }

  get #ed(): Editor {
    return this.#o.editor;
  }

  /** Contexts to consult before the input area (§ 5.1 of SPEC-IHM-014). */
  contexts(): KeyContext[] {
    if (this.#search) return ["search"];
    if (this.#list) return ["list"];
    return [];
  }

  get searching(): boolean {
    return this.#search !== undefined;
  }

  // ---- History (SPEC-IHM-008) --------------------------------------------------------------------------------------

  /** A message validated: recorded (§ 5.1), the browsing ends. */
  submitted(content: string): void {
    this.#o.history?.add(content);
    this.#browse = undefined;
    this.#list = undefined;
  }

  /** The text changed by an edit: the browsing ends (the edited entry becomes the draft), the completion follows. */
  edited(): void {
    this.#browse = undefined;
    this.refreshList();
  }

  /** § 5.2: older entry; from a non-empty input only on its first line (EF-03). False when nothing happened. */
  older(): boolean {
    const entries = this.#o.history?.entries() ?? [];
    if (entries.length === 0) return false; // FA-01
    const index = (this.#browse?.index ?? -1) + 1;
    if (index >= entries.length) return true;
    this.#browse = { index, draft: this.#browse?.draft ?? this.#ed.text };
    this.#recall(entries[index]!.text);
    return true;
  }

  /** Newer entry, then the draft again (EF-02, CA-02). */
  newer(): boolean {
    if (!this.#browse) return false;
    const index = this.#browse.index - 1;
    if (index < 0) {
      const draft = this.#browse.draft;
      this.#browse = undefined;
      this.#ed.set(draft);
      return true;
    }
    this.#browse.index = index;
    this.#recall((this.#o.history?.entries() ?? [])[index]!.text);
    return true;
  }

  /** FA-02, FA-03: an entry comes back whole, line breaks included, within the maximal size of the input. */
  #recall(entry: string): void {
    let value = entry;
    if (value.length > this.#o.maxChars) {
      value = value.slice(0, this.#o.maxChars);
      this.#o.notice("Entrée tronquée."); // ERR-03
    }
    this.#ed.set(value);
    this.#list = undefined;
  }

  /** § 10: position in the history while browsing. */
  position(): string | undefined {
    if (!this.#browse) return undefined;
    const entries = this.#o.history?.entries() ?? [];
    const e = entries[this.#browse.index];
    return `Historique ${this.#browse.index + 1}/${entries.length}${this.#o.showFolder && e ? ` · ${e.dir}` : ""}`;
  }

  // ---- Reverse search (§ 5.3) ---------------------------------------------------------------------------------------

  startSearch(): void {
    if (!this.#o.history) return;
    this.#list = undefined;
    this.#search = { term: "", index: 0, draft: this.#ed.text, caret: this.#ed.caret };
  }

  #matches(): string[] {
    const term = this.#search?.term.toLowerCase() ?? "";
    return (this.#o.history?.entries() ?? []).map((e) => e.text).filter((t) => term === "" || t.toLowerCase().includes(term));
  }

  /** Keys of the search band: the term is edited, the matches are walked, the choice is put in the input (EF-07). */
  searchKey(action: string | undefined, typed: string | undefined, backspace: boolean): void {
    const s = this.#search!;
    const count = this.#matches().length;
    if (action === "search.cancel") {
      this.#ed.set(s.draft, s.caret);
      this.#search = undefined;
    } else if (action === "search.accept") {
      const match = this.#matches()[s.index];
      this.#search = undefined;
      if (match !== undefined) this.#recall(match);
    } else if (action === "search.next") s.index = Math.min(s.index + 1, Math.max(0, count - 1));
    else if (action === "search.previous") s.index = Math.max(0, s.index - 1);
    else if (backspace) {
      s.term = s.term.slice(0, -1);
      s.index = 0;
    } else if (typed !== undefined) {
      s.term += typed;
      s.index = 0;
    }
  }

  // ---- Completion (SPEC-IHM-009) ------------------------------------------------------------------------------------

  /** The list for the trigger under the caret; closed when nothing matches (FA-01). */
  refreshList(): void {
    const c = this.#o.completion;
    if (!c) return;
    const key = `${this.#ed.text}\u0000${this.#ed.caret}`;
    if (this.#dismissed !== undefined && this.#dismissed !== key) this.#dismissed = undefined;
    if (this.#dismissed !== undefined) return;
    const trigger = detectTrigger(this.#ed.text, this.#ed.caret);
    if (!trigger) {
      this.#list = undefined;
      return;
    }
    let candidates: readonly Candidate[];
    let partial = false;
    try {
      if (trigger.trigger === "/") candidates = c.commands();
      else {
        const index = c.files();
        candidates = index.entries;
        partial = index.partial;
      }
    } catch {
      candidates = []; // ERR-01: a failing source is ignored
    }
    // What is already typed whole (a folder just inserted) is not proposed again.
    const items = rankCandidates(trigger.term, candidates, { fuzzy: c.fuzzy, usage: this.#o.usage ?? new Map() }).filter((i) => i.value !== trigger.term || i.kind !== "directory");
    // Nothing to complete: no match, or the only one is what is already typed.
    if (items.length === 0 || (items.length === 1 && items[0]!.value === trigger.term)) {
      this.#list = undefined;
      return;
    }
    const previous = this.#list?.items[this.#list.selected]?.value;
    const selected = Math.max(0, items.findIndex((i) => i.value === previous));
    this.#list = { trigger, items, selected, partial };
  }

  /** The selected proposal is exactly what is typed: inserting would change nothing. */
  selectedIsTyped(): boolean {
    const l = this.#list;
    return l !== undefined && l.items[l.selected]?.value === l.trigger.term;
  }

  close(): void {
    this.#list = undefined;
  }

  listKey(action: string | undefined): void {
    const l = this.#list!;
    if (action === "list.next") l.selected = (l.selected + 1) % l.items.length;
    else if (action === "list.previous") l.selected = (l.selected + l.items.length - 1) % l.items.length;
    else if (action === "list.close") {
      // FA-04, EF-05, CA-07: closed, the partial term kept as it is.
      this.#list = undefined;
      this.#dismissed = `${this.#ed.text}\u0000${this.#ed.caret}`;
    } else if (action === "list.accept") this.#insert(l.items[l.selected]!);
  }

  /**
   * § 5.4, EF-01, EF-09, CA-04, CA-05: the proposal replaces the partial term; nothing is sent. A folder keeps the list
   * open on its content; the insertion is one edit, undone at once (RG-02).
   */
  #insert(c: Candidate): void {
    const l = this.#list!;
    const t = this.#ed.text;
    const caret = this.#ed.caret;
    const tail = c.kind === "directory" ? "" : " ";
    const inserted = `${l.trigger.trigger}${c.value}${tail}`;
    const after = t.slice(caret).replace(/^\S*/, "");
    const next = t.slice(0, l.trigger.start) + inserted + (tail && after.startsWith(" ") ? after.slice(1) : after);
    this.#ed.set(next, l.trigger.start + inserted.length);
    const usage = this.#o.usage?.get(c.value);
    this.#o.usage?.set(c.value, { count: (usage?.count ?? 0) + 1, last: (this.#o.now ?? Date.now)() });
    this.#list = undefined;
    if (c.kind === "directory") this.refreshList();
  }

  // ---- Panels --------------------------------------------------------------------------------------------------------

  panels(): Node[] {
    if (this.#search) {
      const matches = this.#matches();
      const s = this.#search;
      const match = matches[s.index];
      const line: Span[] = [
        { text: "Recherche dans l'historique : ", style: { dim: true } },
        { text: s.term, style: { bold: true } },
        { text: match !== undefined ? `  →  ${match.split("\n")[0]}` : "  (aucune correspondance)", style: match ? undefined : { dim: true } },
        { text: `  ${matches.length > 0 ? s.index + 1 : 0}/${matches.length}`, style: { dim: true } },
      ];
      return [box([text(line, { overflow: "clip" })], { padding: { left: 1 } })];
    }
    const l = this.#list;
    if (!l) return [];
    const max = Math.max(1, this.#o.completion?.maxVisible ?? 10);
    const start = Math.max(0, Math.min(l.selected - Math.floor(max / 2), l.items.length - max));
    const rows: Node[] = l.items.slice(start, start + max).map((c, i) => {
      const selected = start + i === l.selected;
      return text(
        [
          { text: selected ? "❯ " : "  ", style: { bold: true } },
          { text: `${l.trigger.trigger}${c.value}`, style: selected ? { bold: true, inverse: true } : { bold: true } },
          ...(c.description ? [{ text: `  ${c.description}`, style: { dim: true } }] : []),
          ...(c.source ? [{ text: `  (${c.source})`, style: { dim: true } }] : []),
        ],
        { overflow: "clip" },
      );
    });
    const footer: Span[] = [{ text: `${l.selected + 1} sur ${l.items.length} · Tab ou Entrée : insérer · Échap : fermer`, style: { dim: true } }];
    if (l.partial) footer.push({ text: " · Résultats partiels.", style: { bold: true } }); // ERR-02, CA-06
    rows.push(text(footer, { overflow: "clip" }));
    return [box(rows, { padding: { left: 1 } })];
  }
}
