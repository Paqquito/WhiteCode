import { expect, test } from "bun:test";
import { join } from "node:path";
import { BackgroundTasks } from "../src/engine/background";
import { createSpawnAgentTool } from "../src/tools/spawn-agent";
import { BUILT_IN_AGENTS } from "../src/agents/definitions";
import { currentPlatform } from "../src/platform/system";
import { testToolFields, workspace } from "./helpers/env";
test("SPEC-AGT-006/CA-01 — two simultaneous agent types without a declared color receive different colors", async () => {
  const ws = workspace(), background = new BackgroundTasks({ dir: join(ws.root, "tasks"), maxOutputBytes: 4096, monitorMaxLinesPerMinute: 100, monitorWindowMs: 100 });
  const definitions = new Map(["alpha", "beta"].map(name => [name, { ...BUILT_IN_AGENTS[0]!, name, color: undefined }]));
  const tool = createSpawnAgentTool({ agents: () => definitions, maxParallel: 4, launch: async (_input, _definition, signal) => { await new Promise(resolve => { signal.addEventListener("abort", resolve, { once: true }); if (signal.aborted) resolve(undefined); }); return { text: "Stopped", isError: true }; } });
  const context = { ...testToolFields(), platform: currentPlatform(), home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal: new AbortController().signal, background };
  try { await tool.execute({ role: "alpha", description: "First", prompt: "Observe", detached: true }, context); await tool.execute({ role: "beta", description: "Second", prompt: "Observe", detached: true }, context); expect(background.running).toHaveLength(2); expect(background.tasks[0]!.color).not.toBe(background.tasks[1]!.color); expect(background.tasks[0]!.agentType).toBe("alpha"); const original = background.tasks[0]!.color; await background.stop(background.tasks[0]!.id); await tool.execute({ role: "alpha", description: "Again", prompt: "Observe", detached: true }, context); expect(background.tasks[2]!.color).toBe(original); }
  finally { await background.stopAll(); }
});
