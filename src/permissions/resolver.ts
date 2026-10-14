// Implements: SPEC-PER-001 (§ 5.3 handling of an `ask` decision, points a to d, resolution table, FA-01, FA-02, EF-10, EF-12, RG-05, RG-06)
// Supports: SPEC-PER-028 (§ 5.2 point 1: the designated control host first), SPEC-MOD-006 (§ 5.4 step 5, RG-05)
// Supports: SPEC-PER-001 (CA-22: cancellation before, between and after authorities), gap E-131.
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
  /** Supports: SPEC-OUT-004 step 5: only a human or designated host can accept an anchored edit. */
  readonly humanOnly?: boolean;
  readonly planApproval?: boolean;
  readonly suggestions: readonly string[];
  /** Difference of the change, shown before confirmation (SPEC-OUT-003 EF-06). */
  readonly preview?: string;
  /** The change itself, for a structured presentation (SPEC-IHM-005). */
  readonly change?: FileChange;
  /** Identity of the requesting agent when relayed (sub-agent, teammate). */
  readonly requester?: string;
  readonly agent?: { readonly id: string; readonly type: string };
  readonly approvalMode?: PermissionMode;
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
  decide(request: ApprovalRequest, signal: AbortSignal): Promise<"allow" | "deny" | HostDecision | undefined>;
}

/** Answer of a designated control host (SPEC-MOD-006 § 5.3): parameters replaced are evaluated again by the executor (EF-11). */
export type HostDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "allow_modified"; readonly input: Record<string, unknown> }
  | { readonly decision: "deny"; readonly reason: string };

/** Control host designated as the decision authority of the run; `undefined`: not consulted (not designated, demand not handled). */
export interface ControlAuthority {
  decide(request: ApprovalRequest, signal: AbortSignal): Promise<HostDecision | undefined>;
}

/** Habilitated `approval_needed` hook (§ 5.3 point c). */
export interface ApprovalHook {
  decide(request: ApprovalRequest, signal: AbortSignal): Promise<"allow" | "deny" | undefined>;
}

/** Approval classifier of `auto_approve` (SPEC-PER-004). */
export type ClassifierVerdict = "allow" | "block" | "unavailable" | { readonly decision: "allow" | "block" | "unavailable"; readonly reason: string };
export interface ApprovalClassifier {
  decide(request: ApprovalRequest, signal: AbortSignal): Promise<ClassifierVerdict>;
}

export interface Authorities {
  readonly human?: HumanApprovalChannel;
  /** Designated control host (SPEC-MOD-006): in the place of the human interface, and first in `no_prompt` (SPEC-PER-028). */
  readonly controlHost?: ControlAuthority;
  readonly delegate?: DecisionDelegate;
  readonly habilitatedHook?: ApprovalHook;
  readonly classifier?: ApprovalClassifier;
  readonly classifierNeedsHuman?: () => boolean;
}

export type Resolution =
  | { readonly decision: "allow"; readonly by: "human" | "control_host" | "delegate" | "hook" | "classifier"; readonly persist?: { scope: string; rule: string }; readonly input?: Record<string, unknown> }
  | { readonly decision: "deny"; readonly by: "human" | "control_host" | "delegate" | "hook" | "classifier" | "none"; readonly reason: string; readonly stopTurn?: boolean };

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
  if (signal.aborted) return cancelled();
  if (request.planApproval) {
    const host = await askHost(request, authorities.controlHost, signal); if (host) return host;
    if (mode !== "no_prompt" && authorities.human) return askHuman(request, authorities.human, signal);
    return { decision: "deny", by: "none", reason: noAuthority(request, "The execution plan requires a human or designated control host.") };
  }
  if (request.humanOnly) {
    if (mode !== "ask" && mode !== "auto_approve") return { decision: "deny", by: "none", reason: "Passage not found: this approximate edit requires human confirmation." };
    const host = await askHost(request, authorities.controlHost, signal); if (host) return host;
    if (authorities.human) return askHuman(request, authorities.human, signal);
    return { decision: "deny", by: "none", reason: "Passage not found: no human interface can confirm this edit." };
  }
  // Point a: no_prompt, any origin: only a designated delegate, the control host first (SPEC-PER-028 § 5.2); never a dialog nor a hook.
  if (mode === "no_prompt") {
    const host = await askHost(request, authorities.controlHost, signal);
    if (host) return host;
    if (authorities.delegate) {
      const d = await authorities.delegate.decide(request, signal);
      if (signal.aborted) return cancelled();
      if (d === "allow") return { decision: "allow", by: "delegate" };
      if (d === "deny") return { decision: "deny", by: "delegate", reason: "Denied by the designated delegate." };
      const structured = structuredDelegate(d); if (structured) return structured;
    }
    return { decision: "deny", by: "none", reason: noAuthority(request, `${decision.reason} (no_prompt mode)`) };
  }

  // Point b: auto_approve, tool check or default origin: the classifier, never a hook nor a delegate.
  if (mode === "auto_approve" && (decision.origin === "tool_check" || decision.origin === "default")) {
    const answer = authorities.classifierNeedsHuman?.() && (authorities.human || authorities.controlHost)
      ? { decision: "unavailable" as const, reason: "Repeated permission refusals require human review." }
      : authorities.classifier ? await authorities.classifier.decide(request, signal) : "unavailable";
    const verdict = typeof answer === "string" ? answer : answer.decision;
    const detail = typeof answer === "string" ? "" : ` ${answer.reason}`;
    if (signal.aborted) return cancelled();
    if (verdict === "allow") return { decision: "allow", by: "classifier" };
    if (verdict === "block") return { decision: "deny", by: "classifier", reason: `Blocked by the approval classifier.${detail}` };
    const host = await askHost({ ...request, reason: `${request.reason} (approval classifier unavailable)${detail}` }, authorities.controlHost, signal);
    if (host) return host;
    if (authorities.human) return askHuman({ ...request, reason: `${request.reason} (approval classifier unavailable)${detail}` }, authorities.human, signal);
    return { decision: "deny", by: "none", reason: noAuthority(request, `The approval classifier is unavailable.${detail}`) };
  }

  // Point c: other cases. Habilitated hook, then designated authority or human, otherwise refusal.
  if (authorities.habilitatedHook) {
    const h = await authorities.habilitatedHook.decide(request, signal);
    if (signal.aborted) return cancelled();
    if (h === "allow") return { decision: "allow", by: "hook" };
    if (h === "deny") return { decision: "deny", by: "hook", reason: "Denied by an approval hook." };
  }
  const host = await askHost(request, authorities.controlHost, signal);
  if (host) return host;
  if (authorities.human) return askHuman(request, authorities.human, signal);
  if (authorities.delegate) {
    const d = await authorities.delegate.decide(request, signal);
    if (signal.aborted) return cancelled();
    if (d === "allow") return { decision: "allow", by: "delegate" };
    if (d === "deny") return { decision: "deny", by: "delegate", reason: "Denied by the designated delegate." };
    const structured = structuredDelegate(d); if (structured) return structured;
  }
  return { decision: "deny", by: "none", reason: noAuthority(request, decision.reason) };
}

/** The designated control host; `undefined` when it is not consulted, so that the next authority answers (SPEC-MOD-006 FA-01). */
async function askHost(request: ApprovalRequest, host: ControlAuthority | undefined, signal: AbortSignal): Promise<Resolution | undefined> {
  if (signal.aborted) return cancelled();
  if (!host) return undefined;
  const d = await host.decide(request, signal);
  if (signal.aborted) return cancelled();
  if (!d) return undefined;
  if (d.decision === "allow") return { decision: "allow", by: "control_host" };
  if (d.decision === "allow_modified") return { decision: "allow", by: "control_host", input: d.input };
  return { decision: "deny", by: "control_host", reason: d.reason };
}

async function askHuman(request: ApprovalRequest, human: HumanApprovalChannel, signal: AbortSignal): Promise<Resolution> {
  if (signal.aborted) return cancelled();
  const a = await human.request(request, signal);
  if (signal.aborted) return cancelled();
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

function structuredDelegate(answer: unknown): Resolution | undefined {
  if (answer === undefined) return undefined;
  if (answer && typeof answer === "object" && !Array.isArray(answer)) {
    const row = answer as Record<string, unknown>, keys = Object.keys(row);
    if (row["decision"] === "allow" && keys.every(key => key === "decision")) return { decision: "allow", by: "delegate" };
    if (row["decision"] === "deny" && typeof row["reason"] === "string" && keys.every(key => ["decision", "reason"].includes(key))) return { decision: "deny", by: "delegate", reason: row["reason"] };
    if (row["decision"] === "allow_modified" && row["input"] && typeof row["input"] === "object" && !Array.isArray(row["input"]) && keys.every(key => ["decision", "input"].includes(key))) return { decision: "allow", by: "delegate", input: row["input"] as Record<string, unknown> };
  }
  return { decision: "deny", by: "delegate", reason: "The designated delegate returned an invalid decision." };
}
function cancelled(): Resolution {
  return { decision: "deny", by: "none", reason: "The call was cancelled; its approval is no longer valid." };
}
