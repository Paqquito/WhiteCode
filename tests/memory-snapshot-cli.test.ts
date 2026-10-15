// Supports: SPEC-AGT-008/CA-01 (actual launch, replace/ignore and preserved memories).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { workspace, loadIdentity } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { AgentMemory, agentMemoryName } from "../src/agents/agent-memory";
const fact = (text: string) =>
  `---\nname: "Memory witness"\ndescription: "A stable fact for the test."\ntype: project\n---\n${text}`;
test("SPEC-AGT-008/CA-01 — an actual memory-agent launch offers replacing or ignoring a newer project snapshot without overwriting on refusal", async () => {
  for (const accepted of [false, true]) {
    const ws = workspace(),
      identity = loadIdentity(),
      projectDir = join(ws.project, identity.get("PROJECT_DIR")),
      memory = new AgentMemory({
        configDir: ws.configHome,
        projectDir,
        indexFile: identity.get("MEMORY_INDEX_FILE"),
        redact: (value) => value,
      }).open("remember", "local");
    memory.put("original.md", fact("Original durable fact"));
    ws.write(
      "home/config/agents/remember.md",
      '---\nname: remember\ndescription: "Recall durable context."\nmemory: local\ntools: ["read_file"]\n---\nRecall relevant memory and report.',
    );
    const snapshot = ws.write(
      `project/${identity.get("PROJECT_DIR")}/agent-memory-snapshots/${agentMemoryName("remember")}/snapshot.json`,
      JSON.stringify({
        schemaVersion: 1,
        createdAt: new Date(Date.now() + 500).toISOString(),
        files: { "replacement.md": fact("Replacement durable fact") },
      }),
    );
    const controller = new AbortController(),
      provider = new ScriptedProvider(
        [
          {
            toolCalls: [
              {
                name: "spawn_agent",
                input: {
                  role: "remember",
                  description: "Recall",
                  prompt: "Recall context",
                },
              },
            ],
          },
          { text: "Memory agent finished" },
        ],
        [{ text: "Memory observed" }],
      );
    const run = interactive(["--allow-project-trust"], ws, {
      provider,
      signal: controller.signal,
    });
    try {
      await run.idle();
      run.type("Recall memory" + KEY.enter);
      await run.waitFor((text) =>
        text.includes("Instantané de mémoire plus récent"),
      );
      expect(memory.read("original.md").text).toContain(
        "Original durable fact",
      );
      await sleep(400);
      run.type(accepted ? "o" : "n");
      await run.waitFor((text) => text.includes("Memory agent finished"));
      expect(memory.entries().map((entry) => entry.file)).toEqual([
        accepted ? "replacement.md" : "original.md",
      ]);
      expect(
        memory.read(accepted ? "replacement.md" : "original.md").text,
      ).toContain(
        accepted ? "Replacement durable fact" : "Original durable fact",
      );
    } finally {
      controller.abort();
      await run.done;
    }
  }
}, 15000);
