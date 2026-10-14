// Implements: SPEC-OUT-025 (approved-plan evidence and read-only assessment), gap E-169.
import type { Tool } from "./types";
import { textOutcome } from "./types";
export interface PlanEvidence { readonly id: string; readonly kind: string; readonly text: string }
export function planSteps(plan: string): string[] {
  const steps = plan.split(/\r?\n/).map(line => /^\s*(?:\d+[.)]|[-*])\s+(?:\[[ xX]\]\s*)?(.+)$/.exec(line)?.[1]).filter((step): step is string => !!step);
  return steps.length ? steps : plan.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean);
}
export function checkPlanProgressTool(options: {
  readonly approved: () => string | undefined;
  readonly evidence: () => readonly PlanEvidence[];
  readonly check: (input: { readonly plan: string; readonly steps: readonly string[]; readonly evidence: readonly PlanEvidence[] }, signal: AbortSignal) => Promise<string>;
  readonly publish: (report: string) => void;
}): Tool<{ plan_text?: string }> {
  return {
    name: "check_plan_progress", description: () => "Compare the actual approved plan with execution evidence, using a read-only agent. Report every completed, partial, skipped or silently changed step with evidence, or explicitly state the absence of evidence. The report is displayed verbatim to the user.",
    inputSchema: { type: "object", properties: { plan_text: { type: "string", maxLength: 32768 } }, additionalProperties: false },
    flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }), isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: () => "Vérifier l’exécution du plan approuvé",
    async execute(input, ctx) {
      const plan = options.approved();
      if (!plan) return textOutcome("No plan has been approved in this session.", true, "invalid_input");
      if (input.plan_text !== undefined && input.plan_text.trim() !== plan.trim()) return textOutcome("The supplied plan differs from the plan actually approved by the user.", true, "invalid_input");
      const steps = planSteps(plan); if (!steps.length || steps.length > 64 || Buffer.byteLength(plan) > 32768) return textOutcome("The approved plan exceeds the assessment bounds.", true, "invalid_input");
      const evidence = options.evidence();
      let raw: unknown; try { raw = JSON.parse((await options.check({ plan, steps, evidence }, ctx.signal)).replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { return textOutcome("The read-only plan assessor returned no valid structured report.", true, "execution"); }
      ctx.signal.throwIfAborted();
      const rows = (raw as { steps?: unknown } | null)?.steps;
      if (!Array.isArray(rows) || rows.length !== steps.length || rows.some((row, index) => !row || row.step !== index + 1 || !["completed", "partial", "skipped", "changed"].includes(row.status) || typeof row.reason !== "string" || row.reason.length > 4000 || !Array.isArray(row.evidence) || row.evidence.some((id: unknown) => typeof id !== "string" || !evidence.some(proof => proof.id === id)) || row.status !== "skipped" && row.evidence.length === 0)) return textOutcome("The plan report has incomplete steps, invalid evidence references or unsupported classifications.", true, "execution");
      const marks: Record<string, string> = { completed: "✓ completed", partial: "~ partial", skipped: "○ skipped", changed: "! silently changed" };
      const report = rows.map((row, index) => `${index + 1}. ${steps[index]} — ${marks[row.status]}\n   ${row.reason}${row.evidence.length ? " [" + row.evidence.join(", ") + "]" : " [no execution evidence]"}`).join("\n") + "\n\n" + (rows.every(row => row.status === "completed") ? "The available evidence supports completion of every plan step." : "Plan deviations remain: review the flagged steps before declaring completion.");
      options.publish(report); return textOutcome(report);
    },
  };
}
