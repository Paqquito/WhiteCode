// Implements: SPEC-MOT-012 (§ 5.1 to 5.4, FA-01, FA-02, EF-01 to EF-05, ERR-01, RG-01, CA-01 to CA-04), SPEC-MOT-013 (§ 5.2 triggers, EF-04),
//             SPEC-MOT-014 (§ 5.3 points 1 to 3, FA-01, EF-01, EF-02, CA-01)
// Supports: decision D-12 and architecture § 7.2 (choice of the mechanism by the catalogue capabilities), gap E-061

import type { ContextEditingStrategy, ModelRequest } from "../providers/types";
import { compactConversation, type CompactionDeps, type CompactionOutcome } from "./compaction";
import type { ContextMeter } from "./context-meter";
import { microCompact } from "./micro-compaction";

export interface ContextSettings {
  readonly autoCompact: { readonly enabled: boolean; readonly warnRatio: number; readonly urgentRatio: number; readonly triggerRatio: number; readonly maxFailures: number };
  readonly microCompact: { readonly enabled: boolean; readonly triggerRatio: number; readonly keepRecent: number; readonly idleMinutes: number };
  readonly providerContextManagement: { readonly enabled: boolean; readonly targetTokens: number };
}

const WRITE_TOOLS = ["write_file", "edit_file", "update_notebook_cell"];

export type BeforeRequest = { readonly stop?: { readonly cause: "budget_limit" | "cost_cap_unverifiable"; readonly message: string } };

/** Context of the main agent: occupation, warnings, micro-compaction, automatic compaction and its breaker. */
export class ContextManager {
  #failures = 0;
  #breakerOpen = false;
  #warned: "none" | "warn" | "urgent" = "none";
  #lastResponseAt: number | undefined;
  /** Disabled for the session after a rejection by the service (ERR-01 of SPEC-MOT-014). */
  #serviceClearingRejected = false;

  constructor(
    readonly meter: ContextMeter,
    readonly settings: ContextSettings,
    private readonly compaction: Omit<CompactionDeps, "meter">,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Service-side clearing is used when the model declares it and the user did not disable it (EF-01, FA-01, CA-01). */
  get serviceClearing(): boolean {
    return this.settings.providerContextManagement.enabled && this.compaction.model.capabilities.contextEditing && !this.#serviceClearingRejected;
  }

  /** Local micro-compaction: only for a history that is not append-only (D-12), and never with service-side clearing (EF-02). */
  get localMicroCompaction(): boolean {
    return this.settings.microCompact.enabled && !this.compaction.model.capabilities.appendOnlyHistory && !this.serviceClearing;
  }

  /** Consecutive failures of the automatic compaction (FA-01). */
  get failures(): number {
    return this.#failures;
  }

  serviceClearingRejected(): void {
    this.#serviceClearingRejected = true;
  }

  /** Strategy joined to the request when service-side clearing is active (§ 5.3 point 2). */
  strategy(): ContextEditingStrategy | undefined {
    if (!this.serviceClearing) return undefined;
    const trigger = Math.floor(this.meter.effectiveWindow * this.settings.microCompact.triggerRatio);
    const target = this.settings.providerContextManagement.targetTokens;
    return { triggerTokens: trigger, keepToolUses: this.settings.microCompact.keepRecent, clearAtLeastTokens: trigger > target ? trigger - target : undefined, clearInputsOf: WRITE_TOOLS };
  }

  responseReceived(): void {
    this.#lastResponseAt = this.clock();
  }

  /** Manual compaction through the engine API (the `/condense` command is out of lot 1). */
  compactNow(instructions: string | undefined, signal: AbortSignal): Promise<CompactionOutcome> {
    return compactConversation({ ...this.compaction, meter: this.meter }, instructions, false, signal);
  }

  /** Evaluation before each request of the main loop (§ 5.2 of SPEC-MOT-012), between two iterations only (RG-01). */
  async beforeRequest(signal: AbortSignal): Promise<BeforeRequest> {
    const conv = this.compaction.conversation;
    const emit = this.compaction.emit;
    const measure = () => this.meter.occupation(conv.system, conv.tools, conv.messages, conv.segment);

    // SPEC-MOT-013: by threshold, or after an idle period since the last response (main loop only, EF-04).
    if (this.localMicroCompaction) {
      const idle = this.#lastResponseAt !== undefined && this.clock() - this.#lastResponseAt > this.settings.microCompact.idleMinutes * 60_000;
      if (idle || measure().ratio > this.settings.microCompact.triggerRatio) {
        const removed = microCompact(conv, this.settings.microCompact.keepRecent);
        if (removed > 0) {
          this.meter.invalidate();
          emit({ type: "micro_compacted", removed, reason: idle ? "idle" : "threshold" });
        }
      }
    }

    const o = measure();
    const a = this.settings.autoCompact;
    const pct = `${Math.round(o.ratio * 100)} %`;
    if (o.ratio >= a.urgentRatio && this.#warned !== "urgent") {
      this.#warned = "urgent";
      emit({ type: "warning", message: `Contexte occupé à ${pct} : une compaction est recommandée.` });
    } else if (o.ratio >= a.warnRatio && this.#warned === "none") {
      this.#warned = "warn";
      emit({ type: "warning", message: `Contexte occupé à ${pct} (${Math.max(0, o.effectiveWindow - o.tokens)} jetons restants).` });
    }
    if (o.ratio < a.triggerRatio || !a.enabled) return {}; // CA-03: warnings only when disabled
    if (this.#breakerOpen) return {}; // CA-02: the breaker prevents repeated attempts

    emit({ type: "warning", message: `Contexte occupé à ${pct} : compaction automatique.` }); // EF-02
    const outcome = await compactConversation({ ...this.compaction, meter: this.meter }, undefined, true, signal);
    if (outcome.kind === "compacted") {
      this.#failures = 0;
      this.#warned = "none";
      return {};
    }
    if (outcome.kind === "budget") return { stop: { cause: outcome.cause, message: outcome.message } }; // FA-01, CA-04: not a failure
    if (outcome.kind === "failed") {
      this.#failures++;
      emit({ type: "warning", message: outcome.message });
      if (this.#failures >= a.maxFailures) {
        this.#breakerOpen = true;
        emit({ type: "warning", message: "Compaction automatique suspendue après plusieurs échecs." }); // ERR-01
      }
    }
    return {};
  }

  /** Neutral fields joined to the request. */
  decorate(request: ModelRequest): ModelRequest {
    const strategy = this.strategy();
    return strategy ? { ...request, contextEditing: strategy } : request;
  }
}
