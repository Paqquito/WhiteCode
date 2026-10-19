// Implements: SPEC-MOT-027 (CA-01/02, EF-01, RG-01), gap E-170.
import type { Tool } from "./types";
import { textOutcome } from "./types";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };

export function advisorTool(options: { available: () => boolean; consult: (question: string, signal: AbortSignal) => Promise<string | undefined> }): Tool<{ question: string }> | undefined {
  if (!buildFlag("model_advisor")) return undefined;
  return {
    name: "consult_advisor", description: () => "Consult the configured advisor before a structural decision. Send only the question and necessary context. The advisor has no tools and cannot act. Avoid routine consultations.",
    inputSchema: { type: "object", properties: { question: { type: "string", minLength: 1, maxLength: 24000 } }, required: ["question"], additionalProperties: false },
    flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: true }),
    isEnabled: () => options.available(), ruleSubject: () => ({ kind: "none" }), summary: () => "Consult the configured advisor", permissionContribution: () => "allow",
    validate: () => options.available() ? undefined : "The advisor is unavailable or incompatible with the current model.",
    execute: async (input, ctx) => { const answer = await options.consult(input.question, ctx.signal); return textOutcome(answer ?? "The advisor is unavailable.", answer === undefined); },
  };
}
