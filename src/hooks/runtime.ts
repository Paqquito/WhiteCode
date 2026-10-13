// Implements: SPEC-HOK-001 (§ 5.1 common fields, § 5.4 steps 1 to 4, EF-01, EF-02, EF-04, RG-02, CA-01 to CA-03, CA-05), SPEC-HOK-002 (§ 5.4 step 3, CA-01),
//             SPEC-HOK-003 (§ 5.1 variables, § 5.3 steps 4 and 5, FA-02, EF-02, EF-04, CA-01 to CA-04), SPEC-HOK-010 (§ 5.4 steps 1 and 6, EF-05, CA-01, CA-04 to CA-07),
//             SPEC-HOK-004 (§ 5.3 step 4, EF-05, ERR-01, ERR-02, CA-01 to CA-04), SPEC-HOK-007 (§ 5.3, FA-01, EF-01 to EF-03, ERR-01, RG-01, CA-01, CA-02),
//             SPEC-PER-001 (§ 5.3 point c habilitated hook, CA-12, CA-19)
// Supports: SPEC-MOT-001 (EF-08 hooks of the loop), SPEC-MOT-005 (`instructions_read`), SPEC-CFG-005 (`settings_modified`), SPEC-CFG-003 (raw policy checks), gap E-120.
// The hooks of a session: payloads, selection, execution in parallel, aggregation and the effects of the decisions.
// Supports: SPEC-HOK-001 (CA-04: scoped agent identity and effective mode), gap E-132.

import type { HookBus, BeforeToolResult } from "../extension-points/hooks";
import type { ApprovalHook, ApprovalRequest } from "../permissions/resolver";
import type { ToolCall } from "../providers/types";
import { aggregate, parseResponse, type ActionOutcome, type Aggregated, type HookResponse } from "./aggregate";
import { runCommandHook, type ShellChoice } from "./command";
import type { HookDeclaration, HookSnapshot, HttpAction, ModelAction } from "./config";
import { HOOK_EVENTS, PAYLOAD_SCHEMA_VERSION, type HookEventInfo } from "./events";
import { createHttpAgents, runHttpHook, type Resolver } from "./http";
import type { PlatformName } from "../platform/system";
import type { TranscriptAccess } from "../session/transcript-access";

export interface HookRuntimeOptions {
  readonly questionRounds?: () => number;
  readonly question?: (label: string, question: NonNullable<HookResponse["question"]>) => Promise<string | null>;
  readonly group?: (event: string, payload: string, outcomes: readonly ActionOutcome[], durationMs: number) => void;
  /** Implements: SPEC-HOK-005/006; the composition root supplies the ordinary budgeted, read-only engine. */
  readonly modelHook?: (action: ModelAction, payload: string, label: string, signal: AbortSignal) => Promise<string>;
  readonly signal?: () => AbortSignal | undefined;
  readonly transcriptAccess?: TranscriptAccess;
  readonly policyRefusal?: () => string | undefined;
  readonly snapshot: HookSnapshot;
  readonly sessionId: string;
  readonly cwd: string;
  readonly platform: PlatformName;
  readonly approvalMode: () => string;
  /** Environment of a hook command: the child environment with the variables of § 5.1 of SPEC-HOK-003. */
  readonly environment: (extra: Readonly<Record<string, string>>) => Record<string, string>;
  /** `{{ENV_PREFIX}}`, for the variables of the hook commands. */
  readonly envPrefix: string;
  readonly shells: { readonly posix?: ShellChoice; readonly powershell?: ShellChoice };
  readonly commandTimeoutMs: number;
  readonly outputMaxSize: number;
  readonly payloadMaxSize: number;
  /** `hooksConfig.http.*` (SPEC-HOK-004 § 6); `resolve` replaces the system resolver in the tests. */
  readonly http: { readonly timeoutMs: number; readonly allowedUrls?: readonly string[]; readonly allowedEnvVars: readonly string[]; readonly resolve?: Resolver };
  /** `hooksConfig.maxAsync` and `hooksConfig.asyncKillOnExit` (SPEC-HOK-007 § 6). */
  readonly maxAsync: number;
  readonly asyncKillOnExit: boolean;
  /** Messages for the user: blocks, user messages, failures (SPEC-HOK-010 EF-05, SPEC-HOK-003 EF-02). */
  readonly report: (message: string) => void;
  /** Context for the model, through a system reminder (SPEC-HOK-010 § 5.1); `origin` names the event, and the hook when it comes late. */
  readonly addContext: (text: string, origin: string) => void;
  readonly clock?: () => Date;
  /** Debug journal (domain `hooks`, SPEC-OBS-012): the declarations of an event, retained or not by their filter. */
  readonly log?: (message: string, data?: unknown) => void;
}

interface Started {
  readonly d: HookDeclaration;
  readonly outcome: Promise<ActionOutcome>;
}

interface AgentScope {
  readonly agent: { readonly id: string; readonly type: string };
  readonly approvalMode: string;
}

export class HookRuntime implements HookBus {
  readonly #contexts = new Map<symbol, { target: string; snapshot: () => HookSnapshot }>();
  readonly #o: HookRuntimeOptions;
  #snapshot: HookSnapshot;
  readonly #pending = new Set<Promise<unknown>>();
  /** Asynchronous hooks: how many run, those waiting for a slot (ERR-01), and how to stop them (FA-01). */
  #running = 0;
  readonly #queue: Array<() => void> = [];
  readonly #controllers = new Set<AbortController>();
  #closed = false;
  readonly #agents = createHttpAgents();
  /** Non-habilitated `approval_needed` hooks already reported. */
  readonly #reportedUnhabilitated = new Set<string>();
  /** Session variables returned by `session_opened` hooks (SPEC-HOK-010 § 5.1, SPEC-SES-018). */
  readonly sessionEnv: Record<string, string> = {};

  constructor(options: HookRuntimeOptions) {
    this.#o = options;
    this.#snapshot = options.snapshot;
  }

  /** The declarations in force (SPEC-CMD-031: the view of the hooks). */
  get snapshot(): HookSnapshot {
    return { ...this.#snapshot, declarations: [...this.#snapshot.declarations, ...[...this.#contexts.values()].flatMap(c => c.snapshot().declarations)] };
  }
  /** Implements: SPEC-HOK-008; a context targets one agent, never its parent. Registration is leased until finally. */
  registerContext(target: string, snapshot: () => HookSnapshot): () => void {
    const key = Symbol(); this.#contexts.set(key, { target, snapshot });
    return () => { this.#contexts.delete(key); };
  }

  /** A new snapshot after a change of the settings (SPEC-HOK-002 FA-01, SPEC-CFG-005). */
  replaceSnapshot(snapshot: HookSnapshot): void {
    this.#snapshot = snapshot;
  }

  /** Declarations whose filter matches (SPEC-HOK-002 § 5.4 step 3). */
  #select(event: string, fields: Record<string, unknown>): HookDeclaration[] {
    const field = HOOK_EVENTS[event]?.discriminant;
    const value = field ? fields[field] : undefined;
    const target = (fields["agent"] as AgentScope["agent"] | undefined)?.id ?? "main";
    const contextual = [...this.#contexts.values()].filter(c => c.target === target).flatMap(c => c.snapshot().declarations);
    const declared = [...this.#snapshot.declarations, ...contextual].filter(d => d.event === event);
    const selected = declared.filter(d => event === "watched_file_modified" && fields["summary"] === true || d.matches(value === undefined ? undefined : String(value)));
    if (declared.length > 0)
      this.#o.log?.(`event ${event}: ${selected.length} of ${declared.length} hook(s) selected`, {
        ...(field ? { [field]: value } : {}),
        selected: selected.map((d) => d.label),
        filteredOut: declared.filter((d) => !selected.includes(d)).map((d) => ({ hook: d.label, match: d.match })),
      });
    return selected;
  }

  /** Step 1: common fields and the fields of the event; large tool results cut with a flag (EF-04). */
  #payload(event: string, fields: Record<string, unknown>): string {
    const p: Record<string, unknown> = {
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      event,
      sessionId: this.#o.sessionId,
      // CA-05: an opaque reference to the transcript, never a path of the session store.
      transcriptRef: "session:unavailable",
      cwd: this.#o.cwd,
      approvalMode: this.#o.approvalMode(),
      timestamp: (this.#o.clock ?? (() => new Date()))().toISOString(),
      ...fields,
    };
    const result = p["toolResult"];
    if (typeof result === "string" && Buffer.byteLength(result, "utf8") > this.#o.payloadMaxSize) {
      p["toolResult"] = Buffer.from(result, "utf8").subarray(0, this.#o.payloadMaxSize).toString("utf8");
      p["toolResultTruncated"] = { originalBytes: Buffer.byteLength(result, "utf8"), fullContent: "the complete result is in the transcript (transcriptRef)" };
    }
    try {
      return JSON.stringify(p);
    } catch {
      return JSON.stringify({ ...p, toolArguments: "[serialisation error]", toolResult: "[serialisation error]" }); // ERR-01
    }
  }

  async #runAction(d: HookDeclaration, index: number, payload: string, event: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<ActionOutcome> {
    let grant;
    try {
      grant = await this.#o.transcriptAccess?.grant({ event, fields });
      if (signal?.aborted) return { label: d.label, mandatory: d.mandatory, failure: "arrêté à la fin de la session (hooksConfig.asyncKillOnExit)" };
      if (grant) payload = JSON.stringify({ ...JSON.parse(payload), transcriptRef: grant.reference });
      let result = await this.#runGrantedAction(d, index, payload, event, fields, signal);
      for (let round = 0; result.response?.question; round++) {
        if (!this.#o.question || d.async || !HOOK_EVENTS[event]?.synchronous || round >= (this.#o.questionRounds?.() ?? 3)) return { label: result.label, mandatory: d.mandatory, ...(d.mandatory ? { failure: "question du contrôle obligatoire indisponible" } : {}) };
        const answer = await this.#o.question(result.label, result.response.question);
        if (signal?.aborted || this.#o.signal?.()?.aborted) return { label: result.label, mandatory: d.mandatory };
        const next = JSON.stringify({ ...JSON.parse(payload), answer });
        result = await this.#runGrantedAction(d, index, next, event, fields, signal);
      }
      return result;
    } catch { return { label: d.label, mandatory: d.mandatory, failure: "lecture locale ou exécution du crochet indisponible" }; }
    finally { grant?.release(); }
  }

  async #runGrantedAction(d: HookDeclaration, index: number, payload: string, event: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<ActionOutcome> {
    const refusal = this.#o.policyRefusal?.();
    if (refusal) return { label: d.label, mandatory: true, failure: refusal };
    const action = d.actions[index]!;
    const label = d.actions.length > 1 ? `${d.label}[${index + 1}]` : d.label;
    if (action.type === "http") return this.#runHttp(d, label, action, payload, signal);
    if (action.type === "prompt" || action.type === "agent") {
      const controller = new AbortController(), cancel = () => controller.abort(), parent = signal ?? this.#o.signal?.();
      parent?.addEventListener("abort", cancel, { once: true }); if (parent?.aborted) cancel();
      const timer = setTimeout(cancel, action.timeoutMs);
      const activity = setTimeout(() => this.#o.report(`Vérification en cours : crochet ${label}.`), 1000);
      try {
        if (!this.#o.modelHook || controller.signal.aborted) throw new Error();
        const text = await this.#o.modelHook(action, payload, label, controller.signal);
        const parsed = parseResponse(text);
        if (controller.signal.aborted || parsed.nonConforming || !parsed.response?.decision || typeof parsed.response.reason !== "string") throw new Error();
        return { label, mandatory: d.mandatory, response: parsed.response };
      } catch { return { label, mandatory: d.mandatory, failure: "réponse du modèle inexploitable ou délai dépassé" }; }
      finally { clearTimeout(timer); clearTimeout(activity); parent?.removeEventListener("abort", cancel); }
    }
    if (action.type !== "command") return { label, mandatory: d.mandatory, failure: "type de crochet non pris en charge" };
    const wanted = action.shell?.toLowerCase();
    const shell = wanted === "powershell" || wanted === "pwsh" ? (this.#o.shells.powershell ?? this.#o.shells.posix) : wanted !== undefined ? (this.#o.shells.posix ?? this.#o.shells.powershell) : (this.#o.shells.posix ?? this.#o.shells.powershell);
    if (!shell) return { label, mandatory: d.mandatory, failure: "aucun shell disponible pour exécuter la commande" };
    const p = this.#o.envPrefix;
    const args = fields["toolArguments"] as Record<string, unknown> | undefined;
    const file = typeof args?.["path"] === "string" ? args["path"] : undefined;
    const env = this.#o.environment({
      ...this.sessionEnv,
      [`${p}HOOK_EVENT`]: event,
      [`${p}CURRENT_SESSION`]: this.#o.sessionId,
      [`${p}PROJECT_DIR`]: this.#o.cwd,
      ...(typeof fields["toolId"] === "string" ? { [`${p}HOOK_TOOL`]: fields["toolId"] } : {}),
      ...(file ? { [`${p}HOOK_FILE`]: file } : {}),
    });
    const timeoutMs = action.timeoutMs ?? this.#o.commandTimeoutMs;
    const run = await runCommandHook(action, payload, { cwd: this.#o.cwd, env, shell, timeoutMs, outputMaxSize: this.#o.outputMaxSize, platform: this.#o.platform, signal });
    const captured = { stdout: run.stdout, stderr: run.stderr, elapsedMs: run.durationMs };
    if (signal?.aborted) return { label, mandatory: d.mandatory, failure: "arrêté à la fin de la session (hooksConfig.asyncKillOnExit)" };
    if (run.timedOut) return { label, mandatory: d.mandatory, ...captured, failure: `arrêté après ${Math.round(timeoutMs / 1000)} s` }; // ERR-02
    if (run.exitCode === 127) return { label, mandatory: d.mandatory, failure: "commande introuvable" }; // ERR-01
    if (run.exitCode !== 0) return { label, mandatory: d.mandatory, ...captured, failure: `code de sortie ${run.exitCode}${run.stderr.trim() ? ` : ${run.stderr.trim().slice(0, 300)}` : ""}` }; // EF-02: never blocking
    const parsed = parseResponse(run.stdout);
    if (parsed.nonConforming) return { label, mandatory: d.mandatory, ...captured, failure: `réponse non conforme (${parsed.nonConforming})` }; // FA-01
    return { label, mandatory: d.mandatory, ...captured, response: parsed.response, text: parsed.response ? undefined : run.stdout.trim() || undefined };
  }

  /** SPEC-HOK-004 step 4: a JSON response on 2xx, success without a body, otherwise a non-blocking failure (EF-05). */
  async #runHttp(d: HookDeclaration, label: string, action: HttpAction, payload: string, signal?: AbortSignal): Promise<ActionOutcome> {
    const h = this.#o.http;
    const timeoutMs = action.timeoutMs ?? h.timeoutMs;
    const run = await runHttpHook(action, payload, {
      timeoutMs,
      allowedUrls: h.allowedUrls,
      allowedEnvVars: h.allowedEnvVars,
      env: this.#o.environment({ ...this.sessionEnv }),
      outputMaxSize: this.#o.outputMaxSize,
      signal,
      resolve: h.resolve,
      agents: this.#agents,
    });
    for (const w of run.warnings) this.#o.report(`avertissement : crochet ${label} : ${w}`); // ERR-03
    const failure = (f: string): ActionOutcome => ({ label, mandatory: d.mandatory, failure: f });
    if (run.refused !== undefined) return failure(`Crochet HTTP refusé : adresse non autorisée (${run.refused}).`); // FA-01, ERR-01
    if (run.timedOut) return failure(`Crochet HTTP sans réponse après ${Math.round(timeoutMs / 1000)} s.`); // ERR-02
    if (run.error !== undefined) return failure(`échec réseau : ${run.error}`);
    if (run.status === undefined || run.status < 200 || run.status > 299) return failure(`statut HTTP ${run.status ?? "inconnu"}`);
    const body = run.body.trim();
    if (body === "") return { label, mandatory: d.mandatory };
    const parsed = body.startsWith("{") ? parseResponse(body) : { nonConforming: "corps non JSON" };
    if (parsed.nonConforming !== undefined || !parsed.response) return failure(`réponse non conforme (${parsed.nonConforming ?? "corps non JSON"})`);
    return { label, mandatory: d.mandatory, response: parsed.response };
  }

  /** Steps 2 to 4 of SPEC-HOK-001 § 5.4 and the user-facing effects; undefined when no hook matched (FA-01). */
  async fire(event: string, fields: Record<string, unknown>, signal?: AbortSignal): Promise<Aggregated | undefined> {
    if (this.#closed) return undefined;
    const started = this.#start(event, fields, this.#select(event, fields), signal);
    if (started.length === 0) return undefined;
    const pending = Promise.all(started.map(s => s.outcome)); this.#pending.add(pending);
    try {
      const outcomes = await pending;
      return this.#apply(event, HOOK_EVENTS[event]!, outcomes);
    } finally { this.#pending.delete(pending); }
  }

  /** Launches the selected hooks; those not awaited run in the background (SPEC-HOK-007). Returns the awaited ones, which run in parallel (RG-02). */
  #start(event: string, fields: Record<string, unknown>, selected: readonly HookDeclaration[], signal?: AbortSignal): Started[] {
    if (selected.length === 0) return [];
    const info = HOOK_EVENTS[event]!;
    const payload = this.#payload(event, fields);
    const start = Date.now(), total = selected.reduce((n, d) => n + d.actions.length, 0), outcomes: ActionOutcome[] = [];
    const grouped = (outcome: ActionOutcome) => { outcomes.push(outcome); if (outcomes.length === total) this.#o.group?.(event, payload, outcomes, Date.now() - start); };
    const waited: Started[] = [];
    for (const d of selected)
      d.actions.forEach((_, i) => {
        if (!info.synchronous || d.async) this.#background(d, i, payload, event, fields, info, grouped);
        else waited.push({ d, outcome: this.#runAction(d, i, payload, event, fields, signal).then(o => { grouped(o); return o; }) });
      });
    return waited;
  }

  /** A hook that is not awaited (EF-01); an asynchronous one waits for a slot (EF-03, ERR-01) and can be stopped at the end (FA-01). */
  #background(d: HookDeclaration, index: number, payload: string, event: string, fields: Record<string, unknown>, info: HookEventInfo, grouped: (outcome: ActionOutcome) => void): void {
    const late = d.async === true;
    const launch = () => {
      const controller = new AbortController();
      if (late) {
        this.#running++;
        this.#controllers.add(controller);
      }
      const p: Promise<void> = this.#runAction(d, index, payload, event, fields, late ? controller.signal : undefined)
        .then(o => { grouped(o); this.#deliver(o, event, info, late); })
        .finally(() => {
          this.#pending.delete(p);
          if (!late) return;
          this.#controllers.delete(controller);
          this.#running--;
          this.#queue.shift()?.();
        });
      this.#pending.add(p);
    };
    if (late && this.#running >= this.#o.maxAsync) this.#queue.push(launch);
    else launch();
  }

  /** Result of a hook that was not awaited: failures and messages reported, context kept for the next safe point (§ 5.3 step 2). */
  #deliver(o: ActionOutcome, event: string, info: HookEventInfo, late: boolean): void {
    if (o.failure !== undefined) {
      this.#o.report(`avertissement : crochet ${o.label} (${event}) : ${o.failure}`);
      return;
    }
    let response: HookResponse | undefined = o.response;
    if (response) {
      // EF-02: the decision of a hook that is not awaited comes too late; its decisional fields are ignored.
      const { decision, reason: _reason, modifiedInput, stopTurn, haltReason: _halt, sessionEnv, ...rest } = response;
      const ignored = Object.entries({ decision, modifiedInput, stopTurn, sessionEnv })
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      if (ignored.length > 0) this.#o.report(`avertissement : crochet ${o.label} (${event}) : ${ignored.join(", ")} ignoré${ignored.length > 1 ? "s" : ""} : un crochet ${late ? "asynchrone" : "de cet événement"} ne décide pas.`);
      response = rest;
    }
    const r = aggregate({ ...info, decisions: [] }, [{ ...o, response }]);
    for (const n of r.notices) this.#o.report(`avertissement : ${n}`);
    for (const m of r.userMessages) this.#o.report(`crochet ${m}`);
    // FA-01: once the session is over, no context is delivered; RG-01: a late context names its hook and event.
    if (!this.#closed) for (const c of r.context) this.#o.addContext(c, late ? `${event}, asynchronous hook ${o.label}` : event);
  }

  /** Steps 5 and 6 of SPEC-HOK-010 § 5.4: aggregation, then the effects visible to the user. */
  #apply(event: string, info: HookEventInfo, outcomes: readonly ActionOutcome[]): Aggregated {
    const result = aggregate(info, outcomes);
    for (const n of result.notices) this.#o.report(`avertissement : ${n}`);
    for (const m of result.userMessages) this.#o.report(`crochet ${m}`);
    for (const c of result.context) this.#o.addContext(c, event);
    Object.assign(this.sessionEnv, result.sessionEnv);
    if (result.decision === "deny" || result.decision === "block") this.#o.report(`Bloqué par un crochet (${event}) : ${result.reasons.join(" ; ") || "sans raison donnée"}`); // EF-05
    if (result.stopTurn) this.#o.report(`Tour arrêté par un crochet (${event}) : ${result.stopTurn}`);
    return result;
  }

  /** Waits for the hooks still running without being awaited. */
  async settle(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  /**
   * End of the session (SPEC-HOK-007 FA-01): no more context is delivered; asynchronous hooks go on until their time
   * limit, or are stopped with `hooksConfig.asyncKillOnExit`; the other hooks always finish.
   */
  async close(): Promise<void> {
    this.#closed = true;
    this.#contexts.clear();
    if (this.#o.asyncKillOnExit) {
      this.#queue.length = 0;
      for (const c of this.#controllers) c.abort();
    }
    await this.settle();
    this.#agents.http.destroy();
    this.#agents.https.destroy();
  }

  /**
   * SPEC-PER-001 § 5.3 point c: the `approval_needed` hooks run; only the habilitated ones decide (RG-06), and a failed
   * mandatory control refuses. Undefined when no habilitated hook decided.
   */
  readonly approvalHook: ApprovalHook = {
    decide: async (request: ApprovalRequest) => {
      if (this.#o.policyRefusal?.()) return "deny";
      const event = "approval_needed";
      const fields = { toolId: request.toolName, toolArguments: request.input ?? {}, suggestions: request.suggestions, reason: request.reason, origin: request.origin, ...(request.agent ? { agent: request.agent, approvalMode: request.approvalMode } : {}) };
      const started = this.#start(event, fields, this.#select(event, fields));
      if (started.length === 0) return undefined;
      const habilitated = this.#snapshot.habilitated ?? new Set<HookDeclaration>();
      const outcomes = await Promise.all(
        started.map(async ({ d, outcome }): Promise<ActionOutcome> => {
          const o = await outcome;
          if (habilitated.has(d) || o.failure !== undefined || o.response?.decision === undefined) return o;
          if (!this.#reportedUnhabilitated.has(d.label)) {
            this.#reportedUnhabilitated.add(d.label);
            this.#o.report(`avertissement : crochet ${d.label} : non habilité à répondre aux demandes (permissions.decisionHooks) ; sa décision est ignorée.`);
          }
          const { decision: _decision, reason: _reason, ...rest } = o.response;
          return { ...o, response: rest };
        }),
      );
      const r = this.#apply(event, HOOK_EVENTS[event]!, outcomes);
      return r.decision === "allow" || r.decision === "deny" ? r.decision : undefined;
    },
  };

  // HookBus: the moments of the engine.

  async promptSubmitted(prompt: string) {
    const r = await this.fire("prompt_submitted", { prompt });
    return r?.decision === "block" ? { block: `Message bloqué par un crochet : ${r.reasons.join(" ; ")}` } : r?.stopTurn ? { block: r.stopTurn } : {};
  }

  async beforeTool(call: ToolCall, scope?: AgentScope): Promise<BeforeToolResult> {
    const r = await this.fire("before_tool", { ...scope, toolId: call.name, toolArguments: call.input, toolCallId: call.callId });
    if (!r) return {};
    if (r.modifiedInput) this.#o.report(`Paramètres de ${call.name} modifiés par un crochet : ${JSON.stringify(r.modifiedInput)}`); // CA-03: shown
    return {
      decision: r.decision === "block" ? "deny" : (r.decision as BeforeToolResult["decision"]),
      reason: r.reasons.length > 0 ? `Hook: ${r.reasons.join(" ; ")}` : undefined,
      modifiedInput: r.modifiedInput,
      conflict: r.conflict,
      stopTurn: r.stopTurn !== undefined,
    };
  }

  async afterTool(call: ToolCall, isError: boolean, output?: string, scope?: AgentScope) {
    const r = isError
      ? await this.fire("after_tool_failure", { ...scope, toolId: call.name, toolArguments: call.input, error: output ?? "" })
      : await this.fire("after_tool", { ...scope, callId: call.callId, toolId: call.name, toolArguments: call.input, toolResult: output ?? "" });
    return { stopTurn: r?.stopTurn !== undefined };
  }

  async approvalRefused(call: ToolCall, reason: string, scope?: AgentScope): Promise<void> {
    await this.fire("approval_refused", { ...scope, toolId: call.name, toolArguments: call.input, reason, source: "permission" });
  }

  async turnCompleted(finalText: string) {
    const r = await this.fire("turn_completed", { continuationRequested: false, result: finalText });
    return r?.decision === "continue" && r.reasons.length > 0 ? { continueWith: r.reasons.map((x) => x.replace(/^[^:]+ : /, "")).join("\n") } : {};
  }

  async turnFailed(reason: string): Promise<void> {
    await this.fire("turn_failed", { errorCategory: "error", message: reason });
  }

  async beforeCompaction(instructions: string | undefined) {
    const r = await this.fire("before_compaction", { trigger: "auto", instructions: instructions ?? null });
    return r && r.context.length > 0 ? { additionalInstructions: r.context.join("\n") } : {};
  }

  async afterCompaction(summary: string): Promise<void> {
    await this.fire("after_compaction", { trigger: "auto", summary });
    await this.fire("session_opened", { source: "condense" });
  }
}
