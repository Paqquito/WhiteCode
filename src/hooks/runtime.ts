// Implements: SPEC-HOK-001 (§ 5.1 common fields, § 5.4 steps 1 to 4, EF-01, EF-02, EF-04, RG-02, CA-01 to CA-03, CA-05), SPEC-HOK-002 (§ 5.4 step 3, CA-01),
//             SPEC-HOK-003 (§ 5.1 variables, § 5.3 steps 4 and 5, FA-02, EF-02, EF-04, CA-01 to CA-04), SPEC-HOK-010 (§ 5.4 steps 1 and 6, EF-05, CA-01, CA-04, CA-05)
// Supports: SPEC-MOT-001 (EF-08 hooks of the loop), SPEC-MOT-005 (`instructions_read`), SPEC-CFG-005 (`settings_modified`)
// The hooks of a session: payloads, selection, execution in parallel, aggregation and the effects of the decisions.

import type { HookBus, BeforeToolResult } from "../extension-points/hooks";
import type { ToolCall } from "../providers/types";
import { aggregate, parseResponse, type ActionOutcome, type Aggregated } from "./aggregate";
import { runCommandHook, type ShellChoice } from "./command";
import type { HookDeclaration, HookSnapshot } from "./config";
import { HOOK_EVENTS, PAYLOAD_SCHEMA_VERSION } from "./events";
import type { PlatformName } from "../platform/system";

export interface HookRuntimeOptions {
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
  /** Messages for the user: blocks, user messages, failures (SPEC-HOK-010 EF-05, SPEC-HOK-003 EF-02). */
  readonly report: (message: string) => void;
  /** Context for the model, through a system reminder (SPEC-HOK-010 § 5.1). */
  readonly addContext: (text: string, label: string) => void;
  readonly clock?: () => Date;
}

export class HookRuntime implements HookBus {
  readonly #o: HookRuntimeOptions;
  #snapshot: HookSnapshot;
  readonly #pending = new Set<Promise<unknown>>();
  /** Session variables returned by `session_opened` hooks (SPEC-HOK-010 § 5.1, SPEC-SES-018). */
  readonly sessionEnv: Record<string, string> = {};

  constructor(options: HookRuntimeOptions) {
    this.#o = options;
    this.#snapshot = options.snapshot;
  }

  /** A new snapshot after a change of the settings (SPEC-HOK-002 FA-01, SPEC-CFG-005). */
  replaceSnapshot(snapshot: HookSnapshot): void {
    this.#snapshot = snapshot;
  }

  /** Declarations whose filter matches (SPEC-HOK-002 § 5.4 step 3). */
  #select(event: string, fields: Record<string, unknown>): HookDeclaration[] {
    const field = HOOK_EVENTS[event]?.discriminant;
    const value = field ? fields[field] : undefined;
    return this.#snapshot.declarations.filter((d) => d.event === event && d.matches(value === undefined ? undefined : String(value)));
  }

  /** Step 1: common fields and the fields of the event; large tool results cut with a flag (EF-04). */
  #payload(event: string, fields: Record<string, unknown>): string {
    const p: Record<string, unknown> = {
      schemaVersion: PAYLOAD_SCHEMA_VERSION,
      event,
      sessionId: this.#o.sessionId,
      // CA-05: an opaque reference to the transcript, never a path of the session store.
      transcriptRef: `session:${this.#o.sessionId}`,
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

  async #runAction(d: HookDeclaration, index: number, payload: string, event: string, fields: Record<string, unknown>): Promise<ActionOutcome> {
    const action = d.actions[index]!;
    const label = d.actions.length > 1 ? `${d.label}[${index + 1}]` : d.label;
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
    const run = await runCommandHook(action, payload, { cwd: this.#o.cwd, env, shell, timeoutMs, outputMaxSize: this.#o.outputMaxSize, platform: this.#o.platform });
    if (run.timedOut) return { label, mandatory: d.mandatory, failure: `arrêté après ${Math.round(timeoutMs / 1000)} s` }; // ERR-02
    if (run.exitCode === 127) return { label, mandatory: d.mandatory, failure: "commande introuvable" }; // ERR-01
    if (run.exitCode !== 0) return { label, mandatory: d.mandatory, failure: `code de sortie ${run.exitCode}${run.stderr.trim() ? ` : ${run.stderr.trim().slice(0, 300)}` : ""}` }; // EF-02: never blocking
    const parsed = parseResponse(run.stdout);
    if (parsed.nonConforming) return { label, mandatory: d.mandatory, failure: `réponse non conforme (${parsed.nonConforming})` }; // FA-01
    return { label, mandatory: d.mandatory, response: parsed.response, text: parsed.response ? undefined : run.stdout.trim() || undefined };
  }

  /** Steps 2 to 4 of SPEC-HOK-001 § 5.4 and the user-facing effects; undefined when no hook matched (FA-01). */
  async fire(event: string, fields: Record<string, unknown>): Promise<Aggregated | undefined> {
    const info = HOOK_EVENTS[event]!;
    const selected = this.#select(event, fields);
    if (selected.length === 0) return undefined;
    const payload = this.#payload(event, fields);
    const runs = selected.flatMap((d) => d.actions.map((_, i) => ({ d, run: () => this.#runAction(d, i, payload, event, fields) })));
    const waited = runs.filter((r) => info.synchronous && !r.d.async);
    // Asynchronous hooks are not awaited (SPEC-HOK-007); the session waits for them before it ends.
    for (const r of runs.filter((x) => !waited.includes(x))) {
      const p = r.run().then((o) => {
        if (o.failure !== undefined) this.#o.report(`avertissement : crochet ${o.label} (${event}) : ${o.failure}`);
      });
      this.#pending.add(p);
      void p.finally(() => this.#pending.delete(p));
    }
    if (waited.length === 0) return undefined;
    const outcomes = await Promise.all(waited.map((r) => r.run())); // RG-02 of SPEC-HOK-010: in parallel
    const result = aggregate(info, outcomes);
    for (const n of result.notices) this.#o.report(`avertissement : ${n}`);
    for (const m of result.userMessages) this.#o.report(`crochet ${m}`);
    for (const c of result.context) this.#o.addContext(c, event);
    Object.assign(this.sessionEnv, result.sessionEnv);
    if (result.decision === "deny" || result.decision === "block") this.#o.report(`Bloqué par un crochet (${event}) : ${result.reasons.join(" ; ") || "sans raison donnée"}`); // EF-05
    if (result.stopTurn) this.#o.report(`Tour arrêté par un crochet (${event}) : ${result.stopTurn}`);
    return result;
  }

  /** Waits for the hooks still running without being awaited (end of session). */
  async settle(): Promise<void> {
    await Promise.allSettled([...this.#pending]);
  }

  // HookBus: the moments of the engine.

  async promptSubmitted(prompt: string) {
    const r = await this.fire("prompt_submitted", { prompt });
    return r?.decision === "block" ? { block: `Message bloqué par un crochet : ${r.reasons.join(" ; ")}` } : r?.stopTurn ? { block: r.stopTurn } : {};
  }

  async beforeTool(call: ToolCall): Promise<BeforeToolResult> {
    const r = await this.fire("before_tool", { toolId: call.name, toolArguments: call.input, toolCallId: call.callId });
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

  async afterTool(call: ToolCall, isError: boolean, output?: string) {
    const r = isError
      ? await this.fire("after_tool_failure", { toolId: call.name, toolArguments: call.input, error: output ?? "" })
      : await this.fire("after_tool", { toolId: call.name, toolArguments: call.input, toolResult: output ?? "" });
    return { stopTurn: r?.stopTurn !== undefined };
  }

  async approvalRefused(call: ToolCall, reason: string): Promise<void> {
    await this.fire("approval_refused", { toolId: call.name, toolArguments: call.input, reason, source: "permission" });
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

