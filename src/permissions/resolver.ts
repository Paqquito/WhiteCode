// Implements: SPEC-PER-001 (§ 5.3 handling of an `ask` decision, points a to d, resolution table, FA-01, FA-02, EF-10, EF-12, RG-05, RG-06)
// Only designated or habilitated authorities decide; their mere presence is not enough (RG-06).

import type { PermissionMode } from "../config/settings-schema";
import type { AskOrigin, Decision } from "./engine";
import type { FileChange } from "../shared/diff";

export type HumanAnswer =
  | { readonly answer: "yes" }
  | { readonly answer: "yes_always"; readonly scope: "session" | "local" | "project" | "user"; readonly rule: string }
  | { readonly answer: "no" }
  | { readonly answer: "no_explain"; readonly explanation: string }
  | { readonly answer: "no_stop" };

export interface ApprovalRequest {
  readonly callId: string;
  readonly toolName: string;
  readonly summary: string;
  /** Parameters of the call, for the `approval_needed` hooks (SPEC-HOK-001 § 5.2). */
  readonly input?: Readonly<Record<string, unknown>>;
  /** The call in rule syntax, such as `run_shell(bun test.js)`: names the exact action in a refusal (D-9). */
  readonly action?: string;
  readonly reason: string;
  readonly origin: AskOrigin;
  readonly suggestions: readonly string[];
  /** Difference of the change, shown before confirmation (SPEC-OUT-003 EF-06). */
  readonly preview?: string;
  /** The change itself, for a structured presentation (SPEC-IHM-005). */
  readonly change?: FileChange;
  /** Identity of the requesting agent when relayed (sub-agent, teammate). */
  readonly requester?: string;
  /** Why the action is dangerous, if it is (SPEC-IHM-027 § 5.3 point 1). */
  readonly danger?: string;
}

/** Choice of the user when a loop is detected (SPEC-MOT-046 § 5.3 point 3). */
export type LoopChoice = { readonly choice: "continue" } | { readonly choice: "stop" } | { readonly choice: "reply"; readonly message: string };

/** Local dialog or designated control host (SPEC-IHM-027, SPEC-MOD-006). */
export interface HumanApprovalChannel {
  request(request: ApprovalRequest, signal: AbortSignal): Promise<HumanAnswer>;
  /** Suspended repeated call (SPEC-MOT-046); absent: the channel cannot decide it and the call is handled as without interface. */
  loopDetected?(info: { readonly toolName: string; readonly summary: string; readonly count: number }, signal: AbortSignal): Promise<LoopChoice>;
}

/** Non-interactive delegate designated for this run (SPEC-PER-028). */
export interface DecisionDelegate {
  decide(request: ApprovalRequest, signal: AbortSignal): Promise<"allow" | "deny" | undefined>;
}

/** Habilitated `approval_needed` hook (§ 5.3 point c). */
export interface ApprovalHook {
  decide(request: ApprovalRequest, signal: AbortSignal): Promise<"allow" | "deny" | undefined>;
}

/** Approval classifier of `auto_approve` (SPEC-PER-004). */
export interface ApprovalClassifier {
  decide(request: ApprovalRequest, signal: AbortSignal): Promise<"allow" | "block" | "unavailable">;
}

export interface Authorities {
  readonly human?: HumanApprovalChannel;
  readonly delegate?: DecisionDelegate;
  readonly habilitatedHook?: ApprovalHook;
  readonly classifier?: ApprovalClassifier;
}

export type Resolution =
  | { readonly decision: "allow"; readonly by: "human" | "delegate" | "hook" | "classifier"; readonly persist?: { scope: string; rule: string } }
  | { readonly decision: "deny"; readonly by: "human" | "delegate" | "hook" | "classifier" | "none"; readonly reason: string; readonly stopTurn?: boolean };

/**
 * Refusal without any authority (decisions D-21 and D-22, correction D-9): the message names the action, says that nobody
 * can approve it in this run, and that only this call is refused, so that the model neither gives up on the commands the
 * task needs nor asks for this one again.
 */
function noAuthority(request: ApprovalRequest, cause: string): string {
  return (
    `Not allowed in this run: ${request.action ?? request.summary}. ${cause} Nobody can approve it during this run, so do not try it again. ` +
    "Only this exact call is refused: other commands, such as the ones the task asks for, may be allowed by the rules, so still run them. " +
    "To read, search or change files, use the file tools rather than shell commands."
  );
}

export async function resolveAsk(
  decision: Extract<Decision, { kind: "ask" }>,
  request: ApprovalRequest,
  mode: PermissionMode,
  authorities: Authorities,
  signal: AbortSignal,
): Promise<Resolution> {
  // Point a: no_prompt, any origin: only a designated delegate; never a dialog nor a hook.
  if (mode === "no_prompt") {
    if (authorities.delegate) {
      const d = await authorities.delegate.decide(request, signal);
      if (d === "allow") return { decision: "allow", by: "delegate" };
      if (d === "deny") return { decision: "deny", by: "delegate", reason: "Denied by the designated delegate." };
    }
    return { decision: "deny", by: "none", reason: noAuthority(request, `${decision.reason} (no_prompt mode)`) };
  }

  // Point b: auto_approve, tool check or default origin: the classifier, never a hook nor a delegate.
  if (mode === "auto_approve" && (decision.origin === "tool_check" || decision.origin === "default")) {
    const verdict = authorities.classifier ? await authorities.classifier.decide(request, signal) : "unavailable";
    if (verdict === "allow") return { decision: "allow", by: "classifier" };
    if (verdict === "block") return { decision: "deny", by: "classifier", reason: "Blocked by the approval classifier." };
    if (authorities.human) return askHuman({ ...request, reason: `${request.reason} (approval classifier unavailable)` }, authorities.human, signal);
    return { decision: "deny", by: "none", reason: noAuthority(request, "The approval classifier is unavailable.") };
  }

  // Point c: other cases. Habilitated hook, then designated authority or human, otherwise refusal.
  if (authorities.habilitatedHook) {
    const h = await authorities.habilitatedHook.decide(request, signal);
    if (h === "allow") return { decision: "allow", by: "hook" };
    if (h === "deny") return { decision: "deny", by: "hook", reason: "Denied by an approval hook." };
  }
  if (authorities.human) return askHuman(request, authorities.human, signal);
  if (authorities.delegate) {
    const d = await authorities.delegate.decide(request, signal);
    if (d === "allow") return { decision: "allow", by: "delegate" };
    if (d === "deny") return { decision: "deny", by: "delegate", reason: "Denied by the designated delegate." };
  }
  return { decision: "deny", by: "none", reason: noAuthority(request, decision.reason) };
}

async function askHuman(request: ApprovalRequest, human: HumanApprovalChannel, signal: AbortSignal): Promise<Resolution> {
  const a = await human.request(request, signal);
  switch (a.answer) {
    case "yes":
      return { decision: "allow", by: "human" };
    case "yes_always":
      return { decision: "allow", by: "human", persist: { scope: a.scope, rule: a.rule } };
    case "no":
      return { decision: "deny", by: "human", reason: "The user denied this action." };
    case "no_explain":
      return { decision: "deny", by: "human", reason: `The user denied this action: ${a.explanation}` };
    case "no_stop":
      return { decision: "deny", by: "human", reason: "The user denied this action and stopped the turn.", stopTurn: true };
  }
}
