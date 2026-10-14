// Supports: SPEC-AGT-010/CA-01/02 (background fork and disabled default).
import { expect, test } from "bun:test";
import { createSpawnAgentTool } from "../src/tools/spawn-agent";
import { BUILT_IN_AGENTS } from "../src/agents/definitions";
import { textOutcome } from "../src/tools/types";
import { workspace } from "./helpers/env";
import { bench } from "./helpers/engine";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-AGT-010/CA-01 — an untyped agent copies the complete caller prefix and reports as a background task", async () => {
  const controller = new AbortController(); let forked = false;
  const response = (request: import("../src/providers/types").ModelRequest) => {
    if (request.purpose === "subagent") {
      expect(request.system).toEqual(provider.requests[0]!.system); expect(request.tools).toEqual(provider.requests[0]!.tools);
      const history = JSON.stringify(request.history); expect(history).toContain("Caller context witness 810"); expect(history).not.toContain('"name":"spawn_agent"'); forked = true;
      return { text: "Background fork report 810.", delayMs: 100 };
    }
    return { text: "Parent is responsive.", delayMs: 150 };
  };
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { description: "Fork context", prompt: "Inspect the caller's context and report." } }] }, response], [response]);
  const run = interactive(["--approval-mode", "auto_edit"], workspace(), { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("Caller context witness 810."); run.type(KEY.enter); await run.waitFor(text => text.includes("Parent is responsive."));
    await run.waitFor(() => forked, "copied fork prefix");
    const result = provider.requests.find(request => request.purpose !== "subagent" && request.history.some(message => message.role === "user" && message.parts.some(part => part.type === "tool_result")));
    expect(JSON.stringify(result?.history)).toContain("Agent started in the background"); expect(run.finished()).toBe(false);
    run.type("Editable while the fork completes."); await run.waitFor(() => run.screen().join("\n").includes("Editable while the fork completes."));
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-AGT-010/CA-02 — disabled implicit forking uses the ordinary general agent synchronously", async () => {
  let role: string | undefined, detached = 0;
  const agents = new Map(BUILT_IN_AGENTS.map(agent => [agent.name, agent]));
  const tool = createSpawnAgentTool({ agents: () => agents, maxParallel: 1, forked: () => false, launch: async (_input, definition) => { role = definition?.name; return { text: "Ordinary report.", isError: false }; } });
  const result = await tool.execute({ description: "Ordinary task", prompt: "Report." }, { ...bench([]).deps.executor.toolContext(new AbortController().signal), background: { start: () => { detached++; throw new Error("No background fork expected"); } } as never });
  expect(role).toBe("general"); expect(detached).toBe(0); expect(result).toEqual(textOutcome("Ordinary report.", false));
});
