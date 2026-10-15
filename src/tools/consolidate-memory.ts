// Supports: SPEC-EXT-035, SPEC-MOT-039 (manual invocation uses the same coordinator), gap E-172.
import type { MemoryConsolidation } from "../memory/consolidation";
import { textOutcome, type Tool } from "./types";
export function consolidateMemoryTool(consolidation: MemoryConsolidation): Tool<Record<string, never>> {
  return { name: "consolidate_memory", description: () => "Start a visible background consolidation of project memory. Work uses a private staging copy and an exclusive lock. Existing user feedback is preserved; cancellation leaves original memory unchanged.", inputSchema: { type: "object", properties: {}, additionalProperties: false },
    flags: () => ({ readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }), isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: () => "Consolidate project memory",
    async execute() { try { const id = consolidation.start(); return id ? textOutcome(JSON.stringify({ task_id: id })) : textOutcome("Memory consolidation could not start: disabled, empty, denied, or already running.", true, "unavailable"); } catch (error) { return textOutcome((error as Error).message, true, "execution"); } },
  };
}
