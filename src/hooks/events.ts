// Implements: SPEC-HOK-001 (§ 5.1 common fields, § 5.2 catalogue, § 5.3 synchronous decisional events, EF-03 version), SPEC-HOK-010 (§ 5.2 decisions by event)
// Catalogue of the hook events: the field a `match` filter applies to, and the decisions each event accepts.

/** Version of the payload format (EF-03): an added field keeps it, a removed or renamed one changes it. */
export const PAYLOAD_SCHEMA_VERSION = 1;

export type HookDecision = "allow" | "deny" | "ask" | "block" | "continue";

export interface HookEventInfo {
  /** Field of the payload the `match` filter applies to (tool name for the tool events). */
  readonly discriminant?: string;
  /** Decisions admitted (SPEC-HOK-010 § 5.2); empty: only context, user message, stop and hidden output apply. */
  readonly decisions: readonly HookDecision[];
  /** The product waits for the hooks of a decisional event (§ 5.3); the others run without being awaited (SPEC-HOK-007). */
  readonly synchronous: boolean;
  /** `context` is admitted (SPEC-HOK-010 § 5.1). */
  readonly context?: boolean;
  readonly elicitationResponse?: boolean;
}

const tool = { discriminant: "toolId" } as const;

export const HOOK_EVENTS: Readonly<Record<string, HookEventInfo>> = {
  maintenance_run: { discriminant: "trigger", decisions: [], synchronous: true },
  session_opened: { discriminant: "source", decisions: [], synchronous: true, context: true },
  session_closed: { discriminant: "reason", decisions: [], synchronous: false },
  instructions_read: { discriminant: "level", decisions: [], synchronous: false },
  prompt_submitted: { decisions: ["block"], synchronous: true, context: true },
  before_tool: { ...tool, decisions: ["allow", "deny", "ask"], synchronous: true, context: true },
  after_tool: { ...tool, decisions: [], synchronous: true, context: true },
  after_tool_failure: { ...tool, decisions: [], synchronous: true, context: true },
  approval_needed: { ...tool, decisions: ["allow", "deny"], synchronous: true },
  approval_refused: { ...tool, decisions: [], synchronous: false },
  user_alert: { discriminant: "kind", decisions: [], synchronous: false },
  turn_completed: { decisions: ["continue"], synchronous: true },
  turn_failed: { discriminant: "errorCategory", decisions: [], synchronous: false },
  subagent_launched: { discriminant: "agentType", decisions: [], synchronous: false },
  subagent_finished: { discriminant: "agentType", decisions: ["continue"], synchronous: true },
  before_compaction: { discriminant: "trigger", decisions: [], synchronous: true, context: true },
  after_compaction: { discriminant: "trigger", decisions: [], synchronous: false },
  elicitation: { discriminant: "server", decisions: [], synchronous: true, elicitationResponse: true },
  elicitation_result: { discriminant: "server", decisions: [], synchronous: false },
  settings_modified: { discriminant: "scope", decisions: [], synchronous: false },
  workdir_moved: { decisions: [], synchronous: false },
  watched_file_modified: { discriminant: "relativePath", decisions: [], synchronous: true, context: true },
  work_item_added: { discriminant: "kind", decisions: [], synchronous: false },
  work_item_done: { discriminant: "kind", decisions: [], synchronous: false },
  teammate_waiting: { decisions: ["continue"], synchronous: true },
  isolated_copy_created: { decisions: [], synchronous: false },
  isolated_copy_removed: { decisions: [], synchronous: false },
};
