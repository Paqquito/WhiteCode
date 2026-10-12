// Implements: SPEC-MOD-001 (§ 5.2 steps 2 to 7, § 5.4 states, FA-01, FA-02, FA-04, EF-02, EF-03, EF-05, EF-06, ERR-03, CA-01, CA-02, CA-03), SPEC-IHM-007 (§ 5.4, § 5.5, § 5.6, FA-01, FA-02, FA-05, EF-04 to EF-07, CA-01, CA-03, CA-06, CA-07, CA-12), SPEC-IHM-011 (§ 5.1 to § 5.5, EF-01 to EF-05, EF-07, ERR-01, ERR-02, CA-01 to CA-06), SPEC-IHM-027 (§ 5.1, § 5.3, FA-01, EF-01 to EF-04, RG-01, CA-01, CA-02)
// The interactive application: input area, conversation flow, temporary panels, status line. It turns keys into actions,
// keeps the draft, the queue of messages and the stashed drafts, shows the permission dialog in a fixed zone, and hands
// the messages to the session one at a time.
// Supports: SPEC-IHM-038 (EF-03, CA-02: no waiting animation in reduced motion).
// Supports: SPEC-IHM-019 (CA-01/02, choices and preview), SPEC-IHM-020 (CA-02), SPEC-CMD-072 (CA-01), SPEC-IHM-005 (CA-07), SPEC-MOD-001 (CA-06), gap E-142.

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
import { themeLines, type Theme } from "../ui/theme";
import { openTerminalSession, type TerminalSession } from "../ui/terminal-session";
import { spansToLines, type Cell, type Span } from "../ui/text";
import { recognize } from "../commands/recognize";
import { comboLabel, Keymap, type KeyContext } from "./keymap";
import { literalTriggers } from "./triggers";
import { InputAssist, type AssistOptions } from "./assist";
import type { UsageStats } from "./completion";
import type { InputHistory } from "./history";
import { MarkdownRenderer, type MarkdownOptions } from "../ui/markdown";
import { isShellLine } from "./shell-mode";
import { ModalEngine } from "../ui/modal";
import { maskSecrets } from "../shared/secrets";
import { newViewState, TranscriptView, type ItemKind, type TranscriptItem, type ViewSettings } from "./transcript-view";
import { containsSecret } from "../shared/secrets";
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

/**
 * An entry of the user. `literal`: the line starts with pasted text that stays text, never a command nor a shell line
 * (SPEC-IHM-010 EF-09); `pasted`: the texts pasted in it, which never make an active reference (EF-10).
 */
export type Entry = { readonly kind: "message"; readonly text: string; readonly literal?: boolean; readonly pasted?: readonly string[] } | { readonly kind: "exit" };

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

/** Answer of a choice dialog (SPEC-OUT-033 § 5.3, SPEC-OUT-024 § 5.3 step 3). */
export type ChoiceAnswer = { readonly kind: "options"; readonly labels: readonly string[] } | { readonly kind: "other"; readonly text: string } | { readonly kind: "cancelled" };

interface ChoiceDialog {
  readonly title: string;
  readonly header?: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string; readonly disabledReason?: string }>;
  readonly preview?: (index: number) => void;
  readonly multiple: boolean;
  /** A free answer is offered as the last option (EF-01 of SPEC-OUT-033). */
  readonly other: boolean;
  selected: number;
  readonly marked: Set<number>;
  readonly shownAt: number;
  readonly resolve: (answer: ChoiceAnswer) => void;
}

/** A text typed in the input area for a dialog (free answer, edited plan, comment), instead of a message. */
interface Capture {
  readonly prompt: string;
  readonly allowEmpty: boolean;
  readonly resolve: (text: string | undefined) => void;
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
  readonly reducedMotion?: boolean;
  readonly terminal: Terminal;
  readonly capabilities: Capabilities;
  readonly settings: AppSettings;
  /** Mode, model and other facts of the status line. */
  readonly status: () => { readonly mode: string; readonly model: string };
  readonly cycleMode?: () => void;
  /** Background tasks still running, stopped by the exit (SPEC-CMD-023 CA-01). */
  readonly backgroundTasks?: () => number;
  /** The task list of the main agent, shown above the input area (SPEC-OUT-021 § 10). */
  readonly tasks?: () => ReadonlyArray<{ readonly subject: string; readonly status: string; readonly progressLabel?: string }>;
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
  /** The full-screen view of the transcript (SPEC-IHM-006). */
  readonly transcript?: ViewSettings & { readonly title: string };
  /** Modal editing (SPEC-IHM-013): `ui.input.editMode`, the starting mode and the bound of the counts. */
  readonly modal?: { readonly enabled: boolean; readonly startMode: "insert" | "normal"; readonly countLimit: number };
  /** Shell mode (SPEC-IHM-012): enabled, and the name of the interpreter shown by the indicator. */
  readonly shell?: { readonly enabled: boolean; readonly label: string };
  /** Pastes (SPEC-IHM-010 § 5.2, § 11). */
  readonly paste?: { readonly collapseThreshold: number; readonly maxChars: number; readonly detectHeuristic: boolean };
  /** Files that a `@` reference of the input will attach at sending (EF-10: shown before sending). */
  readonly attachments?: (text: string, pasted: readonly string[]) => readonly string[];
  /** Rich text of the answers (SPEC-IHM-003, SPEC-IHM-004) and differences of the changes (SPEC-IHM-005). */
  readonly render?: { readonly markdown: MarkdownOptions; readonly diff: DiffOptions };
  readonly theme?: Theme;
  readonly clock?: () => number;
  readonly scheduler?: Scheduler;
}

export class InteractiveApp {
  readonly #o: AppOptions;
  readonly #view: ViewContext;
  #theme: Theme | undefined;
  #render: AppOptions["render"];
  readonly #keys = new KeyParser();
  #keymap: Keymap;
  readonly #editor: Editor;
  readonly #assist: InputAssist;
  #modal: ModalEngine | undefined;
  /** Items of the transcript, for the full-screen view (SPEC-IHM-006 § 5.2), in time order (RG-02). */
  readonly #items: TranscriptItem[] = [];
  #turnNumber = 0;
  #thinking = "";
  #transcriptView: TranscriptView | undefined;
  readonly #viewState = newViewState();
  /** Last shape of the cursor written, so that it is written only on a change (CA-01 of SPEC-IHM-013). */
  #cursorShape = "";
  readonly #queue: string[];
  #queueHeld = false;
  readonly #stash: string[];
  readonly #approvals: PendingApproval[] = [];
  #confirm: Confirm | undefined;
  #secret: { title: string; value: string; resolve: (value: string | undefined) => void } | undefined;
  #choice: ChoiceDialog | undefined;
  #capture: Capture | undefined;
  #session: TerminalSession | undefined;
  #unsubscribeInput: (() => void) | undefined;
  #unsubscribeResize: (() => void) | undefined;
  #waiting: ((e: Entry) => void) | undefined;
  #turn: AbortController | undefined;
  #turnStarted = 0;
  #activity = "Réflexion…";
  #spinner = 0;
  #animation: ReturnType<typeof setInterval> | undefined;
  #stream = "";
  /** Renderer of the response being produced: its finished blocks are not parsed again (ENF-02 of SPEC-IHM-003). */
  #streamRenderer: MarkdownRenderer | undefined;
  /** Pasted contents folded in the input, by their compact reference (SPEC-IHM-010 § 5.2). */
  readonly #pastes = new Map<string, string>();
  #pasteCount = 0;
  /** Texts pasted in the current input (EF-10). */
  #pasted: string[] = [];
  /** The input starts with a pasted `/` or `!`: it stays text (EF-09); `uncertain`: detected by the heuristic only. */
  #literalLead: "certain" | "uncertain" | undefined;
  /** Output of the shell command running (SPEC-IHM-012 EF-04). */
  #shellOutput: string | undefined;
  #shellCommand = "";
  /** The text of the current response was committed before its end (by a call of a tool). */
  #responseCommitted = false;
  #exitArmed: { combo: string; until: number } | undefined;
  #hint: string | undefined;
  #exiting = false;
  #narrowWarned = false;
  readonly #callNames = new Map<string, string>();

  constructor(o: AppOptions) {
    this.#o = o;
    this.#render = o.render;
    this.#theme = o.theme;
    this.#view = { unicode: o.capabilities.unicode, ...(o.render ? { markdown: (c: string) => new MarkdownRenderer(this.#render!.markdown, o.capabilities.unicode).render(c) } : {}) };
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
      inactive: () => this.shellLine || (this.#modal !== undefined && this.#modal.mode !== "insert"),
    });
    if (o.modal?.enabled) this.#modal = new ModalEngine(this.#editor, { countLimit: o.modal.countLimit, startMode: o.modal.startMode });
  }

  get #now(): number {
    return (this.#o.clock ?? Date.now)();
  }

  /** New key bindings, applied at once (FA-03 of SPEC-IHM-014). */
  setKeymap(keymap: Keymap): void {
    this.#keymap = keymap;
    this.#redraw();
  }

  /**
   * EF-03, CA-06 of SPEC-IHM-013: the modal editing switched on or off during the input, the content kept; the standard
   * editing applies at once when it is off (EF-07: it is never on by default).
   */
  setModal(enabled: boolean): void {
    const o = this.#o.modal ?? { enabled: false, startMode: "insert" as const, countLimit: 999 };
    this.#modal = enabled ? new ModalEngine(this.#editor, { countLimit: o.countLimit, startMode: "insert" }) : undefined;
    this.#updateCursorShape();
    this.#redraw();
  }

  get modalMode(): string | undefined {
    return this.#modal?.mode;
  }

  /** The shape of the cursor follows the mode: a bar to insert, a block for the commands (CA-01). */
  #updateCursorShape(): void {
    const shape = !this.#modal ? "" : this.#modal.mode === "insert" ? "\u001b[6 q" : "\u001b[2 q";
    if (shape === this.#cursorShape) return;
    this.#o.terminal.write(shape || "\u001b[0 q");
    this.#cursorShape = shape;
  }

  /** An item of the transcript; its sensitive values are masked as in the flow (EF-06 of SPEC-IHM-006). */
  record(kind: ItemKind, title: string, body: string): void {
    if (kind === "user") this.#turnNumber++;
    this.#items.push({ id: this.#items.length + 1, kind, title: maskSecrets(title), body: maskSecrets(body), at: this.#now, turn: this.#turnNumber });
    this.#transcriptView?.refresh(); // FA-01: the items of the session in progress come at the bottom
  }

  get transcriptItems(): readonly TranscriptItem[] {
    return this.#items;
  }

  get transcriptOpen(): boolean {
    return this.#transcriptView !== undefined;
  }

  /** § 5.1: the view opens over the session, which goes on behind it (EF-05, CA-04). */
  openTranscript(): void {
    if (this.#transcriptView || !this.#session) return;
    const settings = this.#o.transcript ?? { defaultDetail: "normal", collapseThreshold: 20, showThinking: true, title: "Transcription" };
    this.#session.screen.suspend();
    this.#transcriptView = new TranscriptView({
      terminal: this.#o.terminal,
      capabilities: this.#o.capabilities,
      items: () => this.#items,
      settings,
      state: this.#viewState,
      title: settings.title,
      markdown: this.#view.markdown,
      theme: (lines, width) => themeLines(lines, this.#theme, width, this.#o.capabilities.colors),
      onClose: () => {
        this.#transcriptView = undefined;
        this.#session?.screen.resume();
      },
    });
    this.#transcriptView.open();
  }

  /** The input is a line of the shell mode (SPEC-IHM-012 § 5.1). */
  get shellLine(): boolean {
    return this.#o.shell?.enabled === true && this.#literalLead === undefined && isShellLine(this.#editor.text);
  }

  /** SPEC-IHM-012 § 5.2: a shell command starts; its line is shown, its output follows as it comes (EF-04). */
  shellStarted(command: string): void {
    this.commit(box([text([{ text: "! ", style: { bold: true, fg: { ansi: 5 } } }, { text: command, style: { bold: true } }])]));
    this.#shellOutput = "";
    this.#shellCommand = command;
    this.#activity = "Commande en cours…";
    this.#redraw();
  }

  shellOutput(chunk: string): void {
    if (this.#shellOutput === undefined) return;
    this.#shellOutput += chunk;
    this.#redraw();
  }

  /** Step 4: the output kept, bounded (FA-05), then the exit code, highlighted when not zero; the context mention (EF-05). */
  shellEnded(o: { readonly output: string; readonly exitCode: number | null; readonly interrupted: boolean; readonly maxBytes: number; readonly addedToContext: boolean }): void {
    this.#shellOutput = undefined;
    this.record("shell", this.#shellCommand, o.output);
    let shown = o.output.replace(/\s+$/, "");
    const bytes = Buffer.byteLength(shown, "utf8");
    if (bytes > o.maxBytes) shown = `${Buffer.from(shown, "utf8").subarray(0, o.maxBytes).toString("utf8")}\n… sortie tronquée à l'affichage (${bytes} octets au total)`;
    if (shown) this.commit(box([text(shown, { overflow: "clip" })], { padding: { left: 2 } }));
    const t = tone(o.exitCode === 0 && !o.interrupted ? "success" : "error", this.#view.unicode);
    const status = o.interrupted ? "commande interrompue" : `code de retour ${o.exitCode ?? "inconnu"}`;
    this.commit(box([text([{ text: `  ${t.symbol} ${status}`, style: o.exitCode === 0 && !o.interrupted ? { dim: true } : t.style }, ...(o.addedToContext ? [{ text: " · ajoutée au contexte de la conversation", style: { dim: true } }] : [])])]));
  }

  get viewContext(): ViewContext {
    return this.#view;
  }

  get running(): boolean {
    return this.#turn !== undefined;
  }

  get exiting(): boolean { return this.#exiting; }

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
    this.#unsubscribeResize = this.#o.terminal.onResize(() => this.#transcriptView?.resized());
    this.#updateCursorShape();
    this.#session.screen.flush();
  }

  /** Replays input captured after startup consent once the ordinary input consumer is installed. */
  acceptStartupInput(chunks: readonly string[]): void { for (const chunk of chunks) this.#input(chunk); }

  /** Restores the terminal; idempotent. */
  stop(): void {
    if (this.#cursorShape) {
      this.#o.terminal.write("\u001b[0 q"); // the shape of the cursor found at start
      this.#cursorShape = "";
    }
    this.#stopAnimation();
    this.#unsubscribeInput?.();
    this.#unsubscribeInput = undefined;
    this.#unsubscribeResize?.();
    this.#unsubscribeResize = undefined;
    if (this.#transcriptView) this.#transcriptView.close();
    this.#session?.close();
    for (const a of this.#approvals.splice(0)) a.resolve({ answer: "no_stop" });
    this.#confirm?.resolve(false);
    this.#confirm = undefined;
    this.#secret?.resolve(undefined);
    this.#choice?.resolve({ kind: "cancelled" });
    this.#capture?.resolve(undefined);
  }

  /** Next entry of the user: a message, or the exit (step 3 of § 5.2). */
  nextEntry(): Promise<Entry> {
    if (this.#exiting) return Promise.resolve({ kind: "exit" });
    return new Promise((resolve) => {
      this.#waiting = resolve;
      this.#redraw();
    });
  }

  /**
   * SPEC-MOT-008 § 5.1: at the safe point of a turn, the queued messages leave the queue together, in order; the
   * commands and the shell lines stay, to run at the end of the turn (FA-01, FA-04).
   */
  takeForSafePoint(): string[] {
    if (this.#queueHeld) return [];
    const taken = this.#queue.filter((m) => !/^\s*[/!]/.test(m));
    if (taken.length === 0) return [];
    this.#queue.splice(0, this.#queue.length, ...this.#queue.filter((m) => /^\s*[/!]/.test(m)));
    this.#saveState();
    this.#redraw();
    return taken;
  }

  /** Something shown outside the turn changed (the task list): the live area is drawn again. */
  refresh(): void {
    this.#redraw();
  }

  /** Next message of the queue, removed from it (SPEC-IHM-011 § 5.2: one per turn, in order). */
  takeQueued(): string | undefined {
    if (this.#queueHeld) return undefined;
    const next = this.#queue.shift();
    if (next !== undefined) this.#saveState();
    return next;
  }

  /** Recovery of one interrupted message does not release the saved queue (gap E-132). */
  setQueueHeld(held: boolean): void { this.#queueHeld = held; }

  // ---- Turn ----------------------------------------------------------------------------------------------------

  /** A turn starts: the input area stays usable (EF-07 of SPEC-IHM-007); an interruption aborts `controller`. */
  beginTurn(controller: AbortController): void {
    this.#turn = controller;
    this.#turnStarted = this.#now;
    this.#activity = "Réflexion…";
    this.#stream = "";
    this.#responseCommitted = false;
    if (!this.#o.reducedMotion) this.#animation = setInterval(() => {
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
    if (outcome.stopCause === "interrupted") {
      this.commit(interruptionView(this.#view));
      this.record("marker", "Interrompu par l'utilisateur", "");
    }
    else if (outcome.stopCause === "error") this.notice("error", `Le tour a échoué : ${outcome.message ?? "erreur inconnue"}.`); // ERR-03
    else if (outcome.stopCause !== "completed" && outcome.message) this.notice("warning", outcome.message);
    this.#redraw();
  }

  /** Engine events of the turn, displayed as they arrive (ENF-01: the first character as soon as it is received). */
  onEngineEvent(e: EngineEvent): void {
    switch (e.type) {
      case "user_message": {
        if (e.synthetic) break;
        const texts = e.content.flatMap((p) => (p.type === "text" ? [p.text] : []));
        const attached = texts.filter((t) => t.startsWith("<attached-file "));
        const content = texts.filter((t) => !t.startsWith("<attached-file ")).join("\n");
        if (content) this.commit(userView(content, this.#view));
        this.record("user", "", [content, ...attached.map((a) => `[pièce jointe ${/path="([^"]*)"/.exec(a)?.[1] ?? "?"}]`)].filter(Boolean).join("\n"));
        // SPEC-IHM-010 § 10: an attachment is shown by a compact line, its content went to the model.
        for (const a of attached) {
          const path = /path="([^"]*)"/.exec(a)?.[1] ?? "?";
          const lines = a.split("\n").length - 2;
          this.notice("system", `Pièce jointe : ${path} (${lines} ligne${lines > 1 ? "s" : ""})`);
        }
        break;
      }
      case "text_delta":
        this.#stream += e.text;
        this.#activity = "Rédaction…";
        this.#redraw();
        break;
      case "thinking_delta":
        this.#thinking += e.text;
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
        if (this.#thinking.trim()) this.record("thinking", "", this.#thinking.trim());
        this.#thinking = "";
        if (e.text.trim()) this.record("model", "", e.text.trim());
        break;
      case "tool_call":
        this.#flushStream();
        this.#callNames.set(e.callId, e.name);
        this.#activity = `${e.name}…`;
        this.commit(toolCallView(e.name, this.#o.describeCall(e.name, e.input), this.#view));
        this.record("tool", `${e.name}  ${this.#o.describeCall(e.name, e.input)}`, JSON.stringify(e.input ?? {}, null, 2));
        break;
      case "tool_result":
        // EF-06 of SPEC-IHM-006: a sensitive value is masked in the flow as in the view.
        this.commit(toolResultView(maskSecrets(e.output), e.isError, this.#view));
        this.record("result", `${this.#callNames.get(e.callId) ?? "outil"}${e.isError ? " (erreur)" : ""}`, e.output);
        this.#activity = "Réflexion…";
        break;
      case "retry":
        this.#activity = `Service indisponible, nouvel essai dans ${Math.max(1, Math.round(e.delayMs / 1000))} s…`;
        this.#redraw();
        break;
      case "permission":
        this.record("permission", e.decision === "allow" ? "autorisée" : "refusée", e.reason);
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
    this.#session.screen.commit(themeLines(layoutNode(node, columns, this.#ctx(columns)).lines, this.#theme, columns, this.#o.capabilities.colors));
  }

  /** A preview changes only this application, including the active stream and alternate transcript view. */
  setTheme(theme: Theme, render: NonNullable<AppOptions["render"]>): void {
    this.#theme = theme;
    this.#render = render;
    this.#streamRenderer = undefined;
    this.#transcriptView?.refresh();
    this.#redraw();
  }

  notice(t: Tone, message: string): void {
    this.commit(noticeView(t, message, this.#view));
    this.record("notice", "", message);
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
        if (signal.aborted) { resolve({ answer: "no_stop" }); return; }
        let settled = false;
        const onAbort = () => pending.resolve({ answer: "no_stop" });
        const pending: PendingApproval = {
          request,
          resolve: (a) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener("abort", onAbort);
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
        signal.addEventListener("abort", onAbort, { once: true });
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
    if (r.change && this.#render) {
      // SPEC-IHM-005 EF-01: the change presented as a difference before the decision.
      rows.push(diffNode(r.change, { ...this.#render.diff, maxDisplayedLines: Math.min(this.#render.diff.maxDisplayedLines, 40) }));
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
  /**
   * A question with options, entirely usable from the keyboard (EF-04 of SPEC-OUT-033): arrows, numbers, space to mark
   * with several answers, Enter to validate, Échap to give no answer; the last option is a free answer.
   */
  choose(title: string, options: ReadonlyArray<{ readonly label: string; readonly description?: string; readonly disabledReason?: string }>, o: { readonly multiple?: boolean; readonly header?: string; readonly other?: boolean; readonly selected?: number; readonly preview?: (index: number) => void } = {}): Promise<ChoiceAnswer> {
    if (this.#exiting) return Promise.resolve({ kind: "cancelled" });
    if (options.length === 0 && o.other === false) return Promise.resolve({ kind: "cancelled" });
    return new Promise((resolve) => {
      this.#choice = {
        title,
        ...(o.header ? { header: o.header } : {}),
        options,
        multiple: o.multiple === true,
        other: o.other !== false,
        selected: Math.max(0, Math.min(o.selected ?? 0, options.length - 1)),
        ...(o.preview ? { preview: o.preview } : {}),
        marked: new Set(),
        shownAt: this.#now,
        resolve: (answer) => {
          this.#choice = undefined;
          if (answer.kind !== "other" || answer.text !== "\u0000") {
            resolve(answer);
            this.#redraw();
            return;
          }
          // The free answer: typed in the input area.
          void this.editText(`${title} — votre réponse :`, "").then((text) => resolve(text === undefined ? { kind: "cancelled" } : { kind: "other", text }));
        },
      };
      this.#redraw();
    });
  }

  /** A text typed or edited in the input area, sent with Enter, abandoned with Échap (`undefined`). */
  editText(prompt: string, initial: string, allowEmpty = false): Promise<string | undefined> {
    if (this.#exiting) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.#capture = {
        prompt,
        allowEmpty,
        resolve: (text) => {
          this.#capture = undefined;
          resolve(text);
          this.#redraw();
        },
      };
      this.#editor.set(initial);
      this.#redraw();
    });
  }

  #choiceKey(c: ChoiceDialog, e: KeyEvent, action: string | undefined): void {
    if (this.#now - c.shownAt < this.#o.settings.dialogGuardMs) return;
    const count = c.options.length + (c.other ? 1 : 0);
    const pick = (index: number) => {
      if (c.other && index === c.options.length) return c.resolve({ kind: "other", text: "\u0000" });
      if (c.options[index]?.disabledReason) { this.#redraw(); return; }
      if (c.multiple) {
        if (c.marked.has(index)) c.marked.delete(index);
        else c.marked.add(index);
        this.#redraw();
        return;
      }
      c.resolve({ kind: "options", labels: [c.options[index]!.label] });
    };
    if (e.name === "up" || action === "dialog.previous") c.selected = (c.selected + count - 1) % count;
    else if (e.name === "down" || action === "dialog.next") c.selected = (c.selected + 1) % count;
    else if (e.name === "escape" || action === "dialog.refuse") return c.resolve({ kind: "cancelled" }); // FA-01: no answer
    else if (e.text === " " && c.multiple && c.selected < c.options.length) return pick(c.selected);
    else if (e.name === "enter") {
      if (c.multiple && c.marked.size > 0 && c.selected !== c.options.length) return c.resolve({ kind: "options", labels: [...c.marked].sort((a, b) => a - b).map((i) => c.options[i]!.label) });
      if (c.multiple && c.selected < c.options.length && !c.options[c.selected]?.disabledReason) return c.resolve({ kind: "options", labels: [c.options[c.selected]!.label] });
      return pick(c.selected);
    } else if (e.text !== undefined && /^[1-9]$/.test(e.text) && Number(e.text) <= count) {
      c.selected = Number(e.text) - 1;
      if (!c.options[c.selected]?.disabledReason) c.preview?.(c.selected);
      return pick(c.selected);
    } else return;
    if (!c.options[c.selected]?.disabledReason) c.preview?.(c.selected);
    this.#redraw();
  }

  #choiceView(c: ChoiceDialog): Node {
    const t = tone("info", this.#view.unicode);
    const labels = [...c.options.map((o) => o.label), ...(c.other ? ["Autre (réponse libre)"] : [])];
    const lines = labels.map((label, i) => {
      const box = c.multiple && i < c.options.length ? (c.marked.has(i) ? "[x] " : "[ ] ") : "";
      const description = [c.options[i]?.description, c.options[i]?.disabledReason ? `verrouillé : ${c.options[i]!.disabledReason}` : undefined].filter(Boolean).join(" · ");
      return text([{ text: `${i === c.selected ? "❯" : " "} ${i + 1}. ${box}`, style: i === c.selected ? { bold: true } : {} }, { text: label, style: i === c.selected ? { bold: true } : {} }, ...(description ? [{ text: ` — ${description}`, style: { dim: true } }] : [])]);
    });
    const hint = c.multiple ? "↑↓ · Espace : cocher · Entrée : valider · Échap : sans réponse" : "↑↓ ou chiffre · Entrée : choisir · Échap : sans réponse";
    return { kind: "render", render: (width, ctx) => {
      // Keep the selected entry visible; descriptions may wrap and consume more than one row.
      const room = Math.max(1, this.#o.terminal.rows - this.#o.settings.inputMinHeight - 8);
      const heights = lines.map((line) => layoutNode(line, Math.max(1, width - 4), ctx).lines.length);
      let start = c.selected, end = start + 1, used = heights[start] ?? 1;
      while (end < lines.length && used + heights[end]! <= room) used += heights[end++]!;
      while (start > 0 && used + heights[start - 1]! <= room) used += heights[--start]!;
      const range = start > 0 || end < lines.length ? ` · options ${start + 1}–${end}/${lines.length}` : "";
      return layoutNode(box([text([...(c.header ? [{ text: `[${c.header}] `, style: { dim: true } }] : []), { text: c.title + range, style: { bold: true } }]), ...lines.slice(start, end), text([{ text: hint, style: { dim: true } }])], { border: { style: t.style }, padding: { left: 1, right: 1 } }), width, ctx);
    } };
  }

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

  /** Separate masked buffer: a credential never enters the editor, history, queue or persisted input state. */
  requestSecret(title: string): Promise<string | undefined> {
    if (this.#exiting) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      this.#secret = { title, value: "", resolve: (value) => { if (this.#secret) this.#secret.value = ""; this.#secret = undefined; resolve(value); this.#redraw(); } };
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
    const tasks = this.#o.backgroundTasks?.() ?? 0;
    if (tasks > 0) work.push(`${tasks} tâche${tasks > 1 ? "s" : ""} de fond ${tasks > 1 ? "seront arrêtées" : "sera arrêtée"}`);
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
    this.#secret?.resolve(undefined);
    this.#choice?.resolve({ kind: "cancelled" });
    this.#capture?.resolve(undefined);
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
    if (this.#transcriptView) {
      // RG-01 of SPEC-IHM-006: the view is read-only; Ctrl+C closes it without interrupting the session.
      const events = this.#keys.feed(data);
      if (data === "\u001b") events.push(...this.#keys.flush());
      for (const e of events) {
        if (e.kind === "key" && e.ctrl && e.name === "c") this.#transcriptView?.close();
        else this.#transcriptView?.key(e);
      }
      return;
    }
    // SPEC-IHM-010 § 5.1, FA-06: without the framing of the terminal, several characters arriving at once are a paste.
    if (this.#o.paste?.detectHeuristic !== false && !data.includes("\u001b") && [...data].length > 1 && /[^\r\n]/.test(data)) {
      this.#event({ kind: "paste", text: data }, true);
      return;
    }
    const events = this.#keys.feed(data);
    // A lone escape is a key of its own (terminals send whole sequences in one chunk).
    if (data === "\u001b") events.push(...this.#keys.flush());
    for (const e of events) this.#event(e);
  }

  #event(e: InputEvent, uncertain = false): void {
    if (this.#secret) {
      const secret = this.#secret;
      if (e.kind === "paste") {
        if (!/[\r\n\u0000]/.test(e.text) && secret.value.length + e.text.length <= 2048) secret.value += e.text;
      } else if (e.name === "escape" || e.ctrl && ["c", "d"].includes(e.name)) secret.resolve(undefined);
      else if (e.name === "enter") { if (secret.value) secret.resolve(secret.value); }
      else if (e.name === "backspace") secret.value = [...secret.value].slice(0, -1).join("");
      else if (!e.ctrl && !e.alt && e.text && !/[\u0000-\u001f\u007f]/.test(e.text) && secret.value.length + e.text.length <= 2048) secret.value += e.text;
      this.#redraw(); return;
    }
    if (e.kind === "paste") {
      // SPEC-IHM-010 EF-01: a paste never sends anything, whatever it contains.
      const active = this.#approvals[0]?.explaining;
      if (active) active.insert(e.text.replace(/\r\n?/g, "\n"));
      else if (!this.#approvals[0] && !this.#confirm) this.#paste(e.text.replace(/\r\n?/g, "\n"), uncertain);
      this.#redraw();
      return;
    }
    const approval = this.#approvals[0];
    const searching = this.#assist.searching;
    const contexts: KeyContext[] = approval || this.#confirm || this.#choice ? ["dialog", "app"] : searching ? ["search", "app"] : [...this.#assist.contexts(), "input", "app"];
    const action = this.#keymap.action(e, contexts);
    // Essential application actions keep priority over any edition (SPEC-IHM-013 § 5.5).
    const modalEscape = this.#modal !== undefined && (this.#modal.mode !== "normal" || this.#modal.pending !== "");
    // A text typed for a dialog is abandoned with Échap, before the interruption of the turn.
    if (this.#capture && action === "app.cancel" && !approval && !this.#confirm && !modalEscape) {
      this.#editor.set("");
      this.#capture.resolve(undefined);
      return;
    }
    if (this.#choice && action !== "app.interrupt") {
      this.#choiceKey(this.#choice, e, action);
      return;
    }
    if (action === "app.interrupt" || (action === "app.cancel" && this.running && !approval && !this.#confirm && !modalEscape)) {
      if (this.#choice) {
        this.#choice.resolve({ kind: "cancelled" });
        return;
      }
      if (this.#capture) {
        this.#editor.set("");
        this.#capture.resolve(undefined);
        return;
      }
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
    // SPEC-IHM-013: the keys of the modal editing, after the global actions (EF-02) and the dialogs.
    if (this.#modal && !action?.startsWith("list.") && action !== "input.toggleModal" && action !== "view.transcript" && action !== "mode.cycle" && action !== "app.exit") {
      const before = this.#editor.text;
      const r = this.#modal.key(e);
      if (r === "submit") {
        this.#inputAction(e, "input.submit"); // FA-01
        this.#modal.reset(); // RG-03
      }
      if (r !== "pass") {
        if (this.#editor.text !== before) this.#assist.edited();
        this.#updateCursorShape();
        this.#saveState();
        this.#redraw();
        return;
      }
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
    if (this.#editor.text.trim() === "") {
      this.#literalLead = undefined;
      this.#pasted = [];
    }
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

  /** § 5.2: a short paste is inserted as it is; a long one is folded under a compact reference, kept whole for sending. */
  #paste(text: string, uncertain: boolean): void {
    const o = this.#o.paste ?? { collapseThreshold: 2_000, maxChars: 500_000, detectHeuristic: true };
    if (text.length > o.maxChars) {
      this.notice("warning", `Contenu trop volumineux (${text.length} caractères) : joignez-le sous forme de fichier.`); // ERR-01, FA-01
      return;
    }
    const startsInput = this.#editor.text.trim() === "";
    let inserted = text;
    if (text.length > o.collapseThreshold) {
      const lines = text.split("\n").length;
      inserted = `[Texte collé n°${++this.#pasteCount} : ${lines} ligne${lines > 1 ? "s" : ""}, ${text.length} caractères]`;
      this.#pastes.set(inserted, text);
    }
    if (!this.#editor.insert(inserted)) {
      this.notice("warning", "Saisie trop longue.");
      return;
    }
    this.#pasted.push(text);
    // EF-09: a pasted `/` or `!` at the start stays text.
    if (startsInput && /^\s*[/!]/.test(text)) this.#literalLead = uncertain ? "uncertain" : "certain";
    if (containsSecret(text)) this.notice("warning", "Le texte collé semble contenir une valeur sensible : vérifiez-le avant l'envoi."); // § 12
    this.#assist.edited();
    this.#saveState();
  }

  /** The input with its folded pastes restored (CA-03). */
  #expanded(text: string): string {
    let out = text;
    for (const [ref, content] of this.#pastes) out = out.split(ref).join(content);
    return out;
  }

  /** EF-07: the folded pastes unfolded in the input, to be checked before sending. */
  #unfoldPastes(): void {
    const expanded = this.#expanded(this.#editor.text);
    if (expanded !== this.#editor.text) this.#editor.set(expanded);
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
      case "view.transcript":
        this.openTranscript();
        return;
      case "input.toggleModal":
        this.setModal(this.#modal === undefined); // EF-03, CA-06 of SPEC-IHM-013
        return;
      case "paste.interpret":
        // EF-09 of SPEC-IHM-010: the explicit action that lets a pasted line be a command or a shell line.
        this.#literalLead = undefined;
        return;
      case "paste.unfold":
        this.#unfoldPastes();
        break;
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
    if (this.#capture) {
      // A text for a dialog, never a message (SPEC-OUT-024 EF-04, SPEC-OUT-033 EF-01).
      const text = this.#editor.text;
      if (text.trim() === "" && !this.#capture.allowEmpty) return;
      this.#editor.set("");
      this.#capture.resolve(text);
      this.#saveState();
      return;
    }
    const typed = this.#editor.text;
    if (typed.trim() === "") return; // EF-06, CA-06
    const content = this.#expanded(typed);
    const literal = this.#literalLead;
    if (literal === "uncertain") {
      // CA-09 of SPEC-IHM-010: the origin is uncertain; executing as a command needs a confirmation.
      void this.confirm(`Cette ligne semble collée : « ${content.split("\n")[0]!.slice(0, 60)} ». L'exécuter comme commande ?`, "exécuter", "envoyer comme texte").then((yes) => {
        this.#literalLead = yes ? undefined : "certain";
        this.#submit();
      });
      return;
    }
    this.#assist.submitted(typed); // § 5.1 of SPEC-IHM-008: messages and commands are recorded
    const pasted = this.#pasted;
    this.#pasted = [];
    this.#literalLead = undefined;
    this.#pastes.clear();
    if (EXIT_COMMAND.test(content) && !literal) {
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
    w({ kind: "message", text: content, ...(literal ? { literal: true } : {}), ...(pasted.length > 0 ? { pasted } : {}) });
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
    if (this.#secret) panels.push(box([text(this.#secret.title), text("•".repeat(Math.min(60, [...this.#secret.value].length))), text("Entrée : valider · Échap : annuler")], { border: {}, padding: { left: 1, right: 1 } }));
    if (this.#choice) panels.push(this.#choiceView(this.#choice));
    if (this.#capture) panels.push(box([text([{ text: this.#capture.prompt, style: { bold: true } }]), text([{ text: "Entrée : valider · Échap : annuler", style: { dim: true } }])], { padding: { left: 2 } }));
    // SPEC-OUT-021 § 10: the task list above the input area, emptied once every task is done (§ 5.3 step 3).
    const tasks = this.#o.tasks?.() ?? [];
    if (tasks.length > 0 && tasks.some((t) => t.status !== "completed")) {
      const mark = (s: string) => (this.#view.unicode ? (s === "completed" ? "☑" : s === "in_progress" ? "◼" : "☐") : s === "completed" ? "[x]" : s === "in_progress" ? "[~]" : "[ ]");
      panels.push(
        box(
          tasks.map((t) =>
            text([{ text: `${mark(t.status)} `, style: t.status === "in_progress" ? { bold: true } : { dim: true } }, { text: (t.status === "in_progress" && t.progressLabel) || t.subject, style: t.status === "completed" ? { dim: true, strike: true } : t.status === "in_progress" ? { bold: true } : {} }], { overflow: "clip" }),
          ),
          { padding: { left: 2 } },
        ),
      );
    }
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
    if (this.#shellOutput !== undefined) {
      // SPEC-IHM-012 EF-04: the output as it comes, its last lines shown while it runs.
      const tail = this.#shellOutput.split("\n").slice(-30).join("\n");
      stream.push(box([text([{ text: tail, style: { dim: true } }], { overflow: "clip" })], { padding: { left: 2 } }));
    }
    if (this.#stream) {
      // § 5.2 of SPEC-IHM-003: the content being produced is rendered by its probable intention.
      if (this.#render && !this.#streamRenderer) this.#streamRenderer = new MarkdownRenderer(this.#render.markdown, this.#view.unicode);
      stream.push(modelView(this.#streamRenderer ? this.#streamRenderer.render(this.#stream) : this.#stream, this.#view));
    }
    if (this.running) stream.push(activityView(this.#activity, this.#now - this.#turnStarted, this.#spinner, this.#view));
    const frame = composeFrame(
      { stream: stream.length > 0 ? box(stream) : undefined, panels, input: this.#inputNode(size.columns, ctx), status: this.#statusNode() },
      size,
      { unicode: this.#view.unicode, minColumns: this.#o.settings.minColumns, retainedLines: this.#o.settings.retainedLines },
    );
    return { ...frame, lines: themeLines(frame.lines, this.#theme, size.columns, this.#o.capabilities.colors) };
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
    // SPEC-IHM-012 § 5.1, EF-03, CA-01: the shell mode is visible before any validation, by its prompt and its frame.
    const shell = this.shellLine;
    const prompt = spansToLines([{ text: shell ? "! " : this.#view.unicode === "full" ? "› " : "> ", style: shell ? { bold: true, fg: { ansi: 5 } } : { bold: true } }])[0]!;
    const indent: Cell[] = spansToLines([{ text: "  " }])[0]!;
    const rows = lines.map((l, i) => [...(i === 0 ? prompt : indent), ...l]);
    const extra: string[] = [];
    if (this.#modal) extra.push(this.#modal.label()); // EF-01: always visible, as a text
    if (shell) extra.push(`Mode shell : la ligne est exécutée par ${this.#o.shell!.label} ; elle n'est pas envoyée au modèle.`);
    if (this.#literalLead === "certain") extra.push("Texte collé : il sera envoyé comme texte (Ctrl+O : l'interpréter comme commande).");
    if (this.#pastes.size > 0) extra.push("Alt+P : déplier les textes collés pour les vérifier.");
    // EF-10 of SPEC-IHM-010: the attachments are visible before sending.
    const files = this.#o.attachments?.(this.#expanded(ed.text), this.#pasted) ?? [];
    if (files.length > 0) extra.push(`Pièces jointes à l'envoi : ${files.join(", ")}`);
    if (hidden > 0) extra.push(`${hidden} ligne${hidden > 1 ? "s" : ""} hors de la vue`);
    if (ed.text.length > this.#o.settings.inputWarnChars) extra.push(`${ed.text.length} caractères : risque de saturer le contexte`); // FA-02
    // FA-06, RG-02 of SPEC-IHM-007: a doubled trigger character is shown as it will be sent.
    const sent = shell || this.#literalLead ? undefined : this.#transformed(ed.text);
    if (sent !== undefined) extra.push(`Envoyé tel quel : ${sent.split("\n")[0]}`);
    const node = box([{ kind: "lines", lines: rows, cursor: cursor ? { row: cursor.row, col: cursor.col + 2 } : undefined }, ...extra.map((x) => text([{ text: x, style: { dim: true } }], { overflow: "clip" }))], {
      border: { style: shell ? { fg: { ansi: 5 } } : { dim: true } },
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
