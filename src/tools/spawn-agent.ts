// Implements: SPEC-OUT-016 (§ 5.3 steps 1, 2, 6, FA-01, FA-02, EF-02, EF-03, EF-05, ERR-01, ERR-02, edge case: agents.maxParallel)
// The model starts a sub-agent: the call itself changes nothing, the actions of the sub-agent are checked one by one by
// its own executor. Calls of one response run together.

import description from "../../prompts/tools/spawn_agent.md" with { type: "text" };
import type { AgentDefinition } from "../agents/definitions";
import { textOutcome, type Tool } from "./types";

export interface SpawnAgentInput {
  readonly description: string;
  readonly prompt: string;
  readonly role?: string;
  readonly model?: string;
  readonly resume?: string;
}

export interface SpawnAgentDeps {
  /** The agents available, read at each call (SPEC-AGT-005 EF-04). */
  readonly agents: () => ReadonlyMap<string, AgentDefinition>;
  readonly launch: (input: SpawnAgentInput, definition: AgentDefinition | undefined, signal: AbortSignal) => Promise<{ readonly text: string; readonly isError: boolean }>;
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
        prompt: { type: "string", minLength: 1, description: "The complete task: the sub-agent sees nothing else." },
        role: { type: "string", description: "Agent to use, among those listed. Default: general." },
        model: { type: "string", description: "Model alias for this agent (large, medium, small). Default: the one of the agent, otherwise yours." },
        resume: { type: "string", description: "Id of an agent of this session to continue with a new prompt." },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
    description: () => {
      const listed = [...deps.agents().values()].map((a) => `- ${a.name}: ${a.description}`);
      return `${description.trim()}\n\nAgents available:\n${listed.join("\n")}`;
    },
    // The call changes nothing by itself; what the agent does is decided call by call (EF-01, gap E-105).
    flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: true, openWorld: false }),
    isEnabled: () => true,
    ruleSubject: (input) => ({ kind: "name", name: input.role ?? "general" }),
    permissionContribution: () => "allow",
    summary: (input) => `${input.role ?? "general"}: ${input.description}`,

    async execute(input, ctx) {
      const agents = deps.agents();
      const definition = input.resume === undefined ? agents.get(input.role ?? "general") : undefined;
      if (input.resume === undefined && !definition) {
        return textOutcome(`Unknown agent type: ${input.role}. Available: ${[...agents.keys()].join(", ")}.`, true, "invalid_input"); // ERR-01
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
