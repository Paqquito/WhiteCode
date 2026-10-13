// Implements: SPEC-OUT-043 (bounded identifiers, tool results only, ignored entries reported).
// Supports: SPEC-MOT-019, E-158.
import type { HistoryPruning } from "../engine/history-pruning";
import { textOutcome, type Tool } from "./types";
export function historyPruningTool(pruning: HistoryPruning): Tool<{ message_ids: string[] }> {
  return {
    name: "prune_history", inputSchema: { type: "object", properties: { message_ids: { type: "array", items: { type: "string", maxLength: 24 }, minItems: 1, maxItems: 100 } }, required: ["message_ids"], additionalProperties: false },
    description: () => "Remove the bodies of obsolete tool results from the request context by their [mN] message identifiers. User and assistant messages stay intact. Original results remain in the transcript. Pruning is optional.",
    flags: () => ({ readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow",
    async execute(input) { const result = pruning.prune(input.message_ids); return textOutcome(JSON.stringify(result), result.pruned.length === 0, "invalid_input"); },
    summary: input => `Prune ${input.message_ids.length} context results`,
  };
}
