// Implements: SPEC-OUT-016 (§ 5.3 steps 1, 2, 6, FA-01, FA-02, EF-02, EF-03, EF-05, ERR-01, ERR-02, edge case: agents.maxParallel)
// The model starts a sub-agent: the call itself changes nothing, the actions of the sub-agent are checked one by one by
// its own executor. Calls of one response run together.
// Supports: SPEC-AGT-018 (CA-01: current activity and counters), gap E-147.

import description from "../../prompts/tools/spawn_agent.md" with { type: "text" };
import type { AgentDefinition } from "../agents/definitions";
import type { EventSink } from "../engine/events";
import { textOutcome, type Tool } from "./types";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };

export interface SpawnAgentInput {
  readonly team?: string;
  readonly name?: string;
  readonly description: string;
  readonly prompt: string;
  readonly role?: string;
  readonly model?: string;
  readonly resume?: string;
  readonly detached?: boolean;
}

export interface SpawnAgentDeps {
  readonly teammate?: (input: SpawnAgentInput) => string;
  readonly forked?: () => boolean;
  /** The agents available, read at each call (SPEC-AGT-005 EF-04). */
  readonly agents: () => ReadonlyMap<string, AgentDefinition>;
  readonly launch: (input: SpawnAgentInput, definition: AgentDefinition | undefined, signal: AbortSignal, progress?: EventSink) => Promise<{ readonly text: string; readonly isError: boolean }>;
  /** `agents.maxParallel`. */
  readonly maxParallel: number;
}

export function createSpawnAgentTool(deps: SpawnAgentDeps): Tool<SpawnAgentInput> {
  let running = 0;
  const waiting: Array<() => void> = [];
  const enter = async () => {
    if (running < Math.max(1, deps.maxParallel)) running++;
    else await new Promise<void>((r) => waiting.push(r));
  };
  const leave = () => {
    const next = waiting.shift();
    if (next) next();
    else running--;
  };
  return {
    name: "spawn_agent",
    inputSchema: {
      type: "object",
      properties: {
        description: { type: "string", minLength: 1, maxLength: 80, description: "The task in a few words, for the user." },
        prompt: { type: "string", minLength: 1, description: buildFlag("agent_forked") ? "The complete task; an explicitly typed agent sees only this task, while an implicit fork also inherits your completed context." : "The complete task: the sub-agent sees nothing else." },
        role: { type: "string", description: "Typed agent to use, among those listed. Omit this field for the default delegation behavior." },
        model: { type: "string", description: "Model alias for this agent (large, medium, small). Default: the one of the agent, otherwise yours." },
        resume: { type: "string", description: "Id of an agent of this session to continue with a new prompt." },
        detached: { type: "boolean", description: "Run the agent in the background: its task id comes back at once and its report reaches you as a notification." },
        team: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$", description: "Existing team to join as a persistent local teammate." },
        name: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$", description: "Unique teammate name, required together with team." },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    description: () => {
      const listed = [...deps.agents().values()].map((a) => `- ${a.name}: ${a.description}`);
      return `${description.trim()}${buildFlag("agent_forked") && deps.forked?.() ? "\nWithout an explicit role, start a fork of the caller's complete conversation in the background. A typed role keeps the ordinary isolated agent behavior." : ""}\n\nAgents available:\n${listed.join("\n")}`;
    },
    // The call changes nothing by itself; what the agent does is decided call by call (EF-01, gap E-105).
    flags: input => ({ readOnly: input.team === undefined, concurrencySafe: input.team === undefined, destructive: false, requiresPermission: true, openWorld: false }),
    isEnabled: () => true,
    ruleSubject: (input) => ({ kind: "name", name: input.role ?? "general" }),
    permissionContribution: () => "allow",
    summary: (input) => `${input.role ?? "general"}: ${input.description}`,

    async execute(input, ctx) {
      if (input.team !== undefined || input.name !== undefined) {
        if (!input.team || !input.name || input.resume || input.detached === false || !deps.teammate) return textOutcome("A teammate needs both team and name, without resume or detached=false.", true, "invalid_input");
        try { return textOutcome(deps.teammate(input)); } catch (error) { return textOutcome(error instanceof Error ? error.message : String(error), true, "unavailable"); }
      }
      const agents = deps.agents();
      const definition = input.resume === undefined ? agents.get(input.role ?? "general") : undefined;
      if (input.resume === undefined && !definition) {
        return textOutcome(`Unknown agent type: ${input.role}. Available: ${[...agents.keys()].join(", ")}.`, true, "invalid_input"); // ERR-01
      }
      // SPEC-AGT-018: in the background, the agent runs as a task of the session; its report comes as a notification (CA-03 of SPEC-OUT-016).
      if (input.detached === true || (input.detached === undefined && (definition?.detached === true || buildFlag("agent_forked") && input.role === undefined && input.resume === undefined && deps.forked?.()))) {
        if (!ctx.background) return textOutcome("Background tasks are not available in this session.", true, "unavailable");
        const task = ctx.background.start("agent", input.description, async (signal, write) => {
          await enter();
          let activity = "Réflexion…", tools = 0, tokens = 0;
          const names = new Map<string, string>();
          const progress: EventSink = (event) => {
            if (event.type === "tool_call") { names.set(event.callId, event.name); tools++; activity = `Vérification : ${event.name}…`; }
            else if (event.type === "tool_started") activity = `Outil ${names.get(event.callId) ?? "en cours"}…`;
            else if (event.type === "tool_result" || event.type === "thinking_delta") activity = "Réflexion…";
            else if (event.type === "text_delta") activity = "Rédaction…";
            else if (event.type === "retry") activity = "Nouvelle tentative…";
            else if (event.type === "usage") tokens += event.usage.inputTokens + event.usage.outputTokens;
            ctx.background!.updateActivity(task.id, activity, tools, tokens);
          };
          ctx.background!.updateActivity(task.id, activity, tools, tokens);
          try {
            const report = await deps.launch(input, definition, signal, progress);
            write(report.text);
            return { status: report.isError ? (signal.aborted ? "stopped" : "failed") : "completed", summary: report.text };
          } finally {
            leave();
          }
        });
        ctx.background.identifyAgent(task.id, definition?.name ?? input.role ?? "general", definition?.color);
        return textOutcome(`Agent started in the background as task ${task.id}. Its report will reach you as a notification; background_output (task_id ${task.id}) tells whether it still runs.`);
      }
      await enter();
      try {
        const report = await deps.launch(input, definition, ctx.signal);
        return textOutcome(report.text, report.isError, report.isError ? "execution" : undefined);
      } catch (e) {
        return textOutcome(`The sub-agent failed: ${(e as Error)?.message ?? String(e)}`, true, "execution"); // ERR-02
      } finally {
        leave();
      }
    },
  };
}
