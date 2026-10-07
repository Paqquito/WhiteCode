// Supports: SPEC-MOT-001 (EF-08), SPEC-MOT-002 (§ 5.3 steps 2 and 6), SPEC-PER-001 (step 1, 4, 6)
// Extension point for the hooks domain (SPEC-HOK-*, outside lot 1): called at the specified moments, neutral in lot 1.

import type { ToolCall } from "../providers/types";

export interface BeforeToolResult {
  readonly decision?: "allow" | "ask" | "deny";
  readonly reason?: string;
  /** Parameters replaced by a hook (SPEC-HOK-010 § 5.1), validated again by the executor (EF-03). */
  readonly modifiedInput?: Record<string, unknown>;
  /** Several hooks changed the input: the call is blocked (SPEC-HOK-010 ERR-01). */
  readonly conflict?: boolean;
  /** A hook asked to stop the turn after this event (SPEC-HOK-010 § 5.1). */
  readonly stopTurn?: boolean;
}

export interface HookBus {
  promptSubmitted(prompt: string): Promise<{ readonly block?: string }>;
  beforeTool(call: ToolCall): Promise<BeforeToolResult>;
  afterTool(call: ToolCall, isError: boolean, output?: string): Promise<{ readonly additionalContext?: string; readonly stopTurn?: boolean }>;
  approvalRefused(call: ToolCall, reason: string): Promise<void>;
  turnCompleted(finalText: string): Promise<{ readonly continueWith?: string }>;
  turnFailed(reason: string): Promise<void>;
  /** SPEC-MOT-011 step 1: instructions of the hooks, added to the user's ones. */
  beforeCompaction(instructions: string | undefined): Promise<{ readonly additionalInstructions?: string }>;
  /** SPEC-MOT-011 step 6. */
  afterCompaction(summary: string): Promise<void>;
}

export const NEUTRAL_HOOKS: HookBus = {
  promptSubmitted: async () => ({}),
  beforeTool: async () => ({}),
  afterTool: async () => ({}),
  approvalRefused: async () => {},
  turnCompleted: async () => ({}),
  turnFailed: async () => {},
  beforeCompaction: async () => ({}),
  afterCompaction: async () => {},
};
