// Supports: SPEC-CMD-005/010 (temporary aside and per-session input border), gap E-171.
// Supports: SPEC-MOD-029, SPEC-OUT-034/045, SPEC-IHM-002/023/038, gap E-161.
// Supports: SPEC-OBS-010, SPEC-IHM-039 (frame measurements and internal development bar), gap E-160.
// Implements: SPEC-MOD-001 (§ 5.2 steps 2 to 7, § 5.4 states, FA-01, FA-02, FA-04, EF-02, EF-03, EF-05, EF-06, ERR-03, CA-01, CA-02, CA-03), SPEC-IHM-007 (§ 5.4, § 5.5, § 5.6, FA-01, FA-02, FA-05, EF-04 to EF-07, CA-01, CA-03, CA-06, CA-07, CA-12), SPEC-IHM-011 (§ 5.1 to § 5.5, EF-01 to EF-05, EF-07, ERR-01, ERR-02, CA-01 to CA-06), SPEC-IHM-027 (§ 5.1, § 5.3, FA-01, EF-01 to EF-04, RG-01, CA-01, CA-02)
// The interactive application: input area, conversation flow, temporary panels, status line. It turns keys into actions,
// keeps the draft, the queue of messages and the stashed drafts, shows the permission dialog in a fixed zone, and hands
// the messages to the session one at a time.
// Supports: SPEC-IHM-038 (EF-03, CA-02: no waiting animation in reduced motion).
// Supports: SPEC-AGT-017 (CA-02), SPEC-AGT-018 (CA-01), gap E-147.
// Supports: SPEC-IHM-028 (CA-01/02, passive task dialogs), gap E-148.
// Supports: SPEC-IHM-022 (CA-01/02, current task and reduced motion), gap E-148.
// Supports: SPEC-IHM-019 (CA-01/02, choices and preview), SPEC-IHM-020 (CA-02), SPEC-CMD-072 (CA-01), SPEC-IHM-005 (CA-07), SPEC-MOD-001 (CA-06), gap E-142.

import type { Terminal } from "../platform/terminal";
import type { ImagePart } from "../providers/types";
import type { PreparedImage } from "../tools/image-resize";
// Supports: SPEC-IHM-015/016/017/018/021/024/034, SPEC-IHM-005 CA-05, SPEC-INT-019, gap E-159.
import { buildFlag, buildProfile } from "../extension-points/build-flags" with { type: "macro" };
import { matchQuality } from "./completion";
import type { FileMatch } from "./file-browser";
import { highlight, DEFAULT_CODE_THEME } from "../ui/highlight";
import type { ApprovalRequest, HumanAnswer, HumanApprovalChannel } from "../permissions/resolver";
import type { EngineEvent } from "../engine/events";
import { keywordRanges } from "../engine/max-keyword";
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
import { activityView, connectorResultView, interruptionView, modelView, noticeView, toolCallView, toolResultView, userView, type ViewContext } from "./views";

export interface AppSettings {
  readonly slowFrameMs?: number;
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
export type Entry = { readonly kind: "message"; readonly text: string; readonly literal?: boolean; readonly pasted?: readonly string[]; readonly images?: readonly ImagePart[] } | { readonly kind: "exit" };

interface Choice {
  readonly label: string;
  readonly answer: () => HumanAnswer | "explain" | "explain_command";
}

interface PendingApproval {
  deletionConfirmed?: boolean;
  readonly request: ApprovalRequest;
  readonly resolve: (a: HumanAnswer) => void;
  shownAt: number;
  selected: number;
  scope: number;
  explaining?: Editor;
  explanation?: string;
  explanationLoading?: boolean;
  explanationController?: AbortController;
}

/** Answer of a choice dialog (SPEC-OUT-033 § 5.3, SPEC-OUT-024 § 5.3 step 3). */
export type ChoiceAnswer = { readonly kind: "options"; readonly labels: readonly string[] } | { readonly kind: "other"; readonly text: string } | { readonly kind: "cancelled" };

interface ChoiceDialog {
  readonly secondary?: (index: number) => Promise<void>;
  readonly liveFilter?: boolean;
  readonly filterDelayMs?: number;
  readonly previewText?: (index: number) => { text: string; language: string } | undefined;
  filterTimer?: ReturnType<typeof setTimeout>;
  // Supports: SPEC-SES-009 (CA-03, filtering without sending the query to the model), gap E-149.
  readonly interruptible?: boolean;
  readonly title: string;
  readonly header?: string;
  options: ReadonlyArray<{ readonly label: string; readonly description?: string; readonly disabledReason?: string }>;
  readonly filter?: (query: string) => ChoiceDialog["options"];
  query: string;
  filtering: boolean;
  readonly preview?: (index: number) => void;
  readonly multiple: boolean;
  /** A free answer is offered as the last option (EF-01 of SPEC-OUT-033). */
  readonly other: boolean;
  selected: number;
  previewOffset: number;
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
  readonly interruptible?: boolean;
  readonly message: string;
  readonly yes: string;
  readonly no: string;
  readonly resolve: (yes: boolean) => void;
  readonly shownAt: number;
}

const RULE_SCOPES = ["session", "local", "project", "user"] as const;
/** SPEC-CMD-023: the exit command, effective even during a turn. */
export const EXIT_COMMAND = /^\s*\/(exit|quit)\s*$/;
export function principalElement(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return;
  for (const key of ["command", "path", "filePath", "pattern", "url", "query"]) { const value = (input as Record<string, unknown>)[key]; if (typeof value === "string") return value; }
  return;
}
const SCOPE_LABEL: Readonly<Record<(typeof RULE_SCOPES)[number], string>> = { session: "session", local: "projet (local)", project: "projet (partagé)", user: "utilisateur" };

export interface AppOptions {
  readonly hyperlinks?: import("../ui/hyperlinks").Hyperlinks;
  readonly browserTakeover?: () => void;
  readonly voice?:{enabled:()=>boolean;indicator:()=>string;key:(phase:KeyEvent["phase"],available:boolean)=>void;cancel:()=>void};
  readonly beforeExit?: () => Promise<void>;
  /** A narrowly authorized local toggle may be consumed even while a model turn runs. */
  readonly immediateCommand?: (content: string) => boolean;
  readonly autonomousStatus?: () => string | undefined;
  readonly brief?: () => boolean;
  readonly externalEditor?: (draft: string) => Promise<string | undefined>;
  readonly messageActions?: { readonly enabled: boolean; readonly copy: (text: string) => Promise<boolean>; readonly edit?: (item: TranscriptItem) => Promise<void> };
  readonly terminalPanel?: () => Promise<void>;
  readonly footer?: () => { readonly spans: readonly Span[]; readonly padding: number } | undefined;
  readonly inputDecoration?: (columns:number) => readonly string[];
  readonly onDecorativeTurnEnd?: (success:boolean) => void;
  readonly developmentBar?: () => string | undefined;
  readonly fileBrowser?: { readonly matches: (query: string, global: boolean) => FileMatch[]; readonly debounceMs: number; readonly open?: (match: FileMatch) => Promise<void> };
  readonly historyBrowser?: boolean;
  readonly maxKeyword?: () => { keyword: string; supported: boolean } | undefined;
  // Supports: SPEC-IHM-036 (CA-01, pending decision), gap E-150.
  readonly onApprovalWaiting?: (waiting: boolean) => void;
  readonly onFocus?: (focused: boolean) => void;
  readonly onActivity?: () => void;
  readonly onTurnEnd?: () => void;
  readonly survey?: { prompt: () => string | undefined; key: (key: { name: string; alt?: boolean; ctrl?: boolean; text?: string }) => boolean };
  readonly teammateView?: () => { readonly name: string; readonly lines: readonly string[] } | undefined;
  readonly sendToTeammate?: (text: string) => boolean;
  readonly leaveTeammate?: () => void;
  readonly autoTheme?: () => boolean;
  readonly onAppearance?: (light: boolean) => void;
  readonly reducedMotion?: boolean;
  readonly screenReader?: boolean;
  readonly tips?: boolean;
  readonly terminal: Terminal;
  readonly capabilities: Capabilities;
  readonly settings: AppSettings;
  /** Mode, model and other facts of the status line. */
  readonly status: () => { readonly mode: string; readonly model: string; readonly scheduled?: string; readonly ide?:string; readonly remote?:string; readonly forge?:string; readonly fast?:string };
  readonly cycleMode?: () => void;
  /** Background tasks still running, stopped by the exit (SPEC-CMD-023 CA-01). */
  readonly backgroundTasks?: () => number;
  /** Supports: SPEC-AGT-017 CA-02, SPEC-AGT-018 CA-01, gap E-147. */
  readonly canBackground?: () => boolean;
  readonly backgroundCurrent?: () => string | undefined;
  readonly openBackgroundTasks?: () => Promise<void>;
  readonly backgroundActivity?: () => readonly { readonly id: string; readonly agentType?: string; readonly color?: number; readonly activity?: string; readonly toolCalls?: number; readonly tokens?: number }[];
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
  readonly clipboardImage?: { readonly enabled: () => boolean; readonly read: () => Promise<PreparedImage | undefined>; readonly maxCount: number; readonly maxBytes: number };
  /** Rich text of the answers (SPEC-IHM-003, SPEC-IHM-004) and differences of the changes (SPEC-IHM-005). */
  readonly render?: { readonly markdown: MarkdownOptions; readonly diff: DiffOptions };
  readonly theme?: Theme;
  readonly clock?: () => number;
  readonly scheduler?: Scheduler;
}

export class InteractiveApp {
  #voiceProtocol=false;
  /** Dictation is staged as literal human text, never interpreted as a slash or shell command. */
  insertDictation(value:string,autoSubmit=false):void{
    if(this.#exiting||this.humanDialogActive)return;
    this.#editor.insert(value);this.#literalLead="certain";this.#saveState();this.#redraw();if(autoSubmit)this.#submit();
  }
  setVoiceProtocol(enabled:boolean):void{
    if(enabled===this.#voiceProtocol||enabled&&this.#exiting)return;
    this.#voiceProtocol=enabled;this.#o.terminal.write(enabled?"\u001b[>3u":"\u001b[<u");
  }
  #suggestion = "";
  #sessionColor?: number;
  #aside?: { text: string; close: () => void; title:string };
  setSessionColor(color: number | undefined): void { this.#sessionColor = color; this.#redraw(); }
  showAside(value: string, close: () => void, title="Question annexe"): void { this.#aside = { text: maskSecrets(value), close,title }; this.#redraw(); }
  /** A suggestion is staged only in an empty, idle input; Tab accepts it without sending. */
  setSuggestion(value: string): void { if (!value || !this.running && !this.autonomousInputBusy) { this.#suggestion = maskSecrets(value); this.#redraw(); } }
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
  #nextItemId = 0;
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
  #externalEditing = false;
  readonly #statusNotices = new Map<string, string>();
  #secret: { title: string; value: string; resolve: (value: string | undefined) => void } | undefined;
  #choice: ChoiceDialog | undefined;
  #capture: Capture | undefined;
  #session: TerminalSession | undefined;
  #unsubscribeInput: (() => void) | undefined;
  #unsubscribeResize: (() => void) | undefined;
  #developmentTimer?: ReturnType<typeof setInterval>;
  #appearanceTimer?: ReturnType<typeof setInterval>;
  #waiting: ((e: Entry) => void) | undefined;
  #turn: AbortController | undefined;
  #turnStarted = 0;
  #activity = "Réflexion…";
  #tokenGoal = "";
  #spinner = 0;
  #tipTimer?: ReturnType<typeof setTimeout>;
  #tip?: string;
  readonly #shownTips = new Set<string>();
  #animation: ReturnType<typeof setInterval> | undefined;
  #decorationTimer:ReturnType<typeof setInterval>|undefined;
  #stream = "";
  /** Renderer of the response being produced: its finished blocks are not parsed again (ENF-02 of SPEC-IHM-003). */
  #streamRenderer: MarkdownRenderer | undefined;
  /** Pasted contents folded in the input, by their compact reference (SPEC-IHM-010 § 5.2). */
  readonly #pastes = new Map<string, string>();
  #pasteCount = 0;
  /** Texts pasted in the current input (EF-10). */
  #pasted: string[] = [];
  readonly #images: PreparedImage[] = [];
  #readingImage = false;
  /** The input starts with a pasted `/` or `!`: it stays text (EF-09); `uncertain`: detected by the heuristic only. */
  #literalLead: "certain" | "uncertain" | undefined;
  /** Output of the shell command running (SPEC-IHM-012 EF-04). */
  #shellOutput: string | undefined;
  #shellCommand = "";
  /** The text of the current response was committed before its end (by a call of a tool). */
  #responseCommitted = false;
  #lastAddressed = "";
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
    if (this.#o.screenReader) return;
    const shape = !this.#modal ? "" : this.#modal.mode === "insert" ? "\u001b[6 q" : "\u001b[2 q";
    if (shape === this.#cursorShape) return;
    this.#o.terminal.write(shape || "\u001b[0 q");
    this.#cursorShape = shape;
  }

  /** An item of the transcript; its sensitive values are masked as in the flow (EF-06 of SPEC-IHM-006). */
  record(kind: ItemKind, title: string, body: string, metadata: { primary?: string; recordId?: string; selectable?: boolean } = {}): void {
    if (kind === "user") this.#turnNumber++;
    this.#items.push({ id: ++this.#nextItemId, kind, title: maskSecrets(title), body: maskSecrets(body), at: this.#now, turn: this.#turnNumber, ...metadata, primary: metadata.primary === undefined ? undefined : maskSecrets(metadata.primary) });
    this.#transcriptView?.refresh(); // FA-01: the items of the session in progress come at the bottom
  }

  get transcriptItems(): readonly TranscriptItem[] {
    return this.#items;
  }
  markCompacted(): void { for (let i = 0; i < this.#items.length; i++) this.#items[i] = { ...this.#items[i]!, selectable: false }; }

  /** Supports: SPEC-IHM-017. Called only after the archived branch has been committed. */
  restoreUserDraft(item: TranscriptItem, draft: string): void {
    const index = this.#items.findIndex(candidate => candidate.id === item.id);
    if (index >= 0) this.#items.splice(index);
    this.#editor.set(draft); this.#saveState(); this.#redraw();
  }
  /** Implements: SPEC-IHM-024 CA-01; these notices are removed by resolution, not elapsed time. */
  setStatusNotice(key: string, message: string | undefined): void { if (message) this.#statusNotices.set(key, maskSecrets(message)); else this.#statusNotices.delete(key); this.#redraw(); }

  async editDraft(): Promise<void> {
    if (!this.#o.externalEditor || this.humanDialogActive || this.#capture || this.#externalEditing) return;
    await this.#withEditor(async () => { const value = await this.#o.externalEditor!(this.#editor.text); if (value !== undefined) this.#editor.set(value); });
  }
  async #withEditor(action: () => Promise<void>): Promise<void> {
    if (this.#externalEditing) return;
    this.#externalEditing = true;
    this.#o.voice?.cancel();const voiceProtocol=this.#voiceProtocol;this.setVoiceProtocol(false);
    this.#session?.screen.suspend(); this.#o.terminal.setRawMode(false);
    try { await action(); }
    catch (error) { this.notice("warning", `Éditeur externe : ${(error as Error).message}. Brouillon conservé.`); }
    finally { this.#externalEditing = false; if (!this.#exiting) { this.#o.terminal.setRawMode(true);if(voiceProtocol&&this.#o.voice?.enabled())this.setVoiceProtocol(true); this.#session?.screen.resume(); this.#saveState(); this.#redraw(); } }
  }

  /** Implements: SPEC-IHM-041. Input and display ownership are lent to the native tmux client. */
  async openTerminalPanel(): Promise<void> {
    if (!buildFlag("ui_embedded_terminal") || !this.#o.terminalPanel || this.humanDialogActive || this.#capture || this.#externalEditing || this.#transcriptView || this.#exiting) return;
    this.#externalEditing = true;
    this.#o.voice?.cancel(); const voiceProtocol = this.#voiceProtocol; this.setVoiceProtocol(false);
    this.#session?.screen.suspend();
    this.#unsubscribeInput?.(); this.#unsubscribeInput = undefined;
    this.#o.terminal.setRawMode(false);
    try { await this.#o.terminalPanel(); }
    catch (error) { this.notice("warning", `Panneau terminal : ${(error as Error).message}`); }
    finally {
      this.#externalEditing = false;
      if (!this.#exiting) {
        this.#o.terminal.setRawMode(true);
        this.#unsubscribeInput = this.#o.terminal.onInput(data => this.#input(data));
        if (voiceProtocol && this.#o.voice?.enabled()) this.setVoiceProtocol(true);
        this.#session?.screen.resume(); this.#saveState(); this.#redraw();
      }
    }
  }

  /** Implements: SPEC-IHM-015/018. A local selector never sends its inserted reference. */
  async openFiles(global = false): Promise<void> {
    if (!buildFlag("ui_fast_find")) return;
    const source = this.#o.fileBrowser; if (!source || this.humanDialogActive || this.#capture) return;
    let matches: FileMatch[] = [];
    const label = (match: FileMatch) => `${match.path}${match.line ? `:${match.line}` : ""}`;
    const filter = (query: string) => { matches = source.matches(query, global); return matches.map(match => ({ label: label(match) })); };
    const selected = await this.choose(global ? "Recherche globale" : "Ouverture rapide", filter(""), { interruptible: true, other: false, liveFilter: true, filter, filterDelayMs: global ? source.debounceMs : 0, previewText: index => matches[index] ? { text: matches[index]!.preview, language: matches[index]!.language } : undefined, secondary: source.open ? async index => { const match = matches[index]; if (match) await this.#withEditor(() => source.open!(match)); } : undefined });
    if (selected.kind !== "options") return;
    const match = matches.find(match => label(match) === selected.labels[0]); if (!match) return;
    const path = /\s/.test(match.path) ? JSON.stringify(match.path) : match.path;
    this.#editor.insert(`${this.#editor.text && !/\s$/.test(this.#editor.text.slice(0, this.#editor.caret)) ? " " : ""}@${path}${match.line ? `:${match.line}` : ""} `);
    this.#saveState(); this.#redraw();
  }

  /** Implements: SPEC-IHM-016. Dates and one-line previews; cancellation preserves the draft. */
  async openHistory(): Promise<void> {
    if (!buildFlag("ui_history_browser")) return;
    const entries = this.#o.history?.entries() ?? [], initial = this.#editor.text.slice(0, 64);
    const label = (index: number) => `${new Date(entries[index]!.at).toLocaleString("fr-FR")} — ${entries[index]!.text.replace(/\s+/g, " ").slice(0, 100)} [${index + 1}]`;
    const filter = (query: string) => entries.flatMap((entry, index) => matchQuality(query, entry.text.slice(0, 500), true) === undefined ? [] : [{ label: label(index) }]);
    const selected = await this.choose("Filtrer mes saisies", filter(initial), { interruptible: true, other: false, liveFilter: true, initialQuery: initial, filter });
    if (selected.kind === "options") { const index = entries.findIndex((_, index) => label(index) === selected.labels[0]); if (index >= 0) { this.#editor.set(entries[index]!.text); this.#saveState(); this.#redraw(); } }
  }

  get transcriptOpen(): boolean {
    return this.#transcriptView !== undefined;
  }

  /** § 5.1: the view opens over the session, which goes on behind it (EF-05, CA-04). */
  openTranscript(): void {
    if (this.#o.screenReader) { for (const item of this.#items) this.commit(text(`${item.title}\n${item.body}`)); return; }
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
      actions: this.#o.messageActions ? { ...this.#o.messageActions, copy: async source => {
        let success = false; try { success = await this.#o.messageActions!.copy(source); } catch {}
        if (!success) { this.#transcriptView?.close(); this.notice("warning", "Copie indisponible : texte à copier ci-dessous."); this.commit(box([text(source)], { padding: { left: 2 } })); }
        return success;
      }, edit: async item => {
        if (this.running || this.humanDialogActive || !this.#o.messageActions?.edit) { this.notice("warning", "Attendez la fin du tour pour reprendre un message."); return; }
        if (await this.confirm("Reprendre la conversation avant ce message et le modifier ? Les échanges suivants restent dans l’archive.", "reprendre", "annuler")) {
          try { await this.#o.messageActions.edit(item); }
          catch (error) { this.notice("warning", (error as Error).message); }
        }
      } } : undefined,
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

  get modalEnabled(): boolean { return this.#modal !== undefined; }

  get exiting(): boolean { return this.#exiting; }
  get humanDialogActive(): boolean { return !!(this.#confirm || this.#choice || this.#secret || this.#approvals.length); }
  get autonomousInputBusy(): boolean { return this.humanDialogActive || !!this.#capture || this.#externalEditing || this.#readingImage || !this.#editor.isEmpty; }
  #lastInteractionAt = Date.now();
  get lastInteractionAt(): number { return this.#lastInteractionAt; }

  get queue(): readonly string[] {
    return this.#queue;
  }

  prefillLink(value:string):void{this.#editor.set(value);this.#saveState();this.#redraw();}

  get draft(): string {
    return this.#editor.text;
  }

  /** Takes over the terminal and draws the input area (step 2 of § 5.2). */
  start(): void {
    this.#session = openTerminalSession(this.#o.terminal, {
      capabilities: this.#o.capabilities,
      maxFramesPerSecond: this.#o.settings.maxFramesPerSecond,
      slowFrameMs: this.#o.settings.slowFrameMs,
      sequential: this.#o.screenReader,
      focusReporting: this.#o.capabilities.bracketedPaste,
      source: (size) => {const frame=this.#frame(size);return this.#o.hyperlinks?.frame(frame)??frame;},
      scheduler: this.#o.scheduler,
    });
    this.#unsubscribeInput = this.#o.terminal.onInput((data) => this.#input(data));
    this.#unsubscribeResize = this.#o.terminal.onResize(() => this.#transcriptView?.resized());
    this.#updateCursorShape();
    this.#session.screen.flush();
    if (this.#o.onAppearance && !this.#o.screenReader) { this.#queryAppearance(); this.#appearanceTimer = setInterval(() => this.#queryAppearance(), 5000); }
    if (buildFlag("ui_dev_bar") && buildProfile() !== "public" && this.#o.developmentBar) this.#developmentTimer = setInterval(() => this.#redraw(), 500);
    if(this.#o.inputDecoration&&!this.#o.reducedMotion&&!this.#o.screenReader)this.#decorationTimer=setInterval(()=>this.#redraw(),500);
  }

  /** Replays input captured after startup consent once the ordinary input consumer is installed. */
  get renderStats() { return this.#session?.screen.stats; }
  acceptStartupInput(chunks: readonly string[]): void { for (const chunk of chunks) this.#input(chunk); }

  /** Restores the terminal; idempotent. */
  stop(): void {
    this.#o.voice?.cancel();this.setVoiceProtocol(false);
    if (this.#tipTimer) clearTimeout(this.#tipTimer); this.#tipTimer = undefined;
    this.#exiting = true;
    clearInterval(this.#developmentTimer); this.#developmentTimer = undefined;
    clearInterval(this.#appearanceTimer); this.#appearanceTimer = undefined;
    clearInterval(this.#decorationTimer);this.#decorationTimer=undefined;
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

  /** Supports: SPEC-PLA-005 CA-01: automatic input preserves the human draft and ordinary turn permissions. */
  enqueueScheduled(content: string): boolean {
    if (this.#queue.length >= this.#o.settings.queueMax) return false;
    if (!this.running && this.#waiting && !this.#capture) { const resolve = this.#waiting; this.#waiting = undefined; resolve({ kind: "message", text: content, literal: true }); }
    else this.#queue.push(content);
    this.#redraw(); return true;
  }

  /** Recovery of one interrupted message does not release the saved queue (gap E-132). */
  setQueueHeld(held: boolean): void { this.#queueHeld = held; }
  /** Implements: SPEC-MOT-008 (CA-03); a declined immediate send returns every queued message to the editable input. */
  restoreInterruptedQueue(): void {
    const messages = this.#queue.splice(0);
    if (!messages.length) return;
    this.#editor.set([...messages, ...(this.#editor.text ? [this.#editor.text] : [])].join("\n\n"));
    this.#saveState(); this.#redraw();
  }

  // ---- Turn ----------------------------------------------------------------------------------------------------

  /** A turn starts: the input area stays usable (EF-07 of SPEC-IHM-007); an interruption aborts `controller`. */
  beginTurn(controller: AbortController): void {
    this.#tip = undefined; if (this.#tipTimer) clearTimeout(this.#tipTimer);
    if (this.#o.tips !== false) this.#tipTimer = setTimeout(() => {
      this.#tipTimer = undefined; if (!this.running || this.#o.screenReader) return;
      for (const [action, label] of [["view.transcript", "consulter la transcription"], ["app.interrupt", "interrompre le tour"]]) {
        const combo = this.#keymap.effective(action!)[0]; if (!combo || this.#shownTips.has(action!)) continue;
        this.#shownTips.add(action!); this.#tip = `Astuce : ${comboLabel(combo)} pour ${label}.`; this.#redraw(); break;
      }
    }, 600);
    this.#tokenGoal = "";
    this.#turn = controller;
    this.#turnStarted = this.#now;
    this.#activity = "Réflexion…";
    this.#stream = "";
    this.#responseCommitted = false;
    this.#lastAddressed = "";
    if (!this.#o.reducedMotion && !this.#o.screenReader) this.#animation = setInterval(() => {
      this.#spinner++;
      this.#redraw();
    }, 120);
    this.#redraw();
  }

  /** The turn is over: what remains of the response is committed; the interruption leaves its marker (FA-01). */
  endTurn(outcome: { readonly stopCause: string; readonly message?: string }): void {
    this.#o.onDecorativeTurnEnd?.(outcome.stopCause==="completed");
    if (this.#tipTimer) clearTimeout(this.#tipTimer); this.#tipTimer = undefined;
    this.#stopAnimation();
    this.#flushStream();
    this.#turn = undefined;
    if (outcome.stopCause === "interrupted") {
      this.commit(interruptionView(this.#view));
      this.record("marker", "Interrompu par l'utilisateur", "");
    }
    else if (outcome.stopCause === "error") this.notice("error", `Le tour a échoué : ${outcome.message ?? "erreur inconnue"}.`); // ERR-03
    else if (outcome.stopCause !== "completed" && outcome.message) this.notice("warning", outcome.message);
    this.#redraw(); this.#o.onTurnEnd?.();
  }

  /** Engine events of the turn, displayed as they arrive (ENF-01: the first character as soon as it is received). */
  onEngineEvent(e: EngineEvent): void {
    switch (e.type) {
      case "addressed_message":
        this.#lastAddressed = e.message; this.commit(modelView(e.message, this.#view)); this.record("model", e.status === "proactive" ? "Initiative" : "Message", e.message);
        for (const attachment of e.attachments) this.notice("info", `Pièce jointe : ${attachment.name}`);
        break;
      case "notification":
        this.notice("info", `Notification : ${e.message}`); break;
      case "token_goal":
        this.#tokenGoal = ` · ${e.consumed} / ${e.goal} jetons`;
        this.#redraw(); break;
      case "user_message": {
        if (e.synthetic) break;
        const texts = e.content.flatMap((p) => (p.type === "text" ? [p.text] : []));
        const attached = texts.filter((t) => t.startsWith("<attached-file "));
        const content = texts.filter((t) => !t.startsWith("<attached-file ")).join("\n");
        if (content) this.commit(userView(content, this.#view));
        this.record("user", "", [content, ...attached.map((a) => `[pièce jointe ${/path="([^"]*)"/.exec(a)?.[1] ?? "?"}]`)].filter(Boolean).join("\n"), { recordId: e.recordId });
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
        this.#transcriptView?.newContent();
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
        if (!this.#o.brief?.() || (e.toolCalls.length === 0 && e.text.trim() && e.text.trim() !== this.#lastAddressed.trim())) this.#flushStream(e.text);
        else { this.#stream = ""; this.#streamRenderer = undefined; }
        if (this.#thinking.trim()) this.record("thinking", "", this.#thinking.trim());
        this.#thinking = "";
        if (e.text.trim()) this.record("model", "", e.text.trim());
        break;
      case "tool_call":
        this.#flushStream();
        this.#callNames.set(e.callId, e.name);
        this.#activity = `${e.name}…`;
        if (!this.#o.brief?.()) this.commit(toolCallView(e.name, this.#o.describeCall(e.name, e.input), this.#view));
        this.record("tool", `${e.name}  ${this.#o.describeCall(e.name, e.input)}`, JSON.stringify(e.input ?? {}, null, 2), { primary: principalElement(e.input) });
        break;
      case "tool_result":
        // EF-06 of SPEC-IHM-006: a sensitive value is masked in the flow as in the view.
        if (!this.#o.brief?.() || e.isError) this.commit(e.display && !e.isError ? connectorResultView(maskSecrets(e.display)) : toolResultView(maskSecrets(e.output), e.isError, this.#view));
        this.record("result", `${this.#callNames.get(e.callId) ?? "outil"}${e.isError ? " (erreur)" : ""}`, e.output + (e.displayRaw ? `\n\nStructure brute (valeurs sensibles masquées) :\n${maskSecrets(e.displayRaw)}` : ""));
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
        this.markCompacted();
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
    if (this.#o.brief?.() && final === undefined) { this.#stream = ""; this.#streamRenderer = undefined; return; }
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
    const lines=themeLines(layoutNode(node, columns, this.#ctx(columns)).lines, this.#theme, columns, this.#o.capabilities.colors);
    this.#session.screen.commit(this.#o.hyperlinks?lines.map(line=>this.#o.hyperlinks!.line(line)):lines);
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
        if (this.#choice?.interruptible) this.#choice.resolve({ kind: "cancelled" });
        if (this.#confirm?.interruptible) this.#confirm.resolve(false);
        let settled = false;
        const onAbort = () => pending.resolve({ answer: "no_stop" });
        const pending: PendingApproval = {
          request,
          resolve: (a) => {
            if (settled) return;
            settled = true;
            pending.explanationController?.abort();
            signal.removeEventListener("abort", onAbort);
            const i = this.#approvals.indexOf(pending);
            if (i !== -1) this.#approvals.splice(i, 1);
            if (this.#approvals[0]) this.#approvals[0].shownAt = this.#now;
            this.#o.onApprovalWaiting?.(this.#approvals.length > 0);
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
        this.#o.onApprovalWaiting?.(true);
        this.#session?.screen.flush();
      }),
  };

  #choices(p: PendingApproval): Choice[] {
    if (p.deletionConfirmed) return [{ label: "Confirmer la suppression", answer: () => ({ answer: "yes" }) }, { label: "Non", answer: () => ({ answer: "no" }) }];
    const rule = p.request.suggestions[0];
    const scope = RULE_SCOPES[p.scope]!;
    return [
      { label: "Oui", answer: () => ({ answer: "yes" }) },
      ...(rule ? [{ label: `Oui, et ne plus demander pour ${rule} (portée : ${SCOPE_LABEL[scope]} ; Tab pour changer)`, answer: (): HumanAnswer => ({ answer: "yes_always", scope, rule }) }] : []),
      { label: "Non", answer: () => ({ answer: "no" }) },
      { label: "Non, et dire quoi faire autrement", answer: () => "explain" },
      { label: "Non, et arrêter le tour", answer: () => ({ answer: "no_stop" }) },
      ...(p.request.explain ? [{ label: "Expliquer cette commande", answer: () => "explain_command" as const }] : []),
    ];
  }

  #dialogView(p: PendingApproval): Node {
    const r = p.request;
    const danger = r.danger !== undefined;
    const t = tone(danger ? "error" : "warning", this.#view.unicode);
    const count = this.#approvals.length > 1 ? ` (1/${this.#approvals.length})` : "";
    const rows: Node[] = [text([{ text: r.toolName, style: { bold: true } }, { text: ` : ${r.summary}` }])];
    if (this.#isDeletion(p)) rows.unshift(text(p.deletionConfirmed ? `Confirmer la suppression : ${r.change!.path}` : `Suppression : ${r.change!.path}`, { overflow: "clip" }));
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
    if (p.explanationLoading) rows.push(text("Explication en cours… La permission reste en attente."));
    if (p.explanation) rows.push(...p.explanation.split("\n").slice(0, 16).map(line => text(line)));
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
      else if (a === "explain_command") {
        if (!p.explanationLoading && p.request.explain) {
          p.explanationLoading = true;
          p.explanationController = new AbortController();
          void p.request.explain(p.explanationController.signal).then(value => { if (this.#approvals.includes(p)) p.explanation = value; }, () => { if (this.#approvals.includes(p)) p.explanation = "Explication indisponible."; }).finally(() => { if (this.#approvals.includes(p)) { p.explanationLoading = false; this.#redraw(); } });
        }
      }
      else if (a.answer.startsWith("yes") && this.#isDeletion(p) && !p.deletionConfirmed) { p.deletionConfirmed = true; p.selected = 1; p.shownAt = this.#now; }
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
  #isDeletion(p: PendingApproval): boolean {
    const change = p.request.change;
    return !!change && (change.before !== undefined || change.binary?.before !== undefined) && change.after === undefined && change.binary?.after === undefined;
  }

  /** A question with two answers, in a fixed panel (exit with work in progress, queue after an interruption). */
  /**
   * A question with options, entirely usable from the keyboard (EF-04 of SPEC-OUT-033): arrows, numbers, space to mark
   * with several answers, Enter to validate, Échap to give no answer; the last option is a free answer.
   */
  choose(title: string, options: ReadonlyArray<{ readonly label: string; readonly description?: string; readonly disabledReason?: string }>, o: { readonly multiple?: boolean; readonly header?: string; readonly other?: boolean; readonly selected?: number; readonly preview?: (index: number) => void; readonly interruptible?: boolean; readonly signal?: AbortSignal; readonly filter?: (query: string) => ChoiceDialog["options"]; readonly liveFilter?: boolean; readonly initialQuery?: string; readonly filterDelayMs?: number; readonly previewText?: ChoiceDialog["previewText"]; readonly secondary?: ChoiceDialog["secondary"] } = {}): Promise<ChoiceAnswer> {
    if (o.interruptible && this.#approvals.length > 0) return Promise.resolve({ kind: "cancelled" });
    if (this.#exiting || o.signal?.aborted) return Promise.resolve({ kind: "cancelled" });
    if (options.length === 0 && o.other === false && !o.filter) return Promise.resolve({ kind: "cancelled" });
    return new Promise((resolve) => {
      const abort = () => dialog.resolve({ kind: "cancelled" });
      const dialog: ChoiceDialog = {
        title,
        interruptible: o.interruptible,
        ...(o.header ? { header: o.header } : {}),
        options,
        filter: o.filter,
        liveFilter: o.liveFilter, filterDelayMs: o.filterDelayMs, previewText: o.previewText, secondary: o.secondary,
        query: o.initialQuery ?? "",
        filtering: false,
        multiple: o.multiple === true,
        other: o.other !== false,
        selected: Math.max(0, Math.min(o.selected ?? 0, options.length - 1)),
        previewOffset: 0,
        ...(o.preview ? { preview: o.preview } : {}),
        marked: new Set(),
        shownAt: this.#now,
        resolve: (answer) => {
          if (dialog.filterTimer) clearTimeout(dialog.filterTimer);
          o.signal?.removeEventListener("abort", abort);
          if (this.#choice === dialog) this.#choice = undefined;
          if (answer.kind !== "other" || answer.text !== "\u0000") {
            resolve(answer);
            this.#redraw();
            return;
          }
          // The free answer: typed in the input area.
          void this.editText(`${title} — votre réponse :`, "").then((text) => resolve(text === undefined ? { kind: "cancelled" } : { kind: "other", text }));
        },
      };
      this.#choice = dialog;
      o.signal?.addEventListener("abort", abort, { once: true });
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
    if (c.previewText && (e.name === "pageup" || e.name === "pagedown")) { c.previewOffset = Math.max(0, c.previewOffset + (e.name === "pagedown" ? 5 : -5)); this.#redraw(); return; }
    c.previewOffset = 0;
    if (e.ctrl && e.name === "g" && c.secondary && c.options[c.selected]) { c.resolve({ kind: "cancelled" }); void c.secondary(c.selected); return; }
    if (c.liveFilter && c.filter && (e.name === "backspace" || !!e.text && !e.ctrl && !e.alt)) {
      c.query = e.name === "backspace" ? [...c.query].slice(0, -1).join("") : (c.query + e.text).slice(0, 64);
      if (c.filterTimer) clearTimeout(c.filterTimer);
      const apply = () => { if (this.#choice !== c) return; c.filterTimer = undefined; c.options = c.filter!(c.query); c.selected = 0; this.#redraw(); };
      if (c.filterDelayMs) c.filterTimer = setTimeout(apply, c.filterDelayMs); else apply();
      this.#redraw(); return;
    }
    if (c.filter && (c.filtering || e.text === "#")) {
      if (!c.filtering && e.text === "#") c.query = "";
      if (e.name === "escape") return c.resolve({ kind: "cancelled" });
      if (e.name === "enter") c.filtering = false;
      else if (e.name === "backspace") c.query = c.query.slice(0, -1);
      else if (e.text && !e.ctrl && !e.alt && c.query.length < 64) { c.filtering = true; c.query += e.text; }
      else return;
      c.options = c.filter(c.query); c.selected = 0; c.marked.clear(); this.#redraw(); return;
    }
    const count = c.options.length + (c.other ? 1 : 0);
    const pick = (index: number) => {
      if (c.other && index === c.options.length) return c.resolve({ kind: "other", text: "\u0000" });
      if (!c.options[index]) return;
      if (c.options[index]?.disabledReason) { this.#redraw(); return; }
      if (c.multiple) {
        if (c.marked.has(index)) c.marked.delete(index);
        else c.marked.add(index);
        this.#redraw();
        return;
      }
      c.resolve({ kind: "options", labels: [c.options[index]!.label] });
    };
    if (count === 0 && e.name !== "escape" && action !== "dialog.refuse") return;
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
    if (labels.length === 0) lines.push(text(c.liveFilter ? "Aucune correspondance." : "Aucune session correspondante."));
    const hint = c.multiple ? "↑↓ · Espace : cocher · Entrée : valider · Échap : sans réponse" : "↑↓ ou chiffre · Entrée : choisir · Échap : sans réponse";
    return { kind: "render", render: (width, ctx) => {
      // Keep the selected entry visible; descriptions may wrap and consume more than one row.
      const preview = c.previewText?.(c.selected);
      const allPreviewLines = preview ? layoutNode(text(highlight(maskSecrets(preview.text), preview.language, this.#render?.markdown.highlight ?? { enabled: true, maxBytes: 262_144, timeoutMs: 20, theme: DEFAULT_CODE_THEME })), Math.max(1, width - 4), ctx).lines : [];
      c.previewOffset = Math.min(c.previewOffset, Math.max(0, allPreviewLines.length - 6));
      const previewLines = allPreviewLines.slice(c.previewOffset, c.previewOffset + 6);
      const room = Math.max(1, this.#o.terminal.rows - this.#o.settings.inputMinHeight - 8 - (c.filter ? 1 : 0) - (previewLines.length ? previewLines.length + 1 : 0));
      const heights = lines.map((line) => layoutNode(line, Math.max(1, width - 4), ctx).lines.length);
      let start = c.selected, end = start + 1, used = heights[start] ?? 1;
      while (end < lines.length && used + heights[end]! <= room) used += heights[end++]!;
      while (start > 0 && used + heights[start - 1]! <= room) used += heights[--start]!;
      const range = start > 0 || end < lines.length ? ` · options ${start + 1}–${end}/${lines.length}` : "";
      const previewNode: Node | undefined = previewLines.length ? { kind: "render", render: () => ({ lines: previewLines }) } : undefined;
      return layoutNode(box([text([...(c.header ? [{ text: `[${c.header}] `, style: { dim: true } }] : []), { text: c.title + range, style: { bold: true } }]), ...(c.filter ? [text(`Filtre : ${c.query || "(aucun)"}${c.liveFilter ? "" : c.filtering ? " — Entrée : appliquer" : " — # : étiquette"}`)] : []), ...lines.slice(start, end), ...(previewNode ? [text(`Aperçu : ligne ${c.previewOffset + 1}/${allPreviewLines.length} · Pg↑/Pg↓ pour relire`), previewNode] : []), text([{ text: hint, style: { dim: true } }])], { border: { style: t.style }, padding: { left: 1, right: 1 } }), width, ctx);
    } };
  }

  confirm(message: string, yes = "Oui", no = "Non", interruptible = false, signal?: AbortSignal): Promise<boolean> {
    if (this.#exiting || signal?.aborted || (interruptible && this.#approvals.length > 0)) return Promise.resolve(false);
    return new Promise((resolve) => {
      const abort = () => dialog.resolve(false);
      const dialog: Confirm = {
        interruptible,
        message,
        yes,
        no,
        shownAt: this.#now,
        resolve: (v) => {
          signal?.removeEventListener("abort", abort);
          if (this.#confirm === dialog) this.#confirm = undefined;
          resolve(v);
          this.#redraw();
        },
      };
      this.#confirm = dialog;
      signal?.addEventListener("abort", abort, { once: true });
      this.#session?.screen.flush();
    });
  }

  /** Separate masked buffer: a credential never enters the editor, history, queue or persisted input state. */
  requestSecret(title: string, signal?: AbortSignal): Promise<string | undefined> {
    if (this.#exiting || signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const abort = () => dialog.resolve(undefined);
      const dialog = { title, value: "", resolve: (value: string | undefined) => { signal?.removeEventListener("abort", abort); dialog.value = ""; if (this.#secret === dialog) this.#secret = undefined; resolve(value); this.#redraw(); } };
      this.#secret = dialog;
      signal?.addEventListener("abort", abort, { once: true });
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
    await this.#o.beforeExit?.();
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
    if (this.#externalEditing) return;
    this.#keys.enableAppearanceReports(this.#o.autoTheme?.() === true && !this.#o.screenReader);
    if (this.#transcriptView) {
      // RG-01 of SPEC-IHM-006: the view is read-only; Ctrl+C closes it without interrupting the session.
      const events = this.#keys.feed(data);
      if (data === "\u001b") events.push(...this.#keys.flush());
      for (const e of events) {
        if(e.kind==="key"&&e.phase==="release")continue;
        if (e.kind === "focus" || e.kind === "appearance") { this.#event(e); continue; }
        this.#lastInteractionAt = Date.now(); this.#o.onActivity?.();
        const global = e.kind === "key" ? this.#keymap.action(e, ["app"]) : undefined;
        if (!this.#transcriptView.modalActive && (global === "app.quickOpen" || global === "app.globalSearch")) { this.#transcriptView.close(); this.#event(e); continue; }
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

  #queryAppearance(): void { if (!this.#externalEditing && !this.#exiting && this.#o.autoTheme?.() && this.#o.capabilities.bracketedPaste) this.#o.terminal.write("\u001b]11;?\u001b\\"); }
  #event(e: InputEvent, uncertain = false): void {
    if (e.kind === "focus") { if(!e.focused)this.#o.voice?.cancel();this.#o.onFocus?.(e.focused); return; }
    if (e.kind === "appearance") { if (this.#o.autoTheme?.()) this.#o.onAppearance?.(e.light); return; }
    if(e.kind==="key"&&this.#keymap.action(e,["input","app"])==="voice.hold"&&this.#o.voice?.enabled()){
      this.#o.voice.key(e.phase,!this.humanDialogActive&&!this.#externalEditing);return;
    }
    if(e.kind==="key"&&e.phase==="release")return;
    if(e.kind==="key"&&this.#keymap.action(e,["app"])==="terminal.toggle"){void this.openTerminalPanel();return;}
    if(e.kind==="key"&&this.#keymap.action(e,["app"])==="browser.takeover"){this.#o.browserTakeover?.();return;}
    if(e.kind==="key")this.#o.voice?.cancel();
    this.#lastInteractionAt = Date.now();
    this.#o.onActivity?.();
    if (!this.running && !this.humanDialogActive && this.#o.survey?.key(e.kind === "key" ? e : { name: "paste" })) return;
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
    if (e.name === "escape" && !approval && !this.humanDialogActive && this.#aside) { this.#aside.close(); this.#aside = undefined; this.#redraw(); return; }
    if (e.name === "escape" && !approval && !this.humanDialogActive && this.#o.teammateView?.()) { this.#o.leaveTeammate?.(); this.#redraw(); return; }
    if (e.name === "tab" && !e.shift && !e.ctrl && !e.alt && !e.super && this.#suggestion && this.#editor.isEmpty && !this.running && !this.humanDialogActive && !this.#capture) { this.#editor.set(this.#suggestion); this.#suggestion = ""; this.#saveState(); this.#redraw(); return; }
    if (e.name !== "tab" || e.shift || e.ctrl || e.alt || e.super) this.#suggestion = "";
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
    if (action === "task.background") {
      try {
        const id = this.#o.backgroundCurrent?.();
        if (id) this.notice("info", `Commande transférée vers la tâche ${id}, sans redémarrage.`);
      } catch { this.notice("warning", "Transfert impossible : la commande reste au premier plan."); }
      this.#redraw(); return;
    }
    if (action === "task.panel") {
      if (!this.running && !this.#capture) void this.#o.openBackgroundTasks?.().catch(() => this.notice("warning", "Le panneau des tâches est indisponible."));
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

  /** An explicit paste only stages the image; a dialog or a closed session cannot receive a late clipboard result. */
  async pasteClipboardImage(): Promise<void> {
    const source = this.#o.clipboardImage;
    if (!source || this.#readingImage || this.humanDialogActive || this.#capture || this.#exiting) return;
    if (!source.enabled()) { this.notice("warning", "Le modèle actuel n’accepte pas les images."); return; }
    this.#readingImage = true;
    try {
      const image = await source.read();
      if (this.#exiting || this.humanDialogActive || this.#capture) return;
      if (!image) { this.notice("warning", "Aucune image accessible dans le presse-papiers local."); return; }
      if (this.#images.length >= source.maxCount || this.#images.reduce((bytes, image) => bytes + image.bytes.length, 0) + image.bytes.length > source.maxBytes) { this.notice("warning", "Limite des pièces jointes atteinte : l’image n’a pas été ajoutée."); return; }
      this.#images.push(image); this.#redraw();
    } catch { if (!this.#exiting) this.notice("warning", "Image du presse-papiers indisponible : format, taille ou accès non pris en charge."); }
    finally { this.#readingImage = false; }
  }

  #inputAction(e: KeyEvent, action: string | undefined): void {
    const ed = this.#editor;
    switch (action) {
      case "input.externalEditor": void this.editDraft(); return;
      case "clipboard.pasteImage": void this.pasteClipboardImage(); return;
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
      case "history.browser":
        if (this.#o.historyBrowser) void this.openHistory();
        return;
      case "app.quickOpen":
      case "app.globalSearch":
        if (!this.humanDialogActive && !this.#capture) void this.openFiles(action === "app.globalSearch");
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
    if (this.#images.length && (this.running || !this.#waiting)) { this.notice("info", "L’image et le brouillon sont conservés : envoyez-les après la fin du tour."); return; }
    const typed = this.#editor.text || (this.#images.length ? "Image jointe." : "");
    if (typed.trim() === "") return; // EF-06, CA-06
    const content = this.#expanded(typed);
    if (this.#o.teammateView?.() && this.#o.sendToTeammate?.(content)) { this.#editor.set(""); this.#pasted = []; this.#literalLead = undefined; this.#saveState(); this.#redraw(); return; }
    const literal = this.#images.length ? "certain" : this.#literalLead;
    if (literal === "uncertain") {
      // CA-09 of SPEC-IHM-010: the origin is uncertain; executing as a command needs a confirmation.
      void this.confirm(`Cette ligne semble collée : « ${content.split("\n")[0]!.slice(0, 60)} ». L'exécuter comme commande ?`, "exécuter", "envoyer comme texte").then((yes) => {
        this.#literalLead = yes ? undefined : "certain";
        this.#submit();
      });
      return;
    }
    this.#assist.submitted(content); // § 5.1 of SPEC-IHM-008: history restores the complete paste, not its visual marker
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
    if (!literal && this.running && this.#o.immediateCommand?.(content)) {
      this.#editor.set(""); this.#editor.breakGroup(); this.#saveState(); this.#redraw(); return;
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
    const images = this.#images.splice(0).map((image): ImagePart => ({ type: "image", mediaType: image.mediaType, dataBase64: image.bytes.toString("base64") }));
    w({ kind: "message", text: content, ...(literal ? { literal: true } : {}), ...(pasted.length > 0 ? { pasted } : {}), ...(images.length ? { images } : {}) });
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
    const teammate = this.#o.teammateView?.();
    if (this.#aside) panels.push(box([text(this.#aside.title+" · Échap : fermer"), text(this.#aside.text)], { border: {}, padding: { left: 1, right: 1 } }));
    if (teammate) panels.push(box([text(`Vue du coéquipier ${teammate.name} — saisie adressée à ${teammate.name} · Échap : chef`), ...teammate.lines.slice(-8).map(line => text(maskSecrets(line)))], { border: {} }));
    const notices = [...this.#statusNotices.values()];
    if (notices.length) panels.push(box([text(`Avis : ${notices.slice(0, 3).join(" · ")}${notices.length > 3 ? ` · ${notices.length - 3} autres` : ""}`, { overflow: "clip" })], { padding: { left: 2 } }));
    const approval = this.#approvals[0];
    if (approval) panels.push(this.#dialogView(approval));
    if (this.#confirm) panels.push(this.#confirmView(this.#confirm));
    if (this.#secret) panels.push(box([text(this.#secret.title), text("•".repeat(Math.min(60, [...this.#secret.value].length))), text("Entrée : valider · Échap : annuler")], { border: {}, padding: { left: 1, right: 1 } }));
    if (this.#choice) panels.push(this.#choiceView(this.#choice));
    if (this.#capture) panels.push(box([text([{ text: this.#capture.prompt, style: { bold: true } }]), text([{ text: "Entrée : valider · Échap : annuler", style: { dim: true } }])], { padding: { left: 2 } }));
    if (this.#o.screenReader) return layoutNode(box(panels.length ? panels : [text(this.running ? "Tour en cours…" : "Votre message (Entrée pour envoyer)")]), size.columns, ctx);
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
    if (this.#stream && !this.#o.brief?.()) {
      // § 5.2 of SPEC-IHM-003: the content being produced is rendered by its probable intention.
      if (this.#render && !this.#streamRenderer) this.#streamRenderer = new MarkdownRenderer(this.#render.markdown, this.#view.unicode);
      stream.push(modelView(this.#streamRenderer ? this.#streamRenderer.render(this.#stream) : this.#stream, this.#view));
    }
    if (this.running) stream.push(activityView((tasks.find(task => task.status === "in_progress")?.progressLabel ?? this.#activity) + this.#tokenGoal, this.#now - this.#turnStarted, this.#spinner, this.#view));
    if (this.running && this.#tip) stream.push(text([{ text: this.#tip, style: { dim: true } }]));
    const background = this.#o.backgroundActivity?.() ?? [];
    if (background.length > 0) panels.push(box(background.slice(-3).map((task) => text([{ text: `Agent ${task.id} ${this.#view.unicode ? "●" : "*"} `, style: { fg: { ansi: task.color ?? 7 } } }, { text: `${task.agentType ?? "Agent"} · ${task.activity ?? "En attente…"} · ${task.toolCalls ?? 0} outil${task.toolCalls === 1 ? "" : "s"} · ${task.tokens ?? 0} jetons` }], { overflow: "clip" })), { padding: { left: 2 } }));
    if (buildFlag("ui_dev_bar") && buildProfile() !== "public") { const development = this.#o.developmentBar?.(); if (development) panels.push(text([{ text: development, style: { dim: true } }], { overflow: "clip" })); }
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
    const decoration=!this.#o.screenReader&&columns>=100?this.#o.inputDecoration?.(columns)??[]:[];
    const inner = Math.max(1, (ctx.narrow ? columns : columns - 4) - 2 - (decoration.length?24:0));
    const placeholder = ed.isEmpty;
    const keyword = this.shellLine ? undefined : this.#o.maxKeyword?.();
    const ranges = keyword ? keywordRanges(ed.text, keyword.keyword) : [];
    const highlighted: Span[] = []; let offset = 0;
    for (const range of ranges) { highlighted.push({ text: ed.text.slice(offset, range.start) }, { text: ed.text.slice(range.start, range.end), style: { bold: true, underline: true } }); offset = range.end; }
    highlighted.push({ text: ed.text.slice(offset) });
    const spans: Span[] = placeholder ? [{ text: this.running ? "Message à mettre en file…" : this.#suggestion || "Votre message (Entrée pour envoyer, Alt+Entrée pour un saut de ligne)", style: { dim: true } }] : highlighted;
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
    const survey = this.#o.survey?.prompt(); if (survey) extra.push(survey);
    const autonomous = this.#o.autonomousStatus?.(); if (autonomous) extra.push(autonomous);
    if (ranges.length) extra.push(keyword?.supported ? "Réflexion maximale pour ce tour." : "Ce modèle ne prend pas en charge la réflexion : mot-clé sans effet.");
    if (this.#modal) extra.push(this.#modal.label()); // EF-01: always visible, as a text
    if (shell) extra.push(`Mode shell : la ligne est exécutée par ${this.#o.shell!.label} ; elle n'est pas envoyée au modèle.`);
    if (this.#literalLead === "certain") extra.push("Texte collé : il sera envoyé comme texte (Ctrl+O : l'interpréter comme commande).");
    if (this.#pastes.size > 0) extra.push("Alt+P : déplier les textes collés pour les vérifier.");
    // EF-10 of SPEC-IHM-010: the attachments are visible before sending.
    const files = this.#o.attachments?.(this.#expanded(ed.text), this.#pasted) ?? [];
    for (const image of this.#images) extra.push(`Image jointe : ${image.width} × ${image.height}, ${image.bytes.length} octets${image.resized ? " (redimensionnée)" : ""}.`);
    if (files.length > 0) extra.push(`Pièces jointes à l'envoi : ${files.join(", ")}`);
    if (hidden > 0) extra.push(`${hidden} ligne${hidden > 1 ? "s" : ""} hors de la vue`);
    if (ed.text.length > this.#o.settings.inputWarnChars) extra.push(`${ed.text.length} caractères : risque de saturer le contexte`); // FA-02
    // FA-06, RG-02 of SPEC-IHM-007: a doubled trigger character is shown as it will be sent.
    const sent = shell || this.#literalLead ? undefined : this.#transformed(ed.text);
    if (sent !== undefined) extra.push(`Envoyé tel quel : ${sent.split("\n")[0]}`);
    const node = box([{ kind: "lines", lines: rows, cursor: cursor ? { row: cursor.row, col: cursor.col + 2 } : undefined }, ...extra.map((x) => text([{ text: x, style: { dim: true } }], { overflow: "clip" }))], {
      border: { style: shell ? { fg: { ansi: 5 } } : this.#sessionColor !== undefined ? { fg: { ansi: this.#sessionColor } } : { dim: true } },
      padding: { left: 1, right: 1 },
    });
    return decoration.length?box([box([node],{width:"grow"}),box(decoration.map(line=>text(line,{overflow:"clip"})),{width:24,padding:{left:1}})],{direction:"row"}):node;
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
    const custom = this.#o.footer?.();
    const voice=this.#o.voice?.indicator().replace("Ctrl+Espace",comboLabel(this.#keymap.effective("voice.hold")[0]??"ctrl+space"));
    if (custom) return text([{ text: `${voice?voice+" · ":""}${s.forge?s.forge+" · ":""}${s.fast?"rapide : "+s.fast+" · ":""}mode : ${s.mode}${this.#queue.length ? ` · ${this.#queue.length} en attente` : ""}${s.scheduled ? ` · planifié : ${s.scheduled}` : ""}${s.ide?` · ${s.ide}`:""}${s.remote?` · ${s.remote}`:""} · ${" ".repeat(custom.padding)}`, style: { dim: true } }, ...custom.spans, { text: " ".repeat(custom.padding) }], { overflow: "clip" });
    const parts: Span[] = [...(voice?[{text:voice+" · "}]:[]),...(s.forge?[{text:s.forge+" · "}]:[]),...(s.fast?[{text:"rapide : "+s.fast+" · "}]:[]),{ text: `mode : ${s.mode}` }, { text: ` · ${s.model}` },...(s.ide?[{text:` · ${s.ide}`}]:[]),...(s.remote?[{text:` · ${s.remote}`}]:[])];
    if (s.scheduled) parts.push({ text: ` · planifié : ${s.scheduled}` });
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
      const hints = [hint("mode.cycle", "mode"), ...(this.#o.canBackground?.() ? [hint("task.background", "arrière-plan")] : []), hint("app.interrupt", "interrompre, deux fois : quitter"), "/help : aide"].filter((h) => h !== undefined);
      parts.push({ text: ` · ${hints.join(" · ")}` });
    }
    return text(parts.map((p) => ({ ...p, style: { dim: true, ...(p.style ?? {}) } })), { overflow: "clip" });
  }
}
