// Implements: SPEC-OUT-045 (human decisions only, complete results, no changes).
// Supports: SPEC-OUT-033, gap E-161.
import { textOutcome, type Tool } from "./types";

export interface ReviewFinding {
  readonly id: string; readonly file: string; readonly start_line: number; readonly end_line: number;
  readonly severity: number; readonly category: string; readonly explanation: string; readonly proposed_diff?: string;
}
export interface ReviewArtifact { readonly title: string; readonly summary: string; readonly findings: readonly ReviewFinding[] }
export interface ReviewDecision { readonly id: string; readonly decision: "accepted" | "rejected" | "commented" | "pending"; readonly comment?: string }

export function createReviewArtifactTool(review: (artifact: ReviewArtifact, signal: AbortSignal) => Promise<readonly ReviewDecision[]>): Tool<ReviewArtifact> {
  return {
    name: "review_artifact",
    description: () => "Present a localized code review artifact and collect the user's accept, reject, comment or defer decision for every finding. This tool never applies a change. Apply accepted fixes separately through ordinary file tools and permissions.",
    inputSchema: { type: "object", properties: { title: { type: "string", minLength: 1, maxLength: 256 }, summary: { type: "string", minLength: 1, maxLength: 4096 }, findings: { type: "array", minItems: 1, maxItems: 200, items: { type: "object", properties: { id: { type: "string", minLength: 1, maxLength: 64 }, file: { type: "string", minLength: 1, maxLength: 4096 }, start_line: { type: "integer", minimum: 1 }, end_line: { type: "integer", minimum: 1 }, severity: { type: "integer", minimum: 0, maximum: 3 }, category: { type: "string", minLength: 1, maxLength: 64 }, explanation: { type: "string", minLength: 1, maxLength: 8192 }, proposed_diff: { type: "string", maxLength: 32768 } }, required: ["id", "file", "start_line", "end_line", "severity", "category", "explanation"], additionalProperties: false } } }, required: ["title", "summary", "findings"], additionalProperties: false },
    flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: input => `Review ${input.findings.length} findings`,
    async execute(input, ctx) {
      if (ctx.signal.aborted) return textOutcome("Review interrupted.", true, "interrupted");
      if (Buffer.byteLength(JSON.stringify(input), "utf8") > 1048576 || input.findings.some(finding => finding.end_line < finding.start_line)) return textOutcome("Review exceeds its size limit or contains an invalid line range.", true, "invalid_input");
      if (new Set(input.findings.map(finding => finding.id)).size !== input.findings.length) return textOutcome("Finding identifiers must be unique.", true, "invalid_input");
      const replies = await review(input, ctx.signal), byId = new Map(replies.map(reply => [reply.id, reply]));
      return textOutcome(JSON.stringify(input.findings.map(finding => byId.get(finding.id) ?? { id: finding.id, decision: "pending" })));
    },
  };
}
