// Implements: SPEC-PER-001 (§ 5.3 steps 1 to 8, EF-01 to EF-05, EF-08, EF-09, RG-01, RG-03, ENF-02, CA-30), SPEC-PER-003 (RG-01, RG-02)
// Pure decision function: the same call and context always yield the same decision.

import type { PermissionMode } from "../config/settings-schema";
import type { PlatformName } from "../platform/system";
import type { RuleSubject, ToolFlags } from "../tools/types";
import { ruleMatches, suggestRule, type Rule } from "./rules";
import { exactlyAllowed } from "./command-analysis";
import { opaquePowerShell } from "./powershell-normalize";
import { splitCommand } from "./command-split";

export type AskOrigin = "managed" | "explicit" | "tool_check" | "default";

export type Decision =
  | { readonly kind: "allow"; readonly step: number; readonly why: string }
  | { readonly kind: "deny"; readonly step: number; readonly reason: string }
  | { readonly kind: "ask"; readonly step: number; readonly origin: AskOrigin; readonly reason: string; readonly suggestions: readonly string[] };

export interface PermissionQuery {
  readonly toolName: string;
  readonly subject: RuleSubject;
  readonly flags: ToolFlags;
  /** Tool-specific contribution (step 5). */
  readonly contribution?: "allow" | "ask";
  /** Decision of a `before_tool` hook, if any (steps 1, 4 and 6). */
  readonly hookDecision?: "allow" | "ask" | "deny";
  readonly hookReason?: string;
  /** Tool available in this session and within its perimeter (step 1). */
  readonly available: boolean;
  /** File write inside the allowed folders (step 7). */
  readonly fileWriteInsideAllowed?: boolean;
}

export interface PermissionContext {
  readonly shellShadow?: (value: { existing: RuleKind; candidate: RuleKind }) => void;
  readonly mode: PermissionMode;
  readonly rules: readonly Rule[];
  readonly sessionAllows: readonly Rule[];
  /** Grants actually chosen by a human or designated host, excluding temporary skill grants. */
  readonly explicitSessionAllows?: readonly Rule[];
  readonly managedRulesOnly: boolean;
  readonly cwd: string;
  readonly home: string;
  readonly platform: PlatformName;
  /** Policy invariant for the capability of this execution context, already evaluated against the raw source. */
  readonly policyRefusal?: string;
}

/** The tool that leaves planning mode is the only non-read-only tool allowed in `planning` (step 1). */
export const PLANNING_EXIT_TOOL = "submit_plan";

type RuleKind = Decision["kind"];
// Implements: SPEC-PER-007 (CA-03, isolated conservative shadow observer), gap E-170.
export function decide(q: PermissionQuery, ctx: PermissionContext): Decision {
  const existing = decideExisting(q, ctx);
  if (ctx.shellShadow && q.subject.kind === "command" && ["run_shell", "run_powershell"].includes(q.toolName)) {
    try {
      const parsed = splitCommand(q.subject.command, q.toolName === "run_powershell" ? "powershell" : "posix");
      const parts = parsed.complete ? parsed.parts.map(command => decideExisting({ ...q, subject: { kind: "command", command } }, ctx).kind) : ["ask" as const];
      const candidate: RuleKind = parts.includes("deny") ? "deny" : parts.includes("ask") || !parts.length ? "ask" : "allow";
      if (candidate !== existing.kind) ctx.shellShadow({ existing: existing.kind, candidate });
    } catch { /* an observer cannot affect execution */ }
  }
  return existing;
}
function decideExisting(q: PermissionQuery, ctx: PermissionContext): Decision {
  const rules = ctx.managedRulesOnly ? ctx.rules.filter((r) => r.scope === "managed") : ctx.rules;
  const match = (r: Rule) => ruleMatches(r, q.toolName, q.subject, ctx);

  // Step 1: invariants. Nothing lifts these refusals (EF-02, EF-09).
  if (ctx.policyRefusal !== undefined) return { kind: "deny", step: 1, reason: ctx.policyRefusal };
  if (!q.available) return { kind: "deny", step: 1, reason: "Tool not available in this session." };
  const deny = rules.find((r) => r.decision === "deny" && match(r));
  if (deny) return { kind: "deny", step: 1, reason: `Denied by the rule ${deny.raw} (${deny.scope} scope).` };
  if (q.hookDecision === "deny") return { kind: "deny", step: 1, reason: q.hookReason ?? "Denied by a hook." };
  if (ctx.mode === "planning" && !q.flags.readOnly && q.toolName !== PLANNING_EXIT_TOOL) {
    return { kind: "deny", step: 1, reason: "Planning mode: no modification is allowed." };
  }

  const suggestions = [suggestRule(q.toolName, q.subject, ctx.platform)];

  // Step 2: requests imposed by the managed policy, even in `unrestricted`.
  const managedAsk = rules.find((r) => r.decision === "ask" && r.scope === "managed" && match(r));
  if (managedAsk) return { kind: "ask", step: 2, origin: "managed", reason: `Confirmation required by the managed rule ${managedAsk.raw}.`, suggestions: [] };

  if (q.flags.explicitApproval) {
    const ask = rules.find(r => r.decision === "ask" && match(r));
    if (ask || q.hookDecision === "ask") return { kind: "ask", step: 4, origin: "explicit", reason: ask ? `Confirmation required by the rule ${ask.raw}.` : q.hookReason ?? "Confirmation requested by a hook.", suggestions: [] };
    const allow = rules.find(r => r.decision === "allow" && r.tool === q.toolName && match(r)) ?? ctx.explicitSessionAllows?.find(r => r.decision === "allow" && r.tool === q.toolName && match(r));
    return allow ? { kind: "allow", step: 6, why: `rule ${allow.raw}` } : { kind: "ask", step: 4, origin: "explicit", reason: "The execution plan requires approval before any step starts.", suggestions };
  }

  // Step 3: unrestricted mode allows ordinary requests.
  if (ctx.mode === "unrestricted") return { kind: "allow", step: 3, why: "unrestricted mode" };

  // Step 4: explicit requests (non-managed `ask` rules, hook asking).
  const ask = rules.find((r) => r.decision === "ask" && r.scope !== "managed" && match(r));
  if (ask) return { kind: "ask", step: 4, origin: "explicit", reason: `Confirmation required by the rule ${ask.raw} (${ask.scope} scope).`, suggestions: [] };
  if (q.hookDecision === "ask") return { kind: "ask", step: 4, origin: "explicit", reason: q.hookReason ?? "Confirmation requested by a hook.", suggestions: [] };

  // Step 5: tool-specific contribution.
  if (q.contribution === "allow") return { kind: "allow", step: 5, why: "tool check" };
  // SPEC-PER-009 § 5.3 step 2: only an `allow` rule naming exactly the command lifts the confirmation of a danger.
  if (q.contribution === "ask" && q.subject.kind === "command" && !(ctx.mode === "auto_approve" && q.toolName === "run_powershell" && opaquePowerShell(q.subject.command))) {
    const command = q.subject.command;
    const exact = rules.find((r) => r.decision === "allow" && r.tool === q.toolName && r.pattern !== undefined && exactlyAllowed(command, [r.pattern]));
    if (exact) return { kind: "allow", step: 5, why: `rule ${exact.raw} naming the command` };
  }
  if (q.contribution === "ask") return { kind: "ask", step: 5, origin: "tool_check", reason: "Confirmation required by the tool check.", suggestions };

  // Step 6: authorisations.
  const allow = rules.find((r) => r.decision === "allow" && match(r)) ?? ctx.sessionAllows.find(match);
  if (allow) return { kind: "allow", step: 6, why: `rule ${allow.raw}` };
  if (q.hookDecision === "allow") return { kind: "allow", step: 6, why: "hook" };

  // Step 7: auto_edit allows file writes inside the allowed folders.
  if (ctx.mode === "auto_edit" && q.fileWriteInsideAllowed === true) return { kind: "allow", step: 7, why: "auto_edit mode" };

  // Step 8: default.
  return { kind: "ask", step: 8, origin: "default", reason: "This action requires a permission.", suggestions };
}
