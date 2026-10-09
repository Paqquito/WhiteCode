// Implements: SPEC-HOK-010 (§ 5.1 response fields, § 5.4 aggregation steps 2 to 5, FA-01, FA-02, EF-04, ERR-01, RG-01, RG-02), SPEC-HOK-012 (EF-04 mandatory control hooks), SPEC-CFG-003 (CA-11), gap E-128.
// Responses of the hooks of one event, combined in a deterministic way.

import type { HookDecision, HookEventInfo } from "./events";

export interface HookResponse {
  readonly decision?: HookDecision;
  readonly reason?: string;
  readonly modifiedInput?: Record<string, unknown>;
  readonly context?: string;
  readonly userMessage?: string;
  readonly stopTurn?: boolean;
  readonly haltReason?: string;
  readonly hideOutput?: boolean;
  readonly sessionEnv?: Record<string, string>;
}

/** Outcome of one action of one hook. */
export interface ActionOutcome {
  readonly label: string;
  readonly mandatory: boolean;
  /** Technical failure (exit code, time limit, non-conforming response): never blocking for an optional hook (SPEC-HOK-003 EF-02). */
  readonly failure?: string;
  readonly response?: HookResponse;
  /** Free text on the standard output (SPEC-HOK-003 § 5.1). */
  readonly text?: string;
}

export interface Aggregated {
  readonly decision?: HookDecision;
  /** Reasons, each with the hook that gave it (step 3). */
  readonly reasons: readonly string[];
  readonly modifiedInput?: Record<string, unknown>;
  /** Several hooks changed the input: the call is blocked (ERR-01). */
  readonly conflict: boolean;
  readonly context: readonly string[];
  readonly userMessages: readonly string[];
  readonly stopTurn?: string;
  readonly sessionEnv: Readonly<Record<string, string>>;
  /** Non-blocking failures and ignored fields, to report (FA-01, FA-02). */
  readonly notices: readonly string[];
}

const RANK: Readonly<Record<HookDecision, number>> = { deny: 4, block: 4, ask: 3, allow: 2, continue: 1 };
const DECISIONS = new Set<string>(["allow", "deny", "ask", "block", "continue"]);

/** Reads a JSON response; undefined when it is not one of ours (FA-01: then the text is free text or the response is non-conforming). */
export function parseResponse(stdout: string): { response?: HookResponse; nonConforming?: string } {
  const text = stdout.trim();
  if (!text.startsWith("{")) return {};
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {}; // SPEC-HOK-003 FA-02: free text
  }
  const r = raw as Record<string, unknown>;
  const problems: string[] = [];
  if (r["decision"] !== undefined && !DECISIONS.has(String(r["decision"]))) problems.push(`décision inconnue « ${String(r["decision"])} »`);
  for (const key of ["reason", "context", "userMessage", "haltReason"]) if (r[key] !== undefined && typeof r[key] !== "string") problems.push(`${key} doit être un texte`);
  for (const key of ["stopTurn", "hideOutput"]) if (r[key] !== undefined && typeof r[key] !== "boolean") problems.push(`${key} doit être un booléen`);
  for (const key of ["modifiedInput", "sessionEnv"]) if (r[key] !== undefined && (typeof r[key] !== "object" || r[key] === null || Array.isArray(r[key]))) problems.push(`${key} doit être un objet`);
  if (r["sessionEnv"] && Object.values(r["sessionEnv"] as object).some((v) => typeof v !== "string")) problems.push("sessionEnv : valeurs texte attendues");
  if (problems.length > 0) return { nonConforming: problems.join(" ; ") };
  return { response: r as HookResponse };
}

/**
 * Steps 2 to 5 for `event`: the strongest decision wins (deny/block > ask > allow > continue); reasons in order; a
 * changed input from several hooks is a conflict; context, messages and session variables add up. A mandatory hook
 * that fails refuses what it frames (SPEC-HOK-012 EF-04), here by the strongest refusal the event admits.
 */
export function aggregate(info: HookEventInfo, outcomes: readonly ActionOutcome[]): Aggregated {
  let decision: HookDecision | undefined;
  const reasons: string[] = [];
  const context: string[] = [];
  const userMessages: string[] = [];
  const notices: string[] = [];
  const sessionEnv: Record<string, string> = {};
  let modifiedInput: Record<string, unknown> | undefined;
  let modifiers = 0;
  let stopTurn: string | undefined;
  const raise = (d: HookDecision) => {
    if (decision === undefined || RANK[d] > RANK[decision]) decision = d;
  };
  for (const o of outcomes) {
    if (o.failure !== undefined) {
      if (o.mandatory) {
        const refusal = info.decisions.find((d) => d === "deny" || d === "block");
        const reason = `contrôle obligatoire ${o.label} indisponible : ${o.failure}`;
        if (refusal) raise(refusal);
        else stopTurn ??= reason;
        reasons.push(reason);
      } else notices.push(`crochet ${o.label} : ${o.failure}`);
      continue;
    }
    const r = o.response;
    if (!r) {
      if (o.text && info.context) context.push(o.text); // free text joins the context where context is admitted
      continue;
    }
    if (r.decision !== undefined) {
      if (info.decisions.includes(r.decision)) {
        raise(r.decision);
        if (r.reason) reasons.push(`${o.label} : ${r.reason}`);
      } else notices.push(`crochet ${o.label} : décision « ${r.decision} » non admise pour cet événement ; ignorée`); // FA-02
    }
    if (r.modifiedInput !== undefined) {
      if (info.decisions.includes("allow") && info.discriminant === "toolId" && info.decisions.includes("deny")) {
        modifiers++;
        modifiedInput = r.modifiedInput;
      } else notices.push(`crochet ${o.label} : modifiedInput non admis pour cet événement ; ignoré`);
    }
    if (r.context !== undefined) {
      if (info.context) context.push(r.context);
      else notices.push(`crochet ${o.label} : context non admis pour cet événement ; ignoré`);
    }
    if (r.userMessage) userMessages.push(`${o.label} : ${r.userMessage}`);
    if (r.stopTurn) stopTurn ??= r.haltReason ?? `arrêt demandé par le crochet ${o.label}`;
    if (r.sessionEnv) Object.assign(sessionEnv, r.sessionEnv);
  }
  const conflict = modifiers > 1;
  return {
    decision: conflict ? "deny" : decision,
    reasons: conflict ? [...reasons, "Plusieurs crochets modifient cet appel de manière incompatible."] : reasons,
    modifiedInput: conflict ? undefined : modifiedInput,
    conflict,
    context,
    userMessages,
    stopTurn,
    sessionEnv,
    notices,
  };
}
