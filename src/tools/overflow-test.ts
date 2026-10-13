// Implements: SPEC-OUT-048 (deterministic, bounded test-only result through the ordinary executor).
// Supports: SPEC-OUT-001, E-158.
import { textOutcome, type Tool } from "./types";
export const overflowTestTool: Tool<{ size: number; unit?: "chars" | "tokens" }> = {
  name: "overflow_test", inputSchema: { type: "object", properties: { size: { type: "integer", minimum: 0, maximum: 10_000_000 }, unit: { enum: ["chars", "tokens"] } }, required: ["size"], additionalProperties: false },
  description: () => "Generate a deterministic context overflow probe of a requested size, for internal tests only. Token units estimate four characters per token.",
  flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: false, openWorld: false }),
  isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow",
  validate: input => Number.isSafeInteger(input.size) && input.size >= 0 && input.size <= 10_000_000 ? undefined : "Invalid probe size.",
  async execute(input) { const size = input.size * (input.unit === "tokens" ? 4 : 1), unit = "0123456789 probe "; return textOutcome(unit.repeat(Math.ceil(size / unit.length)).slice(0, size)); },
  summary: input => `Context overflow probe (${input.size} ${input.unit ?? "chars"})`,
};
