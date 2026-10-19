// Supports: SPEC-AGT-021 (CA-01, EF-01/02, FA-01, retained contexts and shared run admission).
// Whole interactive contexts stay alive in this process. Switching the terminal never restarts a turn.
import type { Terminal } from "../platform/terminal";
import type { BudgetLedger, BudgetState } from "../engine/budget";
import type { RunLimits } from "../engine/limits";
import type { BackgroundTasks, BackgroundTask } from "../engine/background";
import type { EngineEvent } from "../engine/events";
import type { HumanApprovalChannel } from "../permissions/resolver";
import { bindPrivateStorage } from "../session/private-storage";
import { maskSecrets } from "../shared/secrets";
import type { InteractiveApp } from "./app";
import type { EntryOutcome } from "./session";

interface Context {
  readonly id: string;
  readonly inputs: Set<(data: string) => void>;
  readonly resizes: Set<() => void>;
  readonly exits: Set<() => void>;
  app?: InteractiveApp;
  background?: BackgroundTasks;
  openLocal?: () => Promise<void>;
  fresh?: () => { args: readonly string[]; cwd: string };
  turn?: { controller: AbortController; work: Promise<EntryOutcome> };
  task?: BackgroundTask;
  write?: (text: string) => void;
  output: string;
  redact: (source: string) => string;
  raw: boolean;
  done: boolean;
}

export class LiveContext {
  constructor(readonly host: LiveSessions, readonly context: Context) {}
  get terminal(): Terminal { return this.host.terminalFor(this.context); }
  get canBackground(): boolean { return !!this.context.turn && !this.context.app?.humanDialogActive; }
  get running(): number { return this.host.running; }
  attach(app: InteractiveApp, background: BackgroundTasks, openLocal: () => Promise<void>, fresh: () => { args: readonly string[]; cwd: string }, redact: (source: string) => string): () => void {
    const c = this.context; c.app = app; c.background = background; c.openLocal = bindPrivateStorage(openLocal); c.fresh = bindPrivateStorage(fresh); c.redact = source => maskSecrets(redact(source));
    const change = background.onChange(() => this.host.refresh());
    return () => { change(); if (c.app === app) { c.app = undefined; c.background = undefined; } };
  }
  track(controller: AbortController, work: Promise<EntryOutcome>): () => void {
    const c = this.context; c.turn = { controller, work }; c.output = "";
    return () => { if (c.turn?.work === work) c.turn = undefined; };
  }
  background(): string | undefined { return this.host.detach(this.context); }
  panel(): Promise<void> { return this.host.panel(); }
  event(event: EngineEvent): void {
    const c = this.context;
    const chunk = event.type === "text_delta" ? event.text : event.type === "tool_result" ? `\n${event.output}\n` : "";
    if (chunk) c.output = c.redact(c.output + chunk).slice(-32_000);
    // Persist complete text blocks: adjacent deltas must not reconstruct a credential in the output file.
    if (event.type === "assistant_message") c.write?.(c.redact(event.text) + "\n");
    if (event.type === "tool_result") c.write?.(c.redact(chunk));
  }
  get human(): HumanApprovalChannel { return this.host.human(this.context); }
  /** A turn must not join its own adoption promise through background_stop/output. */
  backgroundView(background: BackgroundTasks): BackgroundTasks {
    const hidden = (id: string) => background.get(id)?.kind === "session";
    return new Proxy(background, { get: (target, key) => {
      if (key === "tasks" || key === "running") return target[key].filter(task => task.kind !== "session");
      if (key === "get") return (id: string) => hidden(id) ? undefined : target.get(id);
      if (key === "tail") return (id: string, max: number) => hidden(id) ? "" : target.tail(id, max);
      if (key === "stop") return (id: string) => hidden(id) ? Promise.resolve(false) : target.stop(id);
      if (key === "wait") return (id: string, timeout: number, signal?: AbortSignal) => hidden(id) ? Promise.resolve(true) : target.wait(id, timeout, signal);
      if (key === "scope") return (signal: AbortSignal) => { const scope = target.scope(signal); return { ...scope, tasks: this.backgroundView(scope.tasks) }; };
      const value: unknown = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  }
}

export class LiveSessions {
  readonly #contexts: Context[] = [];
  #foreground?: Context;
  readonly #close = new AbortController();
  readonly #pending = new Set<Promise<number>>();
  readonly #unsubscribers: Array<() => void> = [];
  readonly #journals = new Map<Context, (state: BudgetState) => boolean>();
  #ledger?: BudgetLedger;
  #limits?: RunLimits;
  #permission = 0;
  #code = 0;
  #closing = false;
  constructor(readonly terminal: Terminal, readonly launch: (port: LiveContext, args: readonly string[], cwd: string, signal: AbortSignal) => Promise<number>) {
    // A dialog may replace its listener while consuming a key. Only the original listeners receive this event.
    this.#unsubscribers.push(terminal.onInput(data => { for (const f of [...(this.#foreground?.inputs ?? [])]) f(data); }));
    this.#unsubscribers.push(terminal.onResize(() => { for (const c of this.#contexts) for (const f of c.resizes) f(); }));
    this.#unsubscribers.push(terminal.onProcessExit(() => this.close()));
  }
  get signal(): AbortSignal { return this.#close.signal; }
  get running(): number { return this.#contexts.reduce((n, c) => n + (c.background?.running.length ?? 0) + (c !== this.#foreground && c.app?.running && c.task?.status !== "running" ? 1 : 0), 0); }
  ledger(create: () => BudgetLedger): { ledger: BudgetLedger; fresh: boolean } {
    const fresh = !this.#ledger;
    return { ledger: this.#ledger ??= create(), fresh };
  }
  limits(create: () => RunLimits): RunLimits { return this.#limits ??= create(); }
  journal(port: LiveContext, write: (state: BudgetState) => boolean): () => void {
    this.#journals.set(port.context, bindPrivateStorage(write));
    this.#ledger!.journal(state => { let ok = true; for (const f of this.#journals.values()) if (!f(state)) ok = false; return ok; });
    return () => { this.#journals.delete(port.context); };
  }
  terminalFor(c: Context): Terminal {
    const terminal = this.terminal;
    return {
      get columns() { return terminal.columns; }, get rows() { return terminal.rows; },
      write: data => { if (this.#foreground === c) terminal.write(data); },
      onInput: listener => { const bound = bindPrivateStorage(listener); c.inputs.add(bound); return () => { c.inputs.delete(bound); }; },
      onResize: listener => { const bound = bindPrivateStorage(listener); c.resizes.add(bound); return () => { c.resizes.delete(bound); }; },
      onProcessExit: listener => { c.exits.add(listener); return () => { c.exits.delete(listener); }; },
      setRawMode: on => { c.raw = on; terminal.setRawMode(this.#contexts.some(context => context.raw)); },
    };
  }
  #start(args: readonly string[], cwd: string): Context {
    const c: Context = { id: `conversation ${this.#contexts.length + 1}`, inputs: new Set(), resizes: new Set(), exits: new Set(), output: "", redact: maskSecrets, raw: false, done: false };
    if (this.#contexts.length) this.terminal.write("\u001b[0m\u001b[2J\u001b[H");
    this.#contexts.push(c); this.#foreground = c;
    const done = this.launch(new LiveContext(this, c), args, cwd, this.signal).then(code => {
      c.done = true; this.#code = Math.max(this.#code, code);
      if (this.#foreground === c) {
        const previous = [...this.#contexts].reverse().find(context => context !== c && !context.done && context.app);
        if (code !== 0 && previous) { this.#focus(previous); previous.app?.notice("warning", `Nouvelle conversation indisponible (${code}) ; contexte précédent conservé.`); }
        else this.close();
      }
      else this.#foreground?.app?.notice("warning", `${c.id} fermée (${code}).`);
      return code;
    }, error => { c.done = true; this.#code = 1; this.#foreground?.app?.notice("error", `${c.id} : ${c.redact((error as Error).message)}`); if (this.#foreground === c) this.close(); return 1; });
    this.#pending.add(done); void done.finally(() => this.#pending.delete(done));
    return c;
  }
  async run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<number> {
    const abort = () => this.close(); signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) this.close();
    try {
      if (!this.signal.aborted) this.#start(args, cwd);
      while (this.#pending.size) await Promise.all([...this.#pending]);
      return this.#code;
    } finally { signal?.removeEventListener("abort", abort); this.close(); for (const f of this.#unsubscribers.splice(0)) f(); this.terminal.setRawMode(false); }
  }
  close(): void {
    if (this.#closing) return; this.#closing = true; this.#close.abort();
    for (const c of this.#contexts) { c.app?.forceExit(); for (const exit of c.exits) exit(); }
  }
  refresh(): void { this.#foreground?.app?.refresh(); }
  detach(c: Context): string | undefined {
    const turn = c.turn, background = c.background;
    if (this.#closing || this.#permission || c !== this.#foreground || !turn || !background || !c.fresh || c.app?.humanDialogActive) return undefined;
    if (this.#contexts.filter(context => !context.done).length >= 8) throw new Error("Huit conversations sont déjà ouvertes.");
    const fresh = c.fresh();
    if (c.task?.status === "running") { this.#start(fresh.args, fresh.cwd); return `${c.id} / ${c.task.id}`; }
    const task = background.start("session", `Session principale — ${c.id}`, async (signal, write) => {
      const abort = () => turn.controller.abort(signal.reason);
      signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
      c.write = write; write(c.redact(c.output));
      try {
        const outcome = await turn.work;
        return { status: signal.aborted ? "stopped" : outcome.kind === "turn" && outcome.result.stopCause !== "completed" ? "failed" : "completed", summary: outcome.kind === "turn" ? c.redact(outcome.result.finalText).slice(-4000) : undefined };
      } catch (error) {
        return { status: signal.aborted ? "stopped" : "failed", summary: c.redact((error as Error)?.message ?? String(error)).slice(-4000) };
      } finally {
        signal.removeEventListener("abort", abort); c.write = undefined;
        // Let the ordinary loop finish its UI and transcript before announcing completion.
        queueMicrotask(() => { if (!this.#closing) this.#foreground?.app?.notice("info", `Session principale ${c.id} terminée ; résultat disponible dans le panneau des tâches.`); });
      }
    });
    c.task = task;
    this.#start(fresh.args, fresh.cwd);
    return `${c.id} / ${task.id}`;
  }
  #focus(c: Context): void {
    if (this.#permission || c.done || !c.app) return;
    this.#foreground = c; c.app.reclaimTerminal(); c.app.notice("info", `${c.id} reprise.`);
  }
  async panel(): Promise<void> {
    const current = this.#foreground, app = current?.app;
    if (!app || this.#permission) return;
    const contexts = this.#contexts.filter(c => !c.done && c.app);
    if (contexts.length < 2) { await current.openLocal?.(); return; }
    const state = (c: Context) => c.app?.running ? "en cours" : c.task?.status === "failed" ? "en échec" : c.task ? "terminée" : "en attente";
    const choices = contexts.map(c => ({ label: `${c.id} — ${c.task ? "session principale" : "conversation"} — ${state(c)}`, description: c.redact(c.task?.summary ?? c.output).slice(-2000) }));
    choices.push({ label: "Tâches locales et planifications", description: "Commandes, agents et surveillances de cette conversation." });
    const selected = await app.choose("Tâches de fond — conversations", choices, { other: false, interruptible: true });
    if (selected.kind !== "options") return;
    const index = choices.findIndex(choice => choice.label === selected.labels[0]), c = contexts[index];
    if (!c) { await current.openLocal?.(); return; }
    const action = await app.choose(`Session principale — ${c.id}`, [
      { label: "Reprendre la conversation", description: c.redact(c.output).slice(-4000) || "Le contexte complet et le tour en cours sont conservés." },
      ...(c.app?.running ? [{ label: "Arrêter le tour", description: "Annule le tour d’origine et attend sa fin." }] : []),
      { label: "Fermer le détail", description: c.redact(c.task?.summary ?? "") },
    ], { other: false, interruptible: true });
    if (action.kind !== "options") return;
    if (action.labels[0] === "Reprendre la conversation") this.#focus(c);
    if (action.labels[0] === "Arrêter le tour" && await app.confirm(`Arrêter le tour de ${c.id} ?`, "arrêter", "continuer", true)) {
      const turn = c.turn; turn?.controller.abort(); await turn?.work.catch(() => undefined);
    }
  }
  human(c: Context): HumanApprovalChannel {
    return {
      request: async (request, signal) => {
        if (signal.aborted || this.#closing) return { answer: "no_stop" };
        // The displayed dialog owns the keyboard until answered. Context switching is disabled meanwhile.
        const app = this.#foreground?.app; if (!app) return { answer: "no_stop" };
        this.#permission++;
        try { return await app.approvals.request({ ...request, requester: `${c.task?.status === "running" ? `Tâche ${c.task.id} — session principale — ` : ""}${c.id}${request.requester ? ` — ${request.requester}` : ""}` }, signal); }
        finally { this.#permission--; }
      },
      loopDetected: (info, signal) => this.#foreground?.app?.approvals.loopDetected?.({ ...info, summary: `${c.id} : ${info.summary}` }, signal) ?? Promise.resolve({ choice: "stop" }),
    };
  }
}
