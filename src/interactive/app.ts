// Implements: SPEC-MOD-001 (§ 5.2 steps 2 to 7, § 5.4 states, FA-01, FA-02, FA-04, EF-02, EF-03, EF-05, EF-06, ERR-03, CA-01, CA-02, CA-03), SPEC-IHM-007 (§ 5.4, § 5.5, § 5.6, FA-01, FA-02, FA-05, EF-04 to EF-07, CA-01, CA-03, CA-06, CA-07, CA-12), SPEC-IHM-011 (§ 5.1 to § 5.5, EF-01 to EF-05, EF-07, ERR-01, ERR-02, CA-01 to CA-06), SPEC-IHM-027 (§ 5.1, § 5.3, FA-01, EF-01 to EF-04, RG-01, CA-01, CA-02)
// The interactive application: input area, conversation flow, temporary panels, status line. It turns keys into actions,
// keeps the draft, the queue of messages and the stashed drafts, shows the permission dialog in a fixed zone, and hands
// the messages to the session one at a time.

import type { Terminal } from "../platform/terminal";
import type { ApprovalRequest, HumanAnswer, HumanApprovalChannel } from "../permissions/resolver";
import type { EngineEvent } from "../engine/events";
import type { Capabilities } from "../ui/capabilities";
import { Editor } from "../ui/editor";
import { composeFrame } from "../ui/frame";
import { KeyParser, type InputEvent, type KeyEvent } from "../ui/keys";
import { box, layoutNode, text, type LayoutContext, type Node } from "../ui/layout";
import type { Scheduler } from "../ui/screen";
import { tone, type Tone } from "../ui/style";
import { openTerminalSession, type TerminalSession } from "../ui/terminal-session";
import { spansToLines, type Cell, type Span } from "../ui/text";
import { recognize } from "../commands/recognize";
import { comboLabel, Keymap, type KeyContext } from "./keymap";
import { literalTriggers } from "./triggers";
import { InputAssist, type AssistOptions } from "./assist";
import type { UsageStats } from "./completion";
import type { InputHistory } from "./history";
import { MarkdownRenderer, type MarkdownOptions } from "../ui/markdown";
import { diffNode, type DiffOptions } from "../ui/diff-view";
import { activityView, interruptionView, modelView, noticeView, toolCallView, toolResultView, userView, type ViewContext } from "./views";

export interface AppSettings {
  readonly maxFramesPerSecond: number;
  readonly minColumns: number;
  readonly retainedLines: number;
  readonly inputMinHeight: number;
  readonly inputMaxHeight: number;
  readonly inputMaxChars: number;
  readonly inputWarnChars: number;
  readonly queueMax: number;
  readonly queueAutoSend: boolean;
  readonly draftsMax: number;
  readonly exitConfirmation: boolean;
  readonly exitDoublePressMs: number;
  /** Delay during which a key cannot decide a dialog that has just appeared (RG-01 of SPEC-IHM-027). */
  readonly dialogGuardMs: number;
}

/** Draft, queue and stashed drafts, kept with the session (SPEC-IHM-007 EF-04, SPEC-IHM-011 EF-06). */
export interface InputState {
  readonly draft: string;
  readonly queue: readonly string[];
  readonly stash: readonly string[];
}

export type Entry = { readonly kind: "message"; readonly text: string } | { readonly kind: "exit" };

interface Choice {
  readonly label: string;
  readonly answer: () => HumanAnswer | "explain";
}

interface PendingApproval {
  readonly request: ApprovalRequest;
  readonly resolve: (a: HumanAnswer) => void;
  shownAt: number;
  selected: number;
  scope: number;
  explaining?: Editor;
}

interface Confirm {
  readonly message: string;
  readonly yes: string;
  readonly no: string;
  readonly resolve: (yes: boolean) => void;
  readonly shownAt: number;
}

const RULE_SCOPES = ["session", "local", "project", "user"] as const;
/** SPEC-CMD-023: the exit command, effective even during a turn. */
export const EXIT_COMMAND = /^\s*\/(exit|quit)\s*$/;
const SCOPE_LABEL: Readonly<Record<(typeof RULE_SCOPES)[number], string>> = { session: "session", local: "projet (local)", project: "projet (partagé)", user: "utilisateur" };

export interface AppOptions {
  readonly terminal: Terminal;
  readonly capabilities: Capabilities;
  readonly settings: AppSettings;
  /** Mode, model and other facts of the status line. */
  readonly status: () => { readonly mode: string; readonly model: string };
  readonly cycleMode?: () => void;
  /** Summary of a tool call for the flow. */
  readonly describeCall: (name: string, input: unknown) => string;
  readonly restored?: InputState;
  readonly onInputState?: (state: InputState) => void;
  /** Effective key bindings (SPEC-IHM-014 § 5.4); the defaults otherwise. */
  readonly keymap?: Keymap;
  /** `ui.keybindings.showFooterHints`. */
  readonly showFooterHints?: boolean;
  /** History of the inputs (SPEC-IHM-008); `historyGlobal` shows the folder of origin of the entries. */
  readonly history?: InputHistory;
  readonly historyGlobal?: boolean;
  /** Sources of the completion (SPEC-IHM-009); absent when it is disabled. */
  readonly completion?: AssistOptions["completion"];
  readonly usage?: Map<string, UsageStats>;
  /** Rich text of the answers (SPEC-IHM-003, SPEC-IHM-004) and differences of the changes (SPEC-IHM-005). */
  readonly render?: { readonly markdown: MarkdownOptions; readonly diff: DiffOptions };
  readonly clock?: () => number;
  readonly scheduler?: Scheduler;
}

export class InteractiveApp {
  readonly #o: AppOptions;
  readonly #view: ViewContext;
  readonly #keys = new KeyParser();
  #keymap: Keymap;
  readonly #editor: Editor;
  readonly #assist: InputAssist;
  readonly #queue: string[];
  readonly #stash: string[];
  readonly #approvals: PendingApproval[] = [];
  #confirm: Confirm | undefined;
  #session: TerminalSession | undefined;
  #unsubscribeInput: (() => void) | undefined;
  #waiting: ((e: Entry) => void) | undefined;
  #turn: AbortController | undefined;
  #turnStarted = 0;
  #activity = "Réflexion…";
  #spinner = 0;
  #animation: ReturnType<typeof setInterval> | undefined;
  #stream = "";
  /** Renderer of the response being produced: its finished blocks are not parsed again (ENF-02 of SPEC-IHM-003). */
  #streamRenderer: MarkdownRenderer | undefined;
  /** The text of the current response was committed before its end (by a call of a tool). */
  #responseCommitted = false;
  #exitArmed: { combo: string; until: number } | undefined;
  #hint: string | undefined;
  #exiting = false;
  #narrowWarned = false;
  readonly #callNames = new Map<string, string>();

  constructor(o: AppOptions) {
    this.#o = o;
    const render = o.render;
    this.#view = { unicode: o.capabilities.unicode, ...(render ? { markdown: (c: string) => new MarkdownRenderer(render.markdown, o.capabilities.unicode).render(c) } : {}) };
    this.#editor = new Editor(o.settings.inputMaxChars);
    this.#keymap = o.keymap ?? new Keymap();
    this.#queue = [...(o.restored?.queue ?? [])];
    this.#stash = [...(o.restored?.stash ?? [])];
    if (o.restored?.draft) this.#editor.set(o.restored.draft);
    this.#assist = new InputAssist({
      editor: this.#editor,
      history: o.history,
      showFolder: o.historyGlobal,
      completion: o.completion,
      maxChars: o.settings.inputMaxChars,
      usage: o.usage,
      notice: (m) => this.notice("warning", m),
      now: () => this.#now,
    });
  }

  get #now(): number {
    return (this.#o.clock ?? Date.now)();
  }

  /** New key bindings, applied at once (FA-03 of SPEC-IHM-014). */
  setKeymap(keymap: Keymap): void {
    this.#keymap = keymap;
    this.#redraw();
  }

  get viewContext(): ViewContext {
    return this.#view;
  }

  get running(): boolean {
    return this.#turn !== undefined;
  }

  get queue(): readonly string[] {
    return this.#queue;
  }

  get draft(): string {
    return this.#editor.text;
  }

  /** Takes over the terminal and draws the input area (step 2 of § 5.2). */
  start(): void {
    this.#session = openTerminalSession(this.#o.terminal, {
      capabilities: this.#o.capabilities,
      maxFramesPerSecond: this.#o.settings.maxFramesPerSecond,
      source: (size) => this.#frame(size),
      scheduler: this.#o.scheduler,
    });
    this.#unsubscribeInput = this.#o.terminal.onInput((data) => this.#input(data));
    this.#session.screen.flush();
  }

  /** Restores the terminal; idempotent. */
  stop(): void {
    this.#stopAnimation();
    this.#unsubscribeInput?.();
    this.#unsubscribeInput = undefined;
    this.#session?.close();
    for (const a of this.#approvals.splice(0)) a.resolve({ answer: "no_stop" });
    this.#confirm?.resolve(false);
    this.#confirm = undefined;
  }

  /** Next entry of the user: a message, or the exit (step 3 of § 5.2). */
  nextEntry(): Promise<Entry> {
    if (this.#exiting) return Promise.resolve({ kind: "exit" });
    return new Promise((resolve) => {
      this.#waiting = resolve;
      this.#redraw();
    });
  }

  /** Next message of the queue, removed from it (SPEC-IHM-011 § 5.2: one per turn, in order). */
  takeQueued(): string | undefined {
    const next = this.#queue.shift();
    if (next !== undefined) this.#saveState();
    return next;
  }

  // ---- Turn ----------------------------------------------------------------------------------------------------

  /** A turn starts: the input area stays usable (EF-07 of SPEC-IHM-007); an interruption aborts `controller`. */
  beginTurn(controller: AbortController): void {
    this.#turn = controller;
    this.#turnStarted = this.#now;
    this.#activity = "Réflexion…";
    this.#stream = "";
    this.#responseCommitted = false;
    this.#animation = setInterval(() => {
      this.#spinner++;
      this.#redraw();
    }, 120);
    this.#redraw();
  }

  /** The turn is over: what remains of the response is committed; the interruption leaves its marker (FA-01). */
  endTurn(outcome: { readonly stopCause: string; readonly message?: string }): void {
    this.#stopAnimation();
    this.#flushStream();
    this.#turn = undefined;
    if (outcome.stopCause === "interrupted") this.commit(interruptionView(this.#view));
    else if (outcome.stopCause === "error") this.notice("error", `Le tour a échoué : ${outcome.message ?? "erreur inconnue"}.`); // ERR-03
    else if (outcome.stopCause !== "completed" && outcome.message) this.notice("warning", outcome.message);
    this.#redraw();
  }

  /** Engine events of the turn, displayed as they arrive (ENF-01: the first character as soon as it is received). */
  onEngineEvent(e: EngineEvent): void {
    switch (e.type) {
      case "user_message": {
        if (e.synthetic) break;
        const content = e.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n");
        if (content) this.commit(userView(content, this.#view));
        break;
      }
      case "text_delta":
        this.#stream += e.text;
        this.#activity = "Rédaction…";
        this.#redraw();
        break;
      case "thinking_delta":
        this.#activity = "Réflexion…";
        this.#redraw();
        break;
      case "response_restarted":
        this.#stream = "";
        this.#streamRenderer = undefined;
        this.#redraw();
        break;
      case "assistant_message":
        this.#flushStream(e.text);
        break;
      case "tool_call":
        this.#flushStream();
        this.#callNames.set(e.callId, e.name);
        this.#activity = `${e.name}…`;
        this.commit(toolCallView(e.name, this.#o.describeCall(e.name, e.input), this.#view));
        break;
      case "tool_result":
        this.commit(toolResultView(e.output, e.isError, this.#view));
        this.#activity = "Réflexion…";
        break;
      case "retry":
        this.#activity = `Service indisponible, nouvel essai dans ${Math.max(1, Math.round(e.delayMs / 1000))} s…`;
        this.#redraw();
        break;
      case "compacted":
        this.notice("info", `Contexte compacté : ${e.tokensBefore} → ${e.tokensAfter} jetons.`);
        break;
      case "warning":
        this.notice("warning", e.message);
        break;
      default:
        break;
    }
  }

  /**
   * Commits the text of the response being produced. A call of a tool commits it before its own line; the complete
   * response that follows then adds nothing.
   */
  #flushStream(final?: string): void {
    if (final !== undefined && this.#responseCommitted) {
      this.#responseCommitted = false;
      this.#stream = "";
      return;
    }
    const content = (final ?? this.#stream).trim();
    this.#stream = "";
    this.#streamRenderer = undefined;
    if (!content) return;
    this.commit(modelView(content, this.#view));
    if (final === undefined) this.#responseCommitted = true;
  }

  // ---- Output ----------------------------------------------------------------------------------------------------

  #ctx(columns: number): LayoutContext {
    return { unicode: this.#view.unicode, narrow: columns < this.#o.settings.minColumns };
  }

  /** Writes a finished item above the live area, once. */
  commit(node: Node): void {
    if (!this.#session) return;
    const columns = this.#o.terminal.columns > 0 ? this.#o.terminal.columns : 80;
    this.#session.screen.commit(layoutNode(node, columns, this.#ctx(columns)).lines);
  }

  notice(t: Tone, message: string): void {
    this.commit(noticeView(t, message, this.#view));
  }

  /** Lines of the product written before the interface (start-up warnings), or by the session. */
  writeLine(line: string): void {
    const warning = /^avertissement/i.test(line);
    this.notice(warning ? "warning" : "system", line.replace(/\n+$/, ""));
  }

  #redraw(): void {
    this.#session?.screen.invalidate();
  }

  #stopAnimation(): void {
    if (this.#animation) clearInterval(this.#animation);
    this.#animation = undefined;
  }

  // ---- Permission dialog (SPEC-IHM-027) ----------------------------------------------------------------------------

  /** The human authority of SPEC-PER-001 § 5.3: one dialog at a time, the others waiting with a counter (FA-01). */
  readonly approvals: HumanApprovalChannel = {
    request: (request, signal) =>
      new Promise<HumanAnswer>((resolve) => {
        const pending: PendingApproval = {
          request,
          resolve: (a) => {
            const i = this.#approvals.indexOf(pending);
            if (i !== -1) this.#approvals.splice(i, 1);
            if (this.#approvals[0]) this.#approvals[0].shownAt = this.#now;
            resolve(a);
            this.#redraw();
          },
          shownAt: this.#now,
          selected: 0,
          scope: 0,
        };
        // CA-02: the default choice of a dangerous command is « Non ».
        pending.selected = request.danger ? this.#choices(pending).findIndex((c) => c.label === "Non") : 0;
        signal.addEventListener("abort", () => pending.resolve({ answer: "no_stop" }), { once: true });
        this.#approvals.push(pending);
        this.#session?.screen.flush();
      }),
  };

  #choices(p: PendingApproval): Choice[] {
    const rule = p.request.suggestions[0];
    const scope = RULE_SCOPES[p.scope]!;
    return [
      { label: "Oui", answer: () => ({ answer: "yes" }) },
      ...(rule ? [{ label: `Oui, et ne plus demander pour ${rule} (portée : ${SCOPE_LABEL[scope]} ; Tab pour changer)`, answer: (): HumanAnswer => ({ answer: "yes_always", scope, rule }) }] : []),
      { label: "Non", answer: () => ({ answer: "no" }) },
      { label: "Non, et dire quoi faire autrement", answer: () => "explain" },
      { label: "Non, et arrêter le tour", answer: () => ({ answer: "no_stop" }) },
    ];
  }

  #dialogView(p: PendingApproval): Node {
    const r = p.request;
    const danger = r.danger !== undefined;
    const t = tone(danger ? "error" : "warning", this.#view.unicode);
    const count = this.#approvals.length > 1 ? ` (1/${this.#approvals.length})` : "";
    const rows: Node[] = [text([{ text: r.toolName, style: { bold: true } }, { text: ` : ${r.summary}` }])];
    if (r.requester) rows.push(text([{ text: `Demandé par : ${r.requester}`, style: { dim: true } }])); // EF-04
    if (r.change && this.#o.render) {
      // SPEC-IHM-005 EF-01: the change presented as a difference before the decision.
      rows.push(diffNode(r.change, { ...this.#o.render.diff, maxDisplayedLines: Math.min(this.#o.render.diff.maxDisplayedLines, 40) }));
    } else if (r.preview) {
      // EF-01: exactly what will be written; a long preview is cut with the number of hidden lines.
      const lines = r.preview.replace(/\n$/, "").split("\n");
      const shown = lines.slice(0, 20);
      rows.push(text(shown.join("\n")));
      if (lines.length > shown.length) rows.push(text([{ text: `… ${lines.length - shown.length} lignes de plus`, style: { dim: true } }]));
    }
    if (danger) rows.push(text([{ text: `${t.symbol} Action dangereuse : ${r.danger}`, style: t.style }]));
    rows.push(text([{ text: r.reason, style: { dim: true } }]));
    this.#choices(p).forEach((c, i) => {
      const selected = i === p.selected;
      rows.push(text([{ text: `${selected ? "❯" : " "} ${i + 1}. ${c.label}`, style: selected ? { bold: true } : undefined }]));
    });
    if (p.explaining) {
      const question = "Que faut-il faire autrement ? ";
      rows.push(text([{ text: question }, { text: p.explaining.text }], { caret: question.length + p.explaining.caretGrapheme }));
    }
    rows.push(text([{ text: "Chiffre : choisir · ↑↓ et Entrée · Échap : refuser", style: { dim: true } }]));
    return box(rows, { border: { style: t.style, title: `Autorisation requise${count}` }, padding: { left: 1, right: 1 } });
  }

  #dialogKey(p: PendingApproval, k: KeyEvent, action: string | undefined): void {
    // RG-01, CA-01: a key typed before the dialog could be read never decides.
    if (this.#now - p.shownAt < this.#o.settings.dialogGuardMs) return;
    if (p.explaining) {
      if (action === "dialog.refuse") p.explaining = undefined;
      else if (k.name === "enter" && !k.alt && !k.shift) {
        const explanation = p.explaining.text.trim();
        p.resolve(explanation ? { answer: "no_explain", explanation } : { answer: "no" });
      } else if (k.name === "backspace") p.explaining.backspace();
      else if (k.text) p.explaining.insert(k.text);
      this.#redraw();
      return;
    }
    const choices = this.#choices(p);
    const pick = (i: number) => {
      const a = choices[i]!.answer();
      if (a === "explain") p.explaining = new Editor(2_000);
      else p.resolve(a);
    };
    if (k.text && /^[1-9]$/.test(k.text) && Number(k.text) <= choices.length) pick(Number(k.text) - 1); // EF-03: one key
    else if (action === "dialog.next") p.selected = (p.selected + 1) % choices.length;
    else if (action === "dialog.previous") p.selected = (p.selected + choices.length - 1) % choices.length;
    else if (action === "dialog.scope") p.scope = (p.scope + 1) % RULE_SCOPES.length;
    else if (action === "dialog.confirm") pick(p.selected);
    else if (action === "dialog.refuse") p.resolve({ answer: "no" });
    this.#redraw();
  }

  // ---- Confirmations ----------------------------------------------------------------------------------------------

  /** A question with two answers, in a fixed panel (exit with work in progress, queue after an interruption). */
  confirm(message: string, yes = "Oui", no = "Non"): Promise<boolean> {
    if (this.#exiting) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.#confirm = {
        message,
        yes,
        no,
        shownAt: this.#now,
        resolve: (v) => {
          this.#confirm = undefined;
          resolve(v);
          this.#redraw();
        },
      };
      this.#session?.screen.flush();
    });
  }

  #confirmView(c: Confirm): Node {
    const t = tone("warning", this.#view.unicode);
    return box([text(c.message), text([{ text: `o : ${c.yes} · n : ${c.no}`, style: { bold: true } }])], { border: { style: t.style }, padding: { left: 1, right: 1 } });
  }

  // ---- Exit (FA-04, EF-05) ----------------------------------------------------------------------------------------

  /**
   * Exit asked by a key or a command: confirmed when work is in progress (EF-05, SPEC-IHM-011 CA-06). The exit command
   * takes effect at once, a turn in flight being interrupted (SPEC-CMD-023 § 5.1, FA-01); only queued messages make it ask.
   */
  async requestExit(o: { readonly byCommand?: boolean } = {}): Promise<void> {
    if (this.#exiting) return;
    const work: string[] = [];
    if (this.running && !o.byCommand) work.push("un tour est en cours");
    if (this.#queue.length > 0) work.push(`${this.#queue.length} message${this.#queue.length > 1 ? "s" : ""} en attente ne ${this.#queue.length > 1 ? "seront" : "sera"} pas envoyé${this.#queue.length > 1 ? "s" : ""}`);
    if (work.length > 0 && this.#o.settings.exitConfirmation) {
      const yes = await this.confirm(`Travail en cours : ${work.join(" ; ")}. Quitter quand même ?`, "quitter", "rester");
      if (!yes) return;
    }
    this.#exiting = true;
    this.#turn?.abort();
    this.#saveState();
    const w = this.#waiting;
    this.#waiting = undefined;
    w?.({ kind: "exit" });
  }

  /** Exit without confirmation (termination signal): the turn in flight is aborted. */
  forceExit(): void {
    this.#exiting = true;
    this.#turn?.abort();
    this.#confirm?.resolve(false);
    this.#saveState();
    const w = this.#waiting;
    this.#waiting = undefined;
    w?.({ kind: "exit" });
  }

  /** Double press: the first one arms the exit and says so, the second one within the window exits. */
  #armedExit(combo: string): void {
    const now = this.#now;
    if (this.#exitArmed && this.#exitArmed.combo === combo && now <= this.#exitArmed.until) {
      this.#exitArmed = undefined;
      this.#hint = undefined;
      void this.requestExit();
      return;
    }
    this.#exitArmed = { combo, until: now + this.#o.settings.exitDoublePressMs };
    this.#hint = `Appuyez de nouveau sur ${combo === "ctrl+c" ? "Ctrl+C" : "Ctrl+D"} pour quitter.`;
    this.#redraw();
  }

  // ---- Keys ---------------------------------------------------------------------------------------------------------

  #input(data: string): void {
    const events = this.#keys.feed(data);
    // A lone escape is a key of its own (terminals send whole sequences in one chunk).
    if (data === "\u001b") events.push(...this.#keys.flush());
    for (const e of events) this.#event(e);
  }

  #event(e: InputEvent): void {
    if (e.kind === "paste") {
      // SPEC-IHM-010 EF-01: a paste never sends anything, whatever it contains.
      const active = this.#approvals[0]?.explaining;
      if (active) active.insert(e.text.replace(/\r\n?/g, "\n"));
      else if (!this.#approvals[0] && !this.#confirm) this.#insert(e.text.replace(/\r\n?/g, "\n"));
      this.#redraw();
      return;
    }
    const approval = this.#approvals[0];
    const searching = this.#assist.searching;
    const contexts: KeyContext[] = approval || this.#confirm ? ["dialog", "app"] : searching ? ["search", "app"] : [...this.#assist.contexts(), "input", "app"];
    const action = this.#keymap.action(e, contexts);
    // Essential application actions keep priority over any edition (SPEC-IHM-013 § 5.5).
    if (action === "app.interrupt" || (action === "app.cancel" && this.running && !approval && !this.#confirm)) {
      if (approval || this.#confirm) {
        if (approval) approval.resolve({ answer: "no_stop" });
        else this.#confirm!.resolve(false);
        return;
      }
      this.#interrupt(action === "app.interrupt");
      return;
    }
    if (this.#confirm) {
      if (this.#now - this.#confirm.shownAt < this.#o.settings.dialogGuardMs) return;
      if (e.text === "o" || e.text === "O" || e.text === "y" || e.text === "Y") this.#confirm.resolve(true);
      else if (e.text === "n" || e.text === "N" || action === "dialog.refuse" || action === "dialog.confirm") this.#confirm.resolve(false);
      return;
    }
    if (approval) {
      this.#dialogKey(approval, e, action);
      return;
    }
    if (action !== "app.interrupt" && action !== "app.exit") {
      this.#exitArmed = undefined;
      this.#hint = undefined;
    }
    if (searching) {
      // § 5.3 of SPEC-IHM-008: the keys edit the term of the search, never the input.
      this.#assist.searchKey(action, !e.ctrl && !e.alt ? e.text : undefined, e.name === "backspace");
      this.#saveState();
      this.#redraw();
      return;
    }
    // Enter on a proposal that is already what is typed sends the message, as without the list.
    if (action === "list.accept" && e.name === "enter" && this.#assist.selectedIsTyped()) {
      this.#assist.close();
      this.#inputAction(e, "input.submit");
      this.#redraw();
      return;
    }
    if (action?.startsWith("list.")) {
      this.#assist.listKey(action);
      this.#saveState();
      this.#redraw();
      return;
    }
    const before = this.#editor.text;
    const caret = this.#editor.caret;
    this.#inputAction(e, action);
    // The completion follows the text and the caret; an edit ends the browsing of the history.
    if (action !== "input.up" && action !== "input.down" && action !== "input.submit") {
      if (this.#editor.text !== before) this.#assist.edited();
      else if (this.#editor.caret !== caret) this.#assist.refreshList();
    }
    this.#redraw();
  }

  /** FA-01: during a turn, the interruption aborts it; otherwise it clears the input, or arms the exit (FA-04). */
  #interrupt(byCtrlC: boolean): void {
    if (this.running) {
      this.#turn!.abort();
      return;
    }
    if (!byCtrlC) return;
    if (!this.#editor.isEmpty) {
      this.#editor.clear(); // recoverable by undo (§ 5.5)
      this.#saveState();
      this.#redraw();
      return;
    }
    this.#armedExit("ctrl+c");
  }

  #insert(text: string): void {
    if (!this.#editor.insert(text)) this.notice("warning", "Saisie trop longue."); // ERR-01
    this.#saveState();
  }

  #inputAction(e: KeyEvent, action: string | undefined): void {
    const ed = this.#editor;
    switch (action) {
      case "app.exit":
        if (ed.isEmpty) this.#armedExit("ctrl+d");
        else ed.deleteForward();
        return;
      case "app.cancel":
        return;
      case "mode.cycle":
        this.#o.cycleMode?.();
        return;
      case "input.submit":
        this.#submit();
        return;
      case "input.newline":
        this.#insert("\n");
        return;
      case "input.left":
        return ed.left();
      case "input.right":
        return ed.right();
      case "input.wordLeft":
        return ed.wordLeft();
      case "input.wordRight":
        return ed.wordRight();
      case "input.lineStart":
        return ed.home();
      case "input.lineEnd":
        return ed.end();
      case "input.start":
        return ed.start();
      case "input.end":
        return ed.finish();
      case "input.up":
        // SPEC-IHM-011 § 5.3: from an empty input, the last queued message comes back to be edited or removed.
        if (ed.isEmpty && this.#queue.length > 0) {
          ed.set(this.#queue.pop()!);
          this.#saveState();
          return;
        }
        // SPEC-IHM-008 § 5.2: above the first line, the history (EF-03: a multiline input is edited first).
        if (!ed.up()) this.#assist.older();
        return;
      case "input.down":
        if (!ed.down()) this.#assist.newer();
        return;
      case "history.search":
        this.#assist.startSearch();
        return;
      case "input.deleteBack":
        ed.backspace();
        break;
      case "input.deleteForward":
        ed.deleteForward();
        break;
      case "input.deleteWordBack":
        ed.deleteWordBack();
        break;
      case "input.deleteWordForward":
        ed.deleteWordForward();
        break;
      case "input.killLineEnd":
        ed.killToLineEnd();
        break;
      case "input.killLineStart":
        ed.killToLineStart();
        break;
      case "input.transpose":
        ed.transpose();
        break;
      case "input.undo":
        ed.undo();
        break;
      case "input.redo":
        ed.redo();
        break;
      case "draft.stash":
        this.#stashDraft();
        break;
      case "draft.restore":
        this.#restoreDraft();
        break;
      case "queue.clear":
        if (this.#queue.length > 0) {
          this.#queue.splice(0);
          this.notice("info", "File d'attente vidée.");
        }
        break;
      default:
        // ERR-02 of SPEC-IHM-007: an unknown combination is ignored; printable text is inserted.
        if (e.text !== undefined && !e.ctrl && !e.alt) this.#insert(e.text);
        return;
    }
    this.#saveState();
  }

  /** Validation (§ 5.5): sends when idle, queues during a turn (FA-01, SPEC-IHM-011 § 5.1); an empty input sends nothing. */
  #submit(): void {
    const content = this.#editor.text;
    if (content.trim() === "") return; // EF-06, CA-06
    this.#assist.submitted(content); // § 5.1 of SPEC-IHM-008: messages and commands are recorded
    if (EXIT_COMMAND.test(content)) {
      this.#editor.set("");
      this.#saveState();
      void this.requestExit({ byCommand: true });
      return;
    }
    if (this.running || !this.#waiting) {
      if (this.#queue.length >= this.#o.settings.queueMax) {
        this.notice("warning", "File d'attente pleine."); // ERR-01, FA-04: the draft stays in the input area
        return;
      }
      this.#queue.push(content);
      this.#editor.set("");
      this.#editor.breakGroup();
      this.#saveState();
      return;
    }
    this.#editor.set("");
    this.#editor.breakGroup();
    this.#saveState();
    const w = this.#waiting;
    this.#waiting = undefined;
    w({ kind: "message", text: content });
  }

  #stashDraft(): void {
    if (this.#editor.isEmpty) return;
    this.#stash.push(this.#editor.text);
    this.#editor.set("");
    if (this.#stash.length > this.#o.settings.draftsMax) {
      this.#stash.shift();
      this.notice("warning", "Le brouillon le plus ancien a été retiré."); // ERR-02
    }
  }

  #restoreDraft(): void {
    const last = this.#stash.pop();
    if (last === undefined) return;
    if (!this.#editor.isEmpty) this.#stash.push(this.#editor.text);
    this.#editor.set(last);
  }

  #saveState(): void {
    this.#o.onInputState?.({ draft: this.#editor.text, queue: [...this.#queue], stash: [...this.#stash] });
  }

  // ---- Frame ----------------------------------------------------------------------------------------------------------

  #frame(size: { columns: number; rows: number }) {
    const ctx = this.#ctx(size.columns);
    if (ctx.narrow && !this.#narrowWarned) {
      this.#narrowWarned = true;
      queueMicrotask(() => this.notice("warning", "Terminal étroit : affichage simplifié.")); // ERR-02 of SPEC-MOD-001
    }
    const panels: Node[] = [];
    const approval = this.#approvals[0];
    if (approval) panels.push(this.#dialogView(approval));
    if (this.#confirm) panels.push(this.#confirmView(this.#confirm));
    if (this.#queue.length > 0) {
      // SPEC-IHM-011 § 5.3: a compact view of the queue, one line per message.
      panels.push(
        box(
          this.#queue.map((m, i) => text([{ text: `${i + 1}. `, style: { dim: true } }, { text: m.split("\n")[0]!.slice(0, 200), style: { dim: true } }], { overflow: "clip" })),
          { padding: { left: 2 } },
        ),
      );
    }
    // The list of completion and the search band, right above the input area.
    if (!approval && !this.#confirm) panels.push(...this.#assist.panels());
    const stream: Node[] = [];
    if (this.#stream) {
      // § 5.2 of SPEC-IHM-003: the content being produced is rendered by its probable intention.
      if (this.#o.render && !this.#streamRenderer) this.#streamRenderer = new MarkdownRenderer(this.#o.render.markdown, this.#view.unicode);
      stream.push(modelView(this.#streamRenderer ? this.#streamRenderer.render(this.#stream) : this.#stream, this.#view));
    }
    if (this.running) stream.push(activityView(this.#activity, this.#now - this.#turnStarted, this.#spinner, this.#view));
    return composeFrame(
      { stream: stream.length > 0 ? box(stream) : undefined, panels, input: this.#inputNode(size.columns, ctx), status: this.#statusNode() },
      size,
      { unicode: this.#view.unicode, minColumns: this.#o.settings.minColumns, retainedLines: this.#o.settings.retainedLines },
    );
  }

  /** The input area: a frame, the prompt, the text and its caret, at most `ui.inputMaxHeight` lines around the caret. */
  #inputNode(columns: number, ctx: LayoutContext): Node {
    const ed = this.#editor;
    const inner = Math.max(1, (ctx.narrow ? columns : columns - 4) - 2);
    const placeholder = ed.isEmpty;
    const spans: Span[] = placeholder ? [{ text: this.running ? "Message à mettre en file…" : "Votre message (Entrée pour envoyer, Alt+Entrée pour un saut de ligne)", style: { dim: true } }] : [{ text: ed.text }];
    const laid = layoutNode(text(spans, { caret: placeholder ? 0 : ed.caretGrapheme }), inner, ctx);
    let lines = laid.lines;
    let cursor = laid.cursor;
    const max = Math.max(this.#o.settings.inputMinHeight, this.#o.settings.inputMaxHeight);
    let hidden = 0;
    if (lines.length > max) {
      // § 5.4: beyond the maximal height, the area scrolls around the caret; the hidden lines are counted.
      const focus = cursor?.row ?? lines.length - 1;
      const start = Math.max(0, Math.min(focus - max + 1, lines.length - max));
      hidden = lines.length - max;
      lines = lines.slice(start, start + max);
      cursor = cursor ? { row: cursor.row - start, col: cursor.col } : undefined;
    }
    while (lines.length < this.#o.settings.inputMinHeight) lines.push([]);
    const prompt = spansToLines([{ text: this.#view.unicode === "full" ? "› " : "> ", style: { bold: true } }])[0]!;
    const indent: Cell[] = spansToLines([{ text: "  " }])[0]!;
    const rows = lines.map((l, i) => [...(i === 0 ? prompt : indent), ...l]);
    const extra: string[] = [];
    if (hidden > 0) extra.push(`${hidden} ligne${hidden > 1 ? "s" : ""} hors de la vue`);
    if (ed.text.length > this.#o.settings.inputWarnChars) extra.push(`${ed.text.length} caractères : risque de saturer le contexte`); // FA-02
    // FA-06, RG-02 of SPEC-IHM-007: a doubled trigger character is shown as it will be sent.
    const sent = this.#transformed(ed.text);
    if (sent !== undefined) extra.push(`Envoyé tel quel : ${sent.split("\n")[0]}`);
    const node = box([{ kind: "lines", lines: rows, cursor: cursor ? { row: cursor.row, col: cursor.col + 2 } : undefined }, ...extra.map((x) => text([{ text: x, style: { dim: true } }], { overflow: "clip" }))], {
      border: { style: { dim: true } },
      padding: { left: 1, right: 1 },
    });
    return node;
  }

  /** The text that will be sent when it differs from the input (doubled trigger characters), otherwise undefined. */
  #transformed(content: string): string | undefined {
    const first = recognize(content);
    const afterSlash = first.kind === "text" ? first.text : content;
    const t = literalTriggers(afterSlash);
    return t.text !== content ? t.text : undefined;
  }

  #statusNode(): Node {
    const s = this.#o.status();
    const parts: Span[] = [{ text: `mode : ${s.mode}` }, { text: ` · ${s.model}` }];
    // EF-05 of SPEC-IHM-011: the number of waiting messages is always visible when not zero.
    if (this.#queue.length > 0) parts.push({ text: ` · ${this.#queue.length} message${this.#queue.length > 1 ? "s" : ""} en attente`, style: { bold: true } });
    if (this.#stash.length > 0) parts.push({ text: ` · ${this.#stash.length} brouillon${this.#stash.length > 1 ? "s" : ""} de côté` });
    const position = this.#assist.position();
    if (position) parts.push({ text: ` · ${position}`, style: { bold: true } }); // § 10 of SPEC-IHM-008
    if (this.#hint) parts.push({ text: ` · ${this.#hint}`, style: { bold: true } });
    else if (this.#o.showFooterHints !== false) {
      // § 5.6 of SPEC-IHM-014: the most useful actions, with their effective combinations.
      const hint = (id: string, what: string) => {
        const c = this.#keymap.effective(id)[0];
        return c ? `${comboLabel(c)} : ${what}` : undefined;
      };
      const hints = [hint("mode.cycle", "mode"), hint("app.interrupt", "interrompre, deux fois : quitter"), "/help : aide"].filter((h) => h !== undefined);
      parts.push({ text: ` · ${hints.join(" · ")}` });
    }
    return text(parts.map((p) => ({ ...p, style: { dim: true, ...(p.style ?? {}) } })), { overflow: "clip" });
  }
}
