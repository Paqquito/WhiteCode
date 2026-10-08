// Implements: SPEC-OUT-024 (§ 5.3, FA-01, FA-02, EF-02, EF-04, ERR-01, ERR-02, CA-02, CA-03), SPEC-OUT-033 (§ 5.1, § 5.3, FA-01, EF-01 to EF-03, ERR-01, CA-01, CA-02)
// Supports: SPEC-PER-003 (FA-01, CA-04 exit of the planning mode)
// The model asks to plan, presents its plan, or asks the user a question; the user always decides.

import startDescription from "../../prompts/tools/start_planning.md" with { type: "text" };
import submitDescription from "../../prompts/tools/submit_plan.md" with { type: "text" };
import choiceDescription from "../../prompts/tools/request_user_choice.md" with { type: "text" };
import type { PermissionMode } from "../config/settings-schema";
import { textOutcome, type Tool } from "./types";

export type PlanDecision =
  | { readonly kind: "approved"; readonly mode: PermissionMode; readonly plan: string; readonly edited: boolean }
  | { readonly kind: "rejected"; readonly comment: string }
  | { readonly kind: "none" };

export interface PlanningDeps {
  readonly mode: () => PermissionMode;
  /** § 5.3 step 1: the user agrees to enter the planning mode, or not. */
  readonly enter: (reason: string | undefined, signal: AbortSignal) => Promise<boolean>;
  /** Step 3: the plan shown; approval with a resume mode, edition (FA-01) or rejection with a comment (FA-02). */
  readonly decide: (plan: string, signal: AbortSignal) => Promise<PlanDecision>;
}

const reading = () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false });

export function createPlanningTools(deps: PlanningDeps): [Tool<{ reason?: string }>, Tool<{ plan_text: string }>] {
  const start: Tool<{ reason?: string }> = {
    name: "start_planning",
    inputSchema: { type: "object", properties: { reason: { type: "string", description: "Why a plan is needed before acting." } }, additionalProperties: false },
    description: () => startDescription.trim(),
    flags: reading,
    isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: () => "Ask to plan before acting",
    async execute(input, ctx) {
      if (deps.mode() === "planning") return textOutcome("The planning mode is already active: explore, then present your plan with submit_plan.");
      const accepted = await deps.enter(input.reason, ctx.signal);
      return accepted
        ? textOutcome("The planning mode is now active: explore and read only, then present your plan with submit_plan. Change nothing before the plan is approved.")
        : textOutcome("The user prefers to go on without the planning mode: continue in the current mode.");
    },
  };
  const submit: Tool<{ plan_text: string }> = {
    name: "submit_plan",
    inputSchema: { type: "object", properties: { plan_text: { type: "string", description: "The plan, in Markdown: the steps, the files involved, how the result will be checked." } }, required: ["plan_text"], additionalProperties: false },
    description: () => submitDescription.trim(),
    flags: reading,
    isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: () => "Present the plan",
    async execute(input, ctx) {
      if (deps.mode() !== "planning") return textOutcome("Not in planning mode: there is no plan to present now.", true, "invalid_input"); // ERR-01
      if (input.plan_text.trim() === "") return textOutcome("No plan to present: give the plan in plan_text.", true, "invalid_input"); // ERR-02
      const d = await deps.decide(input.plan_text, ctx.signal);
      if (d.kind === "approved") {
        // Step 4, FA-01: the plan that is valid is the one the user approved, edited or not.
        return textOutcome(`The user approved the plan${d.edited ? " after editing it; this version is the one to follow" : ""}. The permission mode is now ${d.mode}: carry the plan out.\n\n<approved-plan>\n${d.plan}\n</approved-plan>`);
      }
      if (d.kind === "rejected") return textOutcome(`The user rejected the plan${d.comment.trim() ? `: ${d.comment.trim()}` : ""}. The planning mode stays active: revise the plan and present it again.`); // FA-02
      return textOutcome("The user gave no decision. The planning mode stays active.");
    },
  };
  return [start, submit];
}

export interface ChoiceQuestion {
  readonly question: string;
  readonly header?: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description?: string; readonly preview?: string }>;
  readonly allow_multiple?: boolean;
}

/** An answer: the labels chosen, a free text, or nothing (FA-01). */
export type ChoiceReply = { readonly labels: readonly string[] } | { readonly other: string } | { readonly none: true };

export function createUserChoiceTool(ask: (questions: readonly ChoiceQuestion[], signal: AbortSignal) => Promise<readonly ChoiceReply[]>): Tool<{ questions: ChoiceQuestion[] }> {
  return {
    name: "request_user_choice",
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: { type: "string", minLength: 1 },
              header: { type: "string", maxLength: 12, description: "Short label of the question." },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: { label: { type: "string", minLength: 1 }, description: { type: "string" }, preview: { type: "string", maxLength: 4_000 } },
                  required: ["label"],
                  additionalProperties: false,
                },
              },
              allow_multiple: { type: "boolean" },
            },
            required: ["question", "options"],
            additionalProperties: false,
          },
        },
      },
      required: ["questions"],
      additionalProperties: false,
    },
    description: () => choiceDescription.trim(),
    flags: reading,
    isEnabled: () => true,
    // ERR-01: each question once, and distinct options (EF-02).
    validate(input) {
      const titles = input.questions.map((q) => q.question.trim());
      if (new Set(titles).size !== titles.length) return "Invalid questions: two questions have the same text.";
      for (const q of input.questions) {
        const labels = q.options.map((o) => o.label.trim().toLowerCase());
        if (new Set(labels).size !== labels.length) return `Invalid questions: the options of « ${q.question} » must be distinct.`;
      }
      return undefined;
    },
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: (input) => `Ask the user: ${input.questions[0]?.question ?? ""}`,
    async execute(input, ctx) {
      const replies = await ask(input.questions, ctx.signal);
      // Step 4: the answers, by question.
      const lines = input.questions.map((q, i) => {
        const r = replies[i] ?? { none: true };
        const answer = "labels" in r ? (q.allow_multiple ? `[${r.labels.map((l) => JSON.stringify(l)).join(", ")}]` : r.labels[0]) : "other" in r ? `(free answer) ${r.other}` : "(no answer)";
        return `- ${q.question}: ${answer}`;
      });
      const none = replies.every((r) => "none" in r);
      return textOutcome(`${none ? "The user gave no answer: go on with what you know, or ask differently." : "The user answered:"}\n${lines.join("\n")}`);
    },
  };
}
