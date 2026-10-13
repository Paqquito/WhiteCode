// Implements: SPEC-OUT-049 (test-only registration and ordinary permission decisions).
// Supports: SPEC-OUT-001, E-160.
import { textOutcome, type Tool } from "./types";

export const permissionTestTool: Tool<{ label?: string }> = {
  name: "permission_test",
  inputSchema: { type: "object", properties: { label: { type: "string", maxLength: 256 } }, additionalProperties: false },
  description: () => "Exercise the ordinary permission circuit without accessing files, running commands or making connections. Available only in the test build.",
  flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: true, openWorld: false }),
  isEnabled: () => true,
  ruleSubject: () => ({ kind: "none" }),
  async execute(input) { return textOutcome(`Permission probe approved${input.label ? `: ${input.label}` : "."}`); },
  summary: () => "Vérification du circuit de permission",
};
