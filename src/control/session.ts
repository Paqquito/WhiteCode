// Implements: SPEC-MOD-006 (§ 5.2 requests of the host, § 5.3 demands of the engine and distinct action of the user, § 5.4 nominal flow, FA-01 to FA-06,
//             EF-03, EF-05, EF-07, EF-08, ERR-04 to ERR-06, RG-01, RG-02, RG-04 to RG-08, CA-01 to CA-15)
// Supports: SPEC-CMD-001 (§ 5.5 widening commands invoked by a control host, CA-10), SPEC-PER-001 (§ 5.3, the designated host in the place of the human interface)
// The control driver of a session: it reads the input continuously, so that a request of the host is handled during a
// turn; user messages, those of the input and those injected, wait in a queue handled turn by turn.

import { randomUUID } from "node:crypto";
import type { PermissionMode } from "../config/settings-schema";
import { PERMISSION_MODES } from "../config/settings-schema";
import type { EngineEvent, TurnResult } from "../engine/events";
import type { ApprovalRequest, ControlAuthority, HostDecision } from "../permissions/resolver";
import type { ContentPart } from "../providers/types";
import { ControlChannel, type DemandOutcome } from "./channel";
import { ControlError, invalid, morePermissive } from "./protocol";

/** What the session gives to the driver; every operation keeps the rules of the session (RG-01). */
export interface ControlOperations {
  /** A user message: command, then turn (the shared processing of the drivers). */
  process(content: readonly ContentPart[], signal: AbortSignal): Promise<{ readonly result?: TurnResult; readonly refused?: string; readonly shown?: string; readonly exit?: boolean }>;
  /** A user message of the host, checked (`string`: what is wrong). */
  parseContent(value: unknown): ContentPart[] | string;
  state(): Record<string, unknown>;
  readonly mode: PermissionMode;
  /** Message of the policy when the mode is not available, otherwise `undefined` (ERR-04). */
  modeRefusal(mode: PermissionMode): string | undefined;
  setMode(mode: PermissionMode): void;
  selectModel(value: string): string;
  commands(): ReadonlyArray<Record<string, unknown>>;
  /** Whether the first word of a text names a widening command (SPEC-CMD-001 § 5.5); `undefined`: not a command. */
  widening(text: string): boolean | undefined;
  /** Adds a rule of the host for the session; returns an error message when it is malformed. */
  addRule(decision: "allow" | "ask" | "deny", raw: string): string | undefined;
  removeRule(raw: string): boolean;
  hostRules(): ReadonlyArray<{ readonly decision: string; readonly rule: string }>;
  addContext(text: string, kind: string): void;
  /** Observability of the session (EF-08): transcript and debug journal. */
  record(event: string, data: Record<string, unknown>): void;
  /** An event of the flow, so that the stream and the channel describe the same state (RG-04). */
  event(type: string, fields: Record<string, unknown>): void;
  /** A turn ended: the result is written on the stream. */
  turnEnded(result: TurnResult): void;
  /** An error of a message of the input (ERR-01 of SPEC-MOD-003) or of a refused command. */
  inputError(code: string, message: string): void;
}

export interface ControlSessionOptions {
  readonly onEnqueue?: () => void;
  readonly send: (message: Record<string, unknown>) => void;
  readonly defaultTimeoutMs: number;
  readonly maxInFlight: number;
  /** The policy accepts a declaration of decision authority (RG-05); see gap E-101. */
  readonly designationAccepted: boolean;
  /** `engine.control.allowEscalation`, read from the user and managed scopes only (CA-15). */
  readonly allowEscalation: boolean;
  readonly warn: (message: string) => void;
  readonly trace: (event: string, data: Record<string, unknown>) => void;
}

export type ControlEnd =
  | { readonly kind: "ended" }
  | { readonly kind: "shutdown" }
  /** FA-03: the channel broke; the turn in progress was interrupted. */
  | { readonly kind: "broken" }
  | { readonly kind: "refused"; readonly message: string };

interface QueueItem {
  readonly content: ContentPart[];
  readonly widening?: boolean;
  readonly done?: (outcome: Record<string, unknown>) => void;
}

const NOT_DESIGNATED = () => new ControlError("not_designated", "Requête refusée : l'hôte n'est pas l'autorité de décision de cette exécution.");
const ESCALATION_REFUSED = () => new ControlError("escalation_refused", "Élargissement refusé : confirmation de l'utilisateur requise."); // ERR-06

export class ControlSession {
  readonly channel: ControlChannel;
  readonly #o: ControlSessionOptions;
  #ops: ControlOperations | undefined;
  readonly #queue: QueueItem[] = [];
  #wake: (() => void) | undefined;
  #current: AbortController | undefined;
  #inputEnded = false;
  #shutdown = false;
  #fatal: string | undefined;
  readonly results: TurnResult[] = [];

  constructor(options: ControlSessionOptions) {
    this.#o = options;
    this.channel = new ControlChannel({
      send: options.send,
      defaultTimeoutMs: options.defaultTimeoutMs,
      maxInFlight: options.maxInFlight,
      warn: options.warn,
      trace: options.trace,
      fatal: (message) => {
        this.#fatal = message;
        this.#signal();
      },
      handlers: {
        cancel_turn: async () => {
          const running = this.#current !== undefined && !this.#current.signal.aborted;
          this.#current?.abort();
          return { cancelled: running };
        },
        inject_user_message: async (params) => {
          const content = this.#ops!.parseContent({ type: "user", content: params["content"] });
          if (typeof content === "string") throw invalid(content);
          const messageId = randomUUID();
          this.#enqueue({ content });
          return { messageId };
        },
        set_approval_mode: (params) => this.#setMode(params),
        select_model: async (params) => {
          if (typeof params["model"] !== "string") throw invalid("model attendu");
          return { model: this.#ops!.selectModel(params["model"]) };
        },
        get_state: async () => ({ ...this.#ops!.state(), designated: this.designated, turnInProgress: this.#current !== undefined, queued: this.#queue.length }),
        list_commands: async () => ({ commands: this.#ops!.commands() }),
        invoke_command: (params) => this.#invokeCommand(params),
        set_tool_permissions: (params) => this.#setToolPermissions(params),
        add_context: async (params) => {
          if (typeof params["text"] !== "string" || params["text"].trim() === "") throw invalid("text attendu");
          const kind = typeof params["kind"] === "string" ? params["kind"] : "context";
          this.#ops!.addContext(params["text"], kind);
          return {};
        },
        shutdown: async () => {
          // Acknowledged, then the end: the turn in progress stops, the requests that follow are refused.
          this.#shutdown = true;
          this.channel.beginShutdown();
          this.#current?.abort();
          this.#signal();
          return {};
        },
      },
    });
  }

  /** RG-05: designated only by a declaration that the policy accepts; the declared capability alone is not enough. */
  get designated(): boolean {
    return this.channel.host?.declaresAuthority === true && this.#o.designationAccepted;
  }

  /** The control host in the resolution of an `ask` (SPEC-PER-001 § 5.3); never consulted when not designated (CA-07). */
  readonly authority: ControlAuthority = {
    decide: async (request, signal) => {
      if (!this.designated) return undefined;
      const outcome = await this.channel.demand("approval_request", approvalParams(request), signal);
      return this.#decision(outcome, request);
    },
  };

  #decision(outcome: DemandOutcome, request: ApprovalRequest): HostDecision | undefined {
    switch (outcome.kind) {
      case "unsupported":
        return undefined; // FA-01: the default behaviour of the automated mode
      case "timeout":
        // FA-02, ERR-05, RG-02: no answer is a refusal, never an authorization; a warning is emitted.
        this.#o.warn(`Aucune décision reçue : action refusée (${request.action ?? request.toolName}).`);
        this.#ops?.record("control_decision", { callId: request.callId, outcome: "timeout" });
        return { decision: "deny", reason: "No decision was received from the control host in time: the action is denied." };
      case "aborted":
        return { decision: "deny", reason: "The turn was interrupted while the decision was awaited." };
      case "closed":
        return { decision: "deny", reason: "The control channel is closed: the action is denied." };
      case "answer": {
        if (!outcome.ok) return { decision: "deny", reason: `The control host could not decide: ${outcome.error.message}` };
        const r = (outcome.result ?? {}) as Record<string, unknown>;
        this.#ops?.record("control_decision", { callId: request.callId, outcome: String(r["decision"]), elapsedMs: outcome.elapsedMs });
        if (r["decision"] === "allow") return { decision: "allow" };
        if (r["decision"] === "deny") return { decision: "deny", reason: typeof r["reason"] === "string" && r["reason"] !== "" ? `Denied by the control host: ${r["reason"]}` : "Denied by the control host." };
        if (r["decision"] === "allow_modified" && r["input"] && typeof r["input"] === "object" && !Array.isArray(r["input"])) return { decision: "allow_modified", input: r["input"] as Record<string, unknown> };
        this.#o.warn("Réponse de décision invalide : action refusée.");
        return { decision: "deny", reason: "The control host gave an invalid answer: the action is denied." };
      }
    }
  }

  /** Engine events relayed as notifications, when the host handles them (§ 5.3, `notify`). */
  engineEvent(e: EngineEvent): void {
    if (e.type === "warning") this.channel.notify({ kind: "warning", message: e.message });
  }

  /**
   * § 5.3, RG-07, RG-08: a widening is done only after the answer `confirmer` to a demand `confirm_escalation` emitted
   * for this very operation, by a designated host, when `engine.control.allowEscalation` is true; otherwise no demand is
   * sent and the widening is refused (ERR-06). Every confirmed widening is recorded.
   */
  async #escalate(kind: string, detail: Record<string, unknown>): Promise<void> {
    if (!this.designated) throw ESCALATION_REFUSED();
    if (!this.#o.allowEscalation) throw ESCALATION_REFUSED(); // CA-12: no demand at all
    const escalationId = randomUUID();
    const outcome = await this.channel.demand("confirm_escalation", { escalationId, kind, ...detail });
    const r = outcome.kind === "answer" && outcome.ok ? ((outcome.result ?? {}) as Record<string, unknown>) : undefined;
    // CA-14: valid once, for this operation, within the delay; any other answer is without effect.
    if (r?.["decision"] === "confirm" && r["escalationId"] === escalationId) {
      this.#ops?.record("escalation_confirmed", { kind, ...detail });
      return;
    }
    this.#ops?.record("escalation_refused", { kind, outcome: outcome.kind });
    throw ESCALATION_REFUSED();
  }
  /** Confirm one external, billable or publishing operation through the designated human host. */
  async confirmExternal(question: string, signal: AbortSignal): Promise<boolean> {
    if (!this.designated || !this.#o.allowEscalation) return false;
    const escalationId = randomUUID(), outcome = await this.channel.demand("confirm_escalation", { escalationId, kind: "external_operation", question }, signal);
    const result = outcome.kind === "answer" && outcome.ok ? outcome.result : undefined;
    const confirmed = !signal.aborted && !!result && typeof result === "object" && "decision" in result && result.decision === "confirm" && "escalationId" in result && result.escalationId === escalationId;
    this.#ops?.record(confirmed ? "external_confirmed" : "external_refused", { escalationId }); return confirmed;
  }

  async #setMode(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!this.designated) throw NOT_DESIGNATED(); // RG-05, CA-08
    const mode = params["mode"];
    if (typeof mode !== "string" || !(PERMISSION_MODES as readonly string[]).includes(mode)) throw invalid("mode inconnu");
    const target = mode as PermissionMode;
    const refusal = this.#ops!.modeRefusal(target);
    if (refusal) throw new ControlError("mode_refused", `Mode refusé par la politique en vigueur. ${refusal}`); // ERR-04, FA-06, CA-05
    if (morePermissive(target, this.#ops!.mode)) await this.#escalate("approval_mode", { mode: target, from: this.#ops!.mode }); // CA-10, CA-12
    this.#ops!.setMode(target);
    this.#ops!.event("permission_mode", { mode: target, by: "control_host" }); // RG-04
    return { mode: this.#ops!.mode };
  }

  async #setToolPermissions(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    if (!this.designated) throw NOT_DESIGNATED(); // RG-05, RG-07, CA-08
    const add = params["add"] ?? [];
    const remove = params["remove"] ?? [];
    if (!Array.isArray(add) || !Array.isArray(remove)) throw invalid("add et remove : listes attendues");
    const additions: Array<{ decision: "allow" | "ask" | "deny"; rule: string }> = [];
    for (const a of add as Array<Record<string, unknown>>) {
      if (!a || typeof a.rule !== "string" || !["allow", "ask", "deny"].includes(String(a.decision))) throw invalid("règle attendue : { decision: allow|ask|deny, rule }");
      additions.push({ decision: a.decision as "allow" | "ask" | "deny", rule: a.rule });
    }
    for (const r of remove) if (typeof r !== "string") throw invalid("remove : règles attendues");
    for (const r of remove as string[]) this.#ops!.removeRule(r); // only the rules it added (§ 5.2)
    for (const a of additions) {
      // RG-07, CA-09: an `allow` rule is never born from the request alone.
      if (a.decision === "allow") await this.#escalate("allow_rule", { rule: a.rule });
      const problem = this.#ops!.addRule(a.decision, a.rule);
      if (problem) throw invalid(problem);
    }
    return { rules: this.#ops!.hostRules() };
  }

  async #invokeCommand(params: Readonly<Record<string, unknown>>): Promise<unknown> {
    const command = params["command"];
    if (typeof command !== "string" || !command.trimStart().startsWith("/")) throw invalid("command attendue, commençant par /");
    const widening = this.#ops!.widening(command) === true;
    // SPEC-CMD-001 CA-10, RG-07: refused for a host that is not designated; otherwise only after a confirmation (CA-11, CA-13).
    if (widening) await this.#escalate("command", { command: command.trim() });
    return new Promise((resolve) => this.#enqueue({ content: [{ type: "text", text: command.trim() }], widening, done: resolve }));
  }

  #enqueue(item: QueueItem): void {
    this.#queue.push(item);
    this.#o.onEnqueue?.();
    this.#signal();
  }

  /** Supports: SPEC-PLA-001 FA-04: scheduled local input goes through the ordinary serialized driver. */
  enqueueScheduled(text: string, skipBusy = false): boolean {
    if (!this.#ops || this.#inputEnded || this.#shutdown || this.#fatal || this.#queue.length >= 200) return false;
    if (skipBusy && (this.#current || this.#queue.length)) return false;
    this.#enqueue({ content: [{ type: "text", text }] }); return true;
  }

  #signal(): void {
    const w = this.#wake;
    this.#wake = undefined;
    w?.();
  }

  #wait(): Promise<void> {
    return new Promise((r) => (this.#wake = r));
  }

  /** Feeds the channel and the queue from the input, line by line, until its end. */
  async #pump(lines: AsyncIterable<string>): Promise<void> {
    let n = 0;
    try {
      for await (const raw of lines) {
        n++;
        const line = raw.trim();
        if (line === "") continue;
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          this.#ops!.inputError("invalid_input_line", `Message d'entrée illisible, ignoré (ligne ${n}) : JSON invalide`); // ERR-01 of SPEC-MOD-003
          continue;
        }
        if (value && typeof value === "object" && !Array.isArray(value) && ControlChannel.isControl(value as Record<string, unknown>)) {
          this.channel.receive(value as Record<string, unknown>);
          continue;
        }
        const content = this.#ops!.parseContent(value);
        if (typeof content === "string") this.#ops!.inputError("invalid_input_line", `Message d'entrée illisible, ignoré (ligne ${n}) : ${content}`);
        else this.#enqueue({ content });
      }
    } catch {
      // a read error is a broken channel (FA-03)
    }
    // FA-03: the host can no longer answer; the turn in progress stops.
    this.#inputEnded = true;
    this.#current?.abort();
    this.#signal();
  }

  /**
   * § 5.4: the host initializes, then the messages are handled in order; the channel stays open between the turns.
   * The end of the input while a turn runs, or while messages wait, is a broken channel (FA-03): the turn stops cleanly
   * and the session, recorded at each turn, stays reopenable.
   */
  async run(ops: ControlOperations, lines: AsyncIterable<string>, initial: readonly ContentPart[] | undefined, signal: AbortSignal): Promise<ControlEnd> {
    this.#ops = ops;
    const onAbort = () => {
      this.#current?.abort();
      this.#signal();
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void this.#pump(lines);
    try {
      // EF-03: the initialization of the host is awaited within the response delay, never indefinitely.
      const timer = setTimeout(() => {
        if (!this.channel.host && this.#fatal === undefined) {
          this.#fatal = "Initialisation de l'hôte non reçue dans le délai.";
          this.#signal();
        }
      }, this.#o.defaultTimeoutMs);
      while (!this.channel.host && this.#fatal === undefined && !this.#inputEnded && !signal.aborted) await Promise.race([this.channel.initialized, this.#wait()]);
      clearTimeout(timer);
      if (this.#fatal !== undefined) return { kind: "refused", message: this.#fatal };
      if (!this.channel.host) return { kind: this.#inputEnded ? "broken" : "ended" };
      if (initial && initial.length > 0) this.#queue.unshift({ content: [...initial] });

      for (;;) {
        if (this.#fatal !== undefined) return { kind: "refused", message: this.#fatal };
        if (this.#shutdown) return { kind: "shutdown" };
        if (signal.aborted) return { kind: "ended" };
        const item = this.#queue.shift();
        if (!item) {
          if (this.#inputEnded) return { kind: "ended" };
          await this.#wait();
          continue;
        }
        if (this.#inputEnded) return { kind: "broken" }; // FA-03: the waiting messages are not handled
        // A widening command of the input follows the rules of the channel, like `invoke_command` (RG-07).
        const text = item.content.find((p) => p.type === "text")?.text;
        if (item.widening === undefined && text !== undefined && ops.widening(text) === true) {
          try {
            await this.#escalate("command", { command: text.trim() });
          } catch (e) {
            ops.inputError("invalid_command", (e as Error).message);
            continue;
          }
        }
        const controller = new AbortController();
        this.#current = controller;
        let outcome: Awaited<ReturnType<ControlOperations["process"]>>;
        try {
          outcome = await ops.process(item.content, controller.signal);
        } finally {
          this.#current = undefined;
        }
        if (outcome.result) {
          this.results.push(outcome.result);
          ops.turnEnded(outcome.result);
          this.channel.notify({ kind: "turn_completed", turn: this.results.length, haltReason: outcome.result.stopCause });
        } else if (outcome.refused !== undefined && !item.done) ops.inputError("invalid_command", outcome.refused);
        else if (outcome.shown !== undefined && !item.done) ops.event("command_output", { output: outcome.shown });
        item.done?.(
          outcome.result
            ? { result: outcome.result.finalText, haltReason: outcome.result.stopCause }
            : outcome.refused !== undefined
              ? { refused: outcome.refused }
              : { shown: outcome.shown ?? "" },
        );
        // FA-03: the input ended during the turn: the run stops, the queued messages are not handled.
        if (this.#inputEnded && controller.signal.aborted && !this.#shutdown) return { kind: "broken" };
        if (outcome.exit) return { kind: "shutdown" };
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      this.channel.close();
    }
  }
}

/** What the host needs to show the demand (§ 10): action, reason, change, danger. */
function approvalParams(r: ApprovalRequest): Record<string, unknown> {
  return {
    callId: r.callId,
    toolName: r.toolName,
    summary: r.summary,
    ...(r.action ? { action: r.action } : {}),
    input: r.input ?? {},
    reason: r.reason,
    origin: r.origin,
    suggestions: r.suggestions,
    ...(r.preview ? { preview: r.preview } : {}),
    ...(r.danger ? { danger: r.danger } : {}),
    ...(r.requester ? { requester: r.requester } : {}),
  };
}
