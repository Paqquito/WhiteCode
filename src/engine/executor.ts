// Implements: SPEC-MOT-002 (§ 5.3, EF-01 to EF-07, FA-02 to FA-05, RG-01 to RG-04, ERR-01 to ERR-03, CA-01 to CA-06, CA-08), SPEC-OUT-001 (FA-01, EF-02, EF-05, EF-06, CA-03),
//             SPEC-MOT-046 (§ 5.1 detection before the hook and the permission, § 5.3 points 2 to 5, FA-01 to FA-03, EF-01 to EF-04),
//             SPEC-MOD-006 (FA-05, CA-03 parameters replaced by the control host evaluated again)
// Supports: SPEC-HOK-010 (EF-03 input changed by a hook validated again, ERR-01, ERR-02), SPEC-SES-006 (backup before a write, EF-01), SPEC-PER-001 (decision then resolution of `ask`, CA-05 persisted answer, CA-21 context revalidation), SPEC-PER-003 (CA-08 revalidation), SPEC-OUT-003 (EF-06 difference shown), SPEC-CFG-003 (policy gate before execution), gaps E-022, E-049, E-120, E-131

// Supports: SPEC-PER-018 (private consent state excluded from tool writes), gap E-138.
import type { PermissionMode } from "../config/settings-schema";
import type { HookBus } from "../extension-points/hooks";
import { decide, type Decision, type PermissionContext, type PermissionQuery } from "../permissions/engine";
import { insideAllowed } from "../permissions/paths";
import { resolveAsk, type Authorities } from "../permissions/resolver";
import type { StopReason, ToolCall, ToolResultPart } from "../providers/types";
import type { ToolLookup } from "../tools/registry";
import { textOutcome, type RuleSubject, type Tool, type ToolContext, type ToolOutcome } from "../tools/types";
import type { EventSink } from "./events";
import type { FileChange } from "../shared/diff";
import { REPETITION_REMINDER, type GuardVerdict, type LoopGuard } from "./loop-guard";
import type { ResultStore } from "../session/result-store";
import { boundText } from "../tools/output-bounds";

export interface ExecutorDeps {
  /** Authenticated remote reconnection gate, before previews and immediately before an effect. */
  readonly waitConnected?: (signal: AbortSignal) => Promise<void>;
  /** Supports: SPEC-MOT-029. A speculative turn stops before consulting any approval authority. */
  readonly beforePermissionResolution?: (signal: AbortSignal) => Promise<void>;
  readonly prepareDescriptiveRules?: (query: PermissionQuery, context: PermissionContext, signal: AbortSignal) => Promise<void>;
  /** SPEC-OUT-025: actual executions, with their reviewed difference, after the current plan approval. */
  readonly recordExecution?: (call: ToolCall, outcome: ToolOutcome, difference?: string, change?: FileChange) => void;
  /** Active credential values are masked before hooks, large-result storage, events and model context. */
  readonly redactOutput?: (text: string) => string;
  /** Mandatory policy checked against the raw source before hooks and again after any approval or queue. */
  readonly policyRefusal?: () => string | undefined;
  /** File history of the session (SPEC-SES-006): called around the tools that change files. */
  readonly fileHistory?: { beforeWrite(paths: readonly string[]): string | undefined; afterWrite(paths: readonly string[]): void };
  readonly registry: ToolLookup;
  readonly hooks: HookBus;
  readonly authorities: Authorities;
  /** Shared teammate queue; owns complete permission resolution, including persisted session grants. */
  readonly permissionQueue?: { run<T>(signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T | undefined>; expired?(signal: AbortSignal): boolean };
  /** Permission context read when each call is evaluated (the mode may change during a turn, RG-03 of SPEC-MOT-001). */
  permissionContext(): PermissionContext & { readonly mode: PermissionMode };
  toolContext(signal: AbortSignal): ToolContext;
  readonly concurrency: number;
  readonly toolTimeoutMs: number;
  readonly emit: EventSink;
  /** "Yes, don't ask again": the rule is kept for the session or written to the chosen scope (SPEC-PER-001 CA-05). */
  persistRule?(scope: string, rule: string): void;
  /** Large results (SPEC-OUT-001 FA-01): beyond `limit` characters, stored apart and replaced by a preview. */
  readonly largeResults?: { readonly store: ResultStore; readonly limit: number };
  /** Unproductive loop detection of the agent (SPEC-MOT-046); absent: disabled. */
  readonly loopGuard?: LoopGuard;
}

type Gate = "execute" | "refused" | "truncated" | "aborted";

/** Successive replacements of the parameters by a control host before the call is refused (SPEC-MOD-006 FA-05). */
const MAX_HOST_REVISIONS = 3;

/** Canonical form of parameters, to bind an approval to exactly them (SPEC-PER-001 EF-10). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Time left to a tool with its own limit to stop its processes and report before the executor gives up. */
const TOOL_STOP_MARGIN_MS = 5_000;

class Semaphore {
  #free: number;
  readonly #waiters: Array<() => void> = [];
  constructor(size: number) {
    this.#free = size;
  }
  async acquire(): Promise<() => void> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((r) => this.#waiters.push(r));
    return () => {
      const next = this.#waiters.shift();
      if (next) next();
      else this.#free++;
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T | "timeout"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      onTimeout();
      resolve("timeout");
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Execution of the tool calls of one model response. */
/** A call in rule syntax, such as `run_shell(bun test.js)`, for the refusal message (D-9). */
function actionOf(toolName: string, subject: RuleSubject): string {
  switch (subject.kind) {
    case "command":
      return `${toolName}(${subject.command})`;
    case "paths":
      return `${toolName}(${subject.paths.join(", ")})`;
    case "url":
      return `${toolName}(${subject.url})`;
    case "name":
      return `${toolName}(${subject.name})`;
    case "none":
      return toolName;
  }
}

export class ResponseExecution {
  readonly #deps: ExecutorDeps;
  readonly #controller = new AbortController();
  readonly #semaphore: Semaphore;
  readonly #calls: Array<{ call: ToolCall; done: Promise<ToolResultPart>; safe: boolean }> = [];
  #gateResolve!: (g: Gate) => void;
  readonly #gate: Promise<Gate> = new Promise((r) => (this.#gateResolve = r));
  #stopTurnRequested = false;
  #unproductiveLoop = false;

  constructor(deps: ExecutorDeps, parentSignal: AbortSignal) {
    this.#deps = deps;
    this.#semaphore = new Semaphore(Math.max(1, deps.concurrency));
    if (parentSignal.aborted) this.#controller.abort();
    else parentSignal.addEventListener("abort", () => this.#controller.abort(), { once: true });
  }

  /** True when the user answered "no, and stop" (SPEC-PER-001 FA-01). */
  get stopTurnRequested(): boolean {
    return this.#stopTurnRequested;
  }

  /** True when a second loop was detected in the turn without human interface (SPEC-MOT-046 FA-01). */
  get unproductiveLoop(): boolean {
    return this.#unproductiveLoop;
  }

  /** Called as soon as a tool call is completely received (EF-01). */
  submit(call: ToolCall): void {
    const previous = this.#calls.map((c) => c.done);
    const lastBarrier = [...this.#calls].reverse().find((c) => !c.safe)?.done;
    const tool = this.#deps.registry.get(call.name);
    const input = call.input;
    const schemaErrors = tool ? this.#deps.registry.validateInput(tool, input) : [];
    const flags = tool && schemaErrors.length === 0 ? tool.flags(input as never) : undefined;
    const safe = flags !== undefined && flags.readOnly && flags.concurrencySafe;
    // SPEC-MOT-046: compared on arrival, in call order, before the hook and the permission decision.
    const verdict = tool && schemaErrors.length === 0 ? this.#deps.loopGuard?.check(call.name, input) : undefined;
    const done = this.#run(call, tool, schemaErrors, safe, previous, lastBarrier, verdict).then((outcome) => {
      const part: ToolResultPart = { type: "tool_result", callId: call.callId, isError: outcome.isError, content: outcome.content };
      return part;
    });
    this.#calls.push({ call, done, safe });
  }

  /** Called when the response is complete; unsafe calls wait for this gate (gap E-022). */
  responseComplete(stopReason: StopReason): void {
    this.#gateResolve(stopReason === "refusal" ? "refused" : stopReason === "max_tokens" ? "truncated" : "execute");
  }

  /** Cancels every call; calls not started get a synthetic result (FA-04). */
  cancel(): void {
    this.#gateResolve("aborted");
    this.#controller.abort();
  }

  /** Results in call order (RG-04), once every call has one (EF-06). */
  async results(): Promise<ToolResultPart[]> {
    return Promise.all(this.#calls.map((c) => c.done));
  }

  async #run(
    call: ToolCall,
    tool: Tool<never> | undefined,
    schemaErrors: string[],
    safe: boolean,
    previous: Promise<ToolResultPart>[],
    lastBarrier: Promise<ToolResultPart> | undefined,
    verdict?: GuardVerdict,
  ): Promise<ToolOutcome> {
    const started = Date.now();
    const guard = this.#deps.loopGuard;
    /** `evaluated`: false for permission refusals and suspended calls, which enter no series (§ 5.1 of SPEC-MOT-046). */
    const finish = (result: ToolOutcome, evaluated = true): ToolOutcome => {
      let outcome = this.#redacted(result);
      if (evaluated && guard && tool) {
        // Step 5 of SPEC-MOT-046: at the threshold of identical failures, the reminder is attached, without blocking (CA-04).
        const reminder = guard.record(verdict?.entry, call.name, outcome.isError, outcome.content);
        if (reminder) outcome = { ...outcome, content: [...outcome.content, { type: "text", text: reminder }] };
      } else if (!evaluated && verdict?.entry && guard) guard.forget(verdict.entry);
      const output = outcome.content.map((c) => (c.type === "text" ? c.text : `[${c.mediaType}]`)).join("\n");
      this.#deps.emit({ type: "tool_result", callId: call.callId, isError: outcome.isError, durationMs: Date.now() - started, output, ...(outcome.display !== undefined ? { display: outcome.display } : {}), ...(outcome.displayRaw !== undefined ? { displayRaw: outcome.displayRaw } : {}), ...(outcome.displayRawPath !== undefined ? { displayRawPath: outcome.displayRawPath } : {}) });
      return outcome;
    };
    const signal = this.#controller.signal;
    const policyBlocked = () => {
      const reason = this.#deps.policyRefusal?.();
      return reason ? finish(textOutcome(reason, true, "permission_denied"), false) : undefined;
    };
    try {
      const blocked = policyBlocked();
      if (blocked) return blocked;
      if (!tool) return finish(textOutcome(`Unknown tool: ${call.name}. This tool is not available in this session.`, true, "unavailable")); // ERR-01 of SPEC-MOT-001
      if (schemaErrors.length > 0) return finish(textOutcome(`Invalid input: ${schemaErrors.join("; ")}.`, true, "invalid_input")); // EF-02
      // Unsafe calls wait for the end of the response before anything else (E-022).
      if (!safe) {
        const gate = await this.#gate;
        if (gate === "refused") return finish(textOutcome("Not executed: the response was refused before completion.", true, "not_executed"));
        if (gate === "truncated") return finish(textOutcome("Not executed: the response was cut off by the output limit, so this input may be truncated. Issue the call again.", true, "not_executed"));
        if (gate === "aborted") return finish(textOutcome("Not executed: the turn was interrupted.", true, "interrupted"));
      }
      if (signal.aborted) return finish(textOutcome("Not executed: the turn was interrupted.", true, "interrupted"));
      // Context, validation and permission contributions follow earlier barriers, including a working-folder switch.
      if (safe) await lastBarrier;
      else await Promise.allSettled(previous);
      if (signal.aborted) return finish(textOutcome("Not executed: the turn was interrupted.", true, "interrupted"));
      const ctx = this.#deps.toolContext(signal);
      await this.#deps.waitConnected?.(signal);
      const businessError = tool.validate?.(call.input as never, ctx);
      if (businessError) return finish(textOutcome(businessError, true, "invalid_input"));

      // Suspended repeated call (SPEC-MOT-046 § 5.3): the user chooses; without interface, never executed (EF-02).
      if (verdict?.suspend && guard) {
        this.#deps.emit({ type: "loop_detected", callId: call.callId, toolName: call.name, count: verdict.count });
        const human = this.#deps.authorities.human;
        if (human?.loopDetected && this.#deps.permissionContext().mode !== "no_prompt") {
          const choice = await human.loopDetected({ toolName: call.name, summary: tool.summary(call.input as never), count: verdict.count }, signal);
          if (choice.choice === "stop") {
            this.#stopTurnRequested = true;
            return finish(textOutcome("Not executed: the user stopped the turn after this repeated call.", true, "not_executed"), false);
          }
          if (choice.choice === "reply") return finish(textOutcome(`Not executed. The user replies: ${choice.message}`, true, "not_executed"), false);
          guard.continueAnyway(verdict.entry); // CA-07: the call goes on through the hook and the permission decision
        } else {
          if (guard.loopsInTurn >= 2) this.#unproductiveLoop = true; // FA-01, EF-03
          return finish(textOutcome(REPETITION_REMINDER(verdict.count), true, "not_executed"), false);
        }
      }

      // Hook, decision and resolution (steps 2 and 3 of § 5.3). Parameters replaced by a control host go through them
      // again, as if they came from the model (SPEC-MOD-006 FA-05, SPEC-PER-001 EF-11); its approval covers exactly them.
      let approvedByHost: { input: string; context: string } | undefined;
      let replacedByHost = false;
      let replacementSource="control host";
      let replacedByDelegate = false;
      let preview: Awaited<ReturnType<NonNullable<typeof tool.preview>>> | undefined;
      let subject: RuleSubject;
      let query: PermissionQuery;
      let decision: Decision;
      let pctx: ReturnType<ExecutorDeps["permissionContext"]>;
      let evaluatedContext: string;
      for (let round = 0; ; round++) {
        const blocked = policyBlocked();
        if (blocked) return blocked;
        // Hook first (step 2 of § 5.3): a changed input is the one shown, decided and executed (SPEC-HOK-010 EF-03, CA-03).
        const hook = await this.#deps.hooks.beforeTool(call);
        if (signal.aborted) return finish(textOutcome("Not executed: the turn was interrupted.", true, "interrupted"), false);
        const afterHook = policyBlocked();
        if (afterHook) return afterHook;
        if (hook.stopTurn) this.#stopTurnRequested = true;
        if (hook.conflict) return finish(textOutcome(`Blocked: ${hook.reason ?? "several hooks change this call in incompatible ways."}`, true, "permission_denied"), false); // SPEC-HOK-010 ERR-01
        if (hook.modifiedInput) {
          const changed = { ...(call.input as Record<string, unknown>), ...hook.modifiedInput };
          const errors = this.#deps.registry.validateInput(tool, changed);
          const business = errors.length === 0 ? tool.validate?.(changed as never, ctx) : undefined;
          if (errors.length > 0 || business) {
            return finish(textOutcome(`Blocked: the parameters changed by a hook are invalid: ${[...errors, ...(business ? [business] : [])].join("; ")}.`, true, "invalid_input"), false); // SPEC-HOK-010 ERR-02
          }
          call = { ...call, input: changed };
        }

        subject = tool.ruleSubject(call.input as never, ctx);
        if (subject.kind === "paths" && subject.access === "write" && subject.paths.some((path) => ctx.writeDenied?.(path)))
          return finish(await this.#refuse(call, "Product-owned user state is changed only through its human consent and preference commands.", 1), false);
        // Difference, or refusal found before asking (SPEC-OUT-003 EF-06).
        preview = tool.preview ? await tool.preview(call.input as never, ctx) : undefined;
        if (preview && "refusal" in preview) return finish(preview.refusal);

        // Permission decision, then resolution of an `ask` (step 3 of § 5.3).
        pctx = this.#deps.permissionContext();
        evaluatedContext = canonical(pctx);
        const target = subject;
        query = {
          toolName: tool.permissionName ?? tool.name,
          subject,
          flags: tool.flags(call.input as never),
          contribution: tool.permissionContribution?.(call.input as never, ctx),
          hookDecision: hook.decision,
          hookReason: hook.reason,
          available: true,
          fileWriteInsideAllowed: target.kind === "paths" && target.access === "write" && target.paths.every((p) => insideAllowed(p, ctx.allowedDirectories, ctx.platform)),
        };
        await this.#deps.prepareDescriptiveRules?.(query,pctx,signal);
        pctx=this.#deps.permissionContext();evaluatedContext=canonical(pctx);
        decision = decide(query, pctx);
        if (preview && "humanOnly" in preview && preview.humanOnly && decision.kind !== "deny") decision = { kind: "ask", step: 4, origin: "explicit", reason: "A block anchor requires confirmation of the actual replacement by a human.", suggestions: [] };
        // The host already approved these very parameters: a decision `ask` on them is its answer (RG-06 of SPEC-MOD-006).
        if (decision.kind === "ask" && approvedByHost?.input === canonical(call.input) && approvedByHost.context === evaluatedContext) {
          this.#deps.emit({ type: "permission", callId: call.callId, decision: "allow", reason: "approved by control_host (parameters replaced)", step: decision.step });
          break;
        }
        if (decision.kind === "ask") await this.#deps.beforePermissionResolution?.(signal);
        const resolved = await this.#resolve(call, tool, decision, pctx.mode, preview && "diff" in preview ? preview : undefined, signal, subject, query);
        if (!resolved.allowed) return finish(preview && "humanOnly" in preview && preview.humanOnly ? textOutcome("Passage not found: the anchored edit was not confirmed by a human.", true, "invalid_input") : await this.#refuse(call, resolved.reason, decision.step), false);
        if (!resolved.input) break;
        if (round + 1 >= MAX_HOST_REVISIONS) return finish(await this.#refuse(call, "the control host replaced the parameters too many times.", decision.step), false);
        const errors = this.#deps.registry.validateInput(tool, resolved.input);
        const business = errors.length === 0 ? tool.validate?.(resolved.input as never, ctx) : undefined;
        if (errors.length > 0 || business) {
          return finish(textOutcome(`Blocked: the parameters given by the control host are invalid: ${[...errors, ...(business ? [business] : [])].join("; ")}.`, true, "invalid_input"), false);
        }
        call = { ...call, input: resolved.input };
        approvedByHost = resolved.replacementNeedsReview ? undefined : { input: canonical(resolved.input), context: evaluatedContext };
        replacedByHost = true;
        replacementSource=resolved.replacementSource??replacementSource;
        replacedByDelegate ||= resolved.replacementNeedsReview === true;
      }

      // Scheduling (RG-01 to RG-03): a safe call waits for the last barrier; a barrier waits for every previous call.
      const release = await this.#semaphore.acquire();
      try {
        await this.#deps.waitConnected?.(signal);
        if (signal.aborted) return finish(textOutcome("Not executed: the turn was interrupted.", true, "interrupted"));
        const blocked = policyBlocked();
        if (blocked) return blocked;
        // Any security-context change is relevant, including rules changed without a mode change.
        // An unchanged approval remains bound to this call; changed contexts are resolved again, at most three times.
        for (let revision = 0; ; revision++) {
          let now = this.#deps.permissionContext();
          await this.#deps.prepareDescriptiveRules?.(query,now,signal);
          now = this.#deps.permissionContext();
          let again = decide(query, now);
          if (preview && "humanOnly" in preview && preview.humanOnly) {
            if (now.mode !== "ask" && now.mode !== "auto_approve") return finish(textOutcome("Passage not found: the permission mode changed before the anchored edit.", true, "invalid_input"), false);
            if (again.kind !== "deny") again = { kind: "ask", step: 4, origin: "explicit", reason: "A block anchor requires human confirmation.", suggestions: [] };
          }
          if (again.kind === "deny") return finish(await this.#refuse(call, again.reason, again.step), false);
          const currentContext = canonical(now);
          if (again.kind !== "ask" || currentContext === evaluatedContext) break;
          if (revision >= MAX_HOST_REVISIONS) return finish(await this.#refuse(call, "The permission context keeps changing. Submit this call again after it stabilizes.", again.step), false);
          const second = await this.#resolve(call, tool, again, now.mode, preview && "diff" in preview ? preview : undefined, signal, subject, query);
          if (!second.allowed) return finish(await this.#refuse(call, second.reason, again.step), false);
          // A replacement at this late stage needs the complete hook, preview and business-validation pipeline.
          if (second.input) return finish(await this.#refuse(call, "The permission context changed and the new approval replaced the input. Submit those parameters as a fresh call for full validation.", again.step), false);
          pctx = now;
          evaluatedContext = currentContext;
        }
        if (signal.aborted) return finish(textOutcome("Not executed: the turn was interrupted.", true, "interrupted"));
        // SPEC-SES-006 EF-01, ERR-01: the files a tool changes are saved first; without a backup, no change.
        const afterApproval = policyBlocked();
        if (afterApproval) return afterApproval;
        const writes = subject.kind === "paths" && subject.access === "write" ? subject.paths : [];
        if (writes.some((path) => ctx.writeDenied?.(path)))
          return finish(await this.#refuse(call, "Product-owned user state is changed only through its human consent and preference commands.", 1), false);
        if (writes.length > 0 && this.#deps.fileHistory) {
          const refusal = this.#deps.fileHistory.beforeWrite(writes);
          if (refusal !== undefined) return finish(textOutcome(refusal, true, "execution"));
        }
        this.#deps.emit({ type: "tool_started", callId: call.callId });
        const callController = new AbortController();
        const onAbort = () => callController.abort();
        signal.addEventListener("abort", onAbort, { once: true });
        const execution = tool.execute(call.input as never, { ...ctx, signal: callController.signal }).catch(
          (error: unknown) => textOutcome(`The tool failed: ${(error as Error)?.message ?? String(error)}`, true, "execution"), // ERR-02
        );
        // EF-05: the own limit of the tool (plus the grace period of its own stop), bounded by `engine.toolTimeout`.
        const own = tool.timeoutMs?.(call.input as never, ctx);
        const limit = tool.idleWait && own !== undefined ? Math.min(3606000, own + TOOL_STOP_MARGIN_MS) : own === undefined ? this.#deps.toolTimeoutMs : Math.min(own + TOOL_STOP_MARGIN_MS, this.#deps.toolTimeoutMs);
        const outcome = await withTimeout(execution, limit, () => callController.abort());
        signal.removeEventListener("abort", onAbort);
        if (writes.length > 0) this.#deps.fileHistory?.afterWrite(writes);
        if (outcome === "timeout") return finish(textOutcome(`Timed out after ${Math.round(limit / 1000)} s.`, true, "timeout")); // ERR-03, CA-05
        if (signal.aborted) return finish(textOutcome("Interrupted by the user.", true, "interrupted"));
        const afterExecution = this.#deps.policyRefusal?.();
        if (afterExecution) return finish({ ...outcome, content: [...outcome.content, { type: "text", text: `This tool completed before the policy check failed. No subsequent hook was run. ${afterExecution}` }] });
        const safeOutcome = this.#redacted(outcome);
        this.#deps.recordExecution?.(call, safeOutcome, preview && "diff" in preview ? preview.diff : undefined, preview && "change" in preview ? preview.change : undefined);
        const after = await this.#deps.hooks.afterTool(call, safeOutcome.isError, safeOutcome.content.map((c) => (c.type === "text" ? c.text : `[${c.mediaType}]`)).join("\n"));
        if (after.stopTurn) this.#stopTurnRequested = true;
        // The model learns that the call ran with other parameters than its own (SPEC-MOD-006 FA-05).
        const told = replacedByHost ? { ...safeOutcome, content: [{ type: "text" as const, text: `[The ${replacedByDelegate ? "permission delegate" : replacementSource} replaced the parameters of this call with: ${JSON.stringify(call.input)}]` }, ...safeOutcome.content] } : safeOutcome;
        return finish(this.#storeIfLarge(call, this.#redacted(told)));
      } finally {
        release();
      }
    } catch (error) {
      return finish(textOutcome(`The tool failed: ${(error as Error)?.message ?? String(error)}`, true, "execution"));
    }
  }

  /** FA-01 of SPEC-OUT-001: a result beyond the inline limit is written to the session folder; the model gets its start, its end and the path. */
  #redacted(outcome: ToolOutcome): ToolOutcome {
    const redact = this.#deps.redactOutput;
    return redact ? { ...outcome, ...(outcome.display !== undefined ? { display: redact(outcome.display) } : {}), ...(outcome.displayRaw !== undefined ? { displayRaw: redact(outcome.displayRaw) } : {}), content: outcome.content.map((part) => part.type === "text" ? { ...part, text: redact(part.text) } : part) } : outcome;
  }

  /** FA-01 of SPEC-OUT-001: a result beyond the inline limit is written to the session folder; the model gets its start, its end and the path. */
  #storeIfLarge(call: ToolCall, outcome: ToolOutcome): ToolOutcome {
    const large = this.#deps.largeResults;
    if (!large) return outcome;
    const text = outcome.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
    if (text.length <= large.limit) return outcome;
    const path = large.store.store(`${call.name}-${call.callId}`, text);
    const preview = boundText(text, Math.min(4000, large.limit)).text;
    const images = outcome.content.filter((c) => c.type === "image");
    return {
      ...outcome,
      content: [{ type: "text", text: `${preview}\n\n[The result has ${text.length} characters; the complete result is in ${path} (readable with read_file, with offset and limit).]` }, ...images],
    };
  }

  /** Resolution of a decision; an `ask` goes to the authorities of § 5.3 with the difference to show. */
  async #resolve(
    call: ToolCall,
    tool: Tool<never>,
    decision: Decision,
    mode: PermissionMode,
    shown: { readonly diff: string; readonly change?: FileChange; readonly humanOnly?: boolean } | undefined,
    signal: AbortSignal,
    subject: RuleSubject,
    query?: PermissionQuery,
    queued = false,
  ): Promise<{ allowed: boolean; reason: string; input?: Record<string, unknown>; replacementNeedsReview?: boolean; replacementSource?:string }> {
    if (signal.aborted) return { allowed: false, reason: "The call was cancelled." };
    if (decision.kind === "ask" && this.#deps.permissionQueue && !queued) {
      return await this.#deps.permissionQueue.run(signal, active => {
        const context = this.#deps.permissionContext();
        let fresh = query ? decide(query, context) : decision;
        if (shown?.humanOnly && fresh.kind !== "deny") fresh = { kind: "ask", step: 4, origin: "explicit", reason: "A block anchor requires human confirmation.", suggestions: [] };
        return this.#resolve(call, tool, fresh, context.mode, shown, active, subject, query, true);
      }) ?? { allowed: false, reason: "The teammate permission deadline expired or the call was cancelled." };
    }
    if (decision.kind === "allow") {
      this.#deps.emit({ type: "permission", callId: call.callId, decision: "allow", reason: decision.why, step: decision.step });
      return { allowed: true, reason: decision.why };
    }
    if (decision.kind === "deny") return { allowed: false, reason: decision.reason };
    const resolution = await resolveAsk(
      decision,
      {
        callId: call.callId,
        toolName: tool.name,
        summary: tool.summary(call.input as never),
        input: call.input as Record<string, unknown>,
        action: actionOf(tool.name, subject),
        reason: decision.reason,
        origin: decision.origin,
        approvalMode: mode,
        ...(tool.flags(call.input as never).explicitApproval ? { planApproval: true } : {}),
        ...(shown?.humanOnly ? { humanOnly: true } : {}),
        suggestions: decision.suggestions,
        ...(shown?.diff ? { preview: shown.diff } : {}),
        ...(shown?.change ? { change: shown.change } : {}),
        ...(tool.danger?.(call.input as never) ? { danger: tool.danger(call.input as never) } : {}),
      },
      mode,
      this.#deps.authorities,
      signal,
    );
    const policyRefusal = this.#deps.policyRefusal?.();
    if (signal.aborted || this.#deps.permissionQueue?.expired?.(signal)) return { allowed: false, reason: "The call was cancelled or its permission deadline expired; its approval is no longer valid." };
    if (policyRefusal) return { allowed: false, reason: policyRefusal };
    if (resolution.decision === "deny") {
      if (resolution.stopTurn) this.#stopTurnRequested = true;
      return { allowed: false, reason: resolution.reason };
    }
    if (resolution.persist && !shown?.humanOnly) this.#deps.persistRule?.(resolution.persist.scope, resolution.persist.rule);
    // Replaced parameters are not allowed yet: they are evaluated again first (FA-05 of SPEC-MOD-006).
    if (resolution.input) return { allowed: true, reason: `parameters replaced by ${resolution.by}`, input: resolution.input, replacementSource:resolution.by==="human"?"human in the IDE":resolution.by==="delegate"?"permission delegate":"control host",replacementNeedsReview: resolution.by === "delegate" && canonical(resolution.input) !== canonical(call.input) };
    const reason = `approved by ${resolution.by}`;
    this.#deps.emit({ type: "permission", callId: call.callId, decision: "allow", reason, step: decision.step });
    return { allowed: true, reason };
  }

  async #refuse(call: ToolCall, reason: string, step = 0): Promise<ToolOutcome> {
    this.#deps.emit({ type: "permission", callId: call.callId, decision: "deny", reason, step });
    await this.#deps.hooks.approvalRefused(call, reason);
    return textOutcome(`Action denied: ${reason}`, true, "permission_denied"); // FA-02
  }
}
