// Implements: SPEC-OUT-044 (read-only segment listing and bounded original excerpts).
import type { ContextFolding } from "../engine/context-folding";
import { textOutcome, type Tool } from "./types";
export function inspectContextTool(folding: ContextFolding): Tool<{ action: "list" | "expand"; segment_id?: string; query?: string }> {
  return {
    name: "inspect_context", description: () => "List folded context segments with their summaries, or retrieve a bounded original excerpt using expand and segment_id. An optional query locates a detail. Expansion never permanently unfolds a segment.",
    inputSchema: { type: "object", properties: { action: { enum: ["list", "expand"] }, segment_id: { type: "string", maxLength: 100 }, query: { type: "string", maxLength: 500 } }, required: ["action"], additionalProperties: false },
    flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow",
    async execute(input) { try { return textOutcome(input.action === "list" ? JSON.stringify(folding.list()) : folding.expand(input.segment_id ?? "", input.query)); } catch (error) { return textOutcome((error as Error).message, true, "invalid_input"); } },
    summary: input => input.action === "list" ? "List folded context" : `Inspect ${input.segment_id ?? "unknown segment"}`,
  };
}
