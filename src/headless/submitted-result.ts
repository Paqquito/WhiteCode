// Implements: SPEC-OUT-041 (conditional schema tool, validated immutable result, no side effects).
// Supports: SPEC-MOD-004, E-157.
import type { OutputSchema } from "./structured";
import { textOutcome, type Tool } from "../tools/types";

/** Kept by the main agent only; a child cannot finish its parent's execution. */
export class SubmittedResult {
  #value?: { readonly value: unknown };
  reset(): void { this.#value = undefined; }
  take(): { readonly value: unknown } | undefined { const value = this.#value; this.#value = undefined; return value; }
  tool(schema: OutputSchema): Tool<unknown> {
    return {
      name: "submit_result", inputSchema: schema.schema,
      description: () => "Submit the final result that conforms to this run's output schema. Only a validated value can complete the execution. This tool does not change files or require permission.",
      flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }),
      isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow",
      validate: (input, ctx) => ctx.agentName ? "A child cannot submit a result for its parent." : schema.check(input).join("; ") || undefined,
      execute: async (input, ctx) => {
        if (ctx.agentName) return textOutcome("A child cannot submit a result for its parent.", true, "permission_denied");
        // A fresh JSON value prevents mutations through the provider's input object.
        const errors = schema.check(input);
        if (errors.length) return textOutcome(errors.join("; "), true, "invalid_input");
        this.#value = { value: JSON.parse(JSON.stringify(input)) };
        return textOutcome("The validated result has been accepted.");
      },
      summary: () => "Submit final result",
    };
  }
}
