import { expect, test } from "bun:test";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("TECH — the actual baseline entrypoint refuses detached work and reports its effective versioned mechanisms", async () => {
  const ws = workspace(), identity = loadIdentity();
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { description: "Must not detach", role: "general", prompt: "No work", detached: true } }] }, request => { expect(JSON.stringify(request.history)).toContain("Background tasks are not available"); return { text: "BASELINE_COMPLETE_48" }; }]);
  const env = { [`${identity.get("ENV_PREFIX")}EXPERIMENT_BASELINE`]: "1" };
  const result = await cli(["--non-interactive", "Try detached work."], ws, { provider, env });
  expect(result.code).toBe(0); expect(result.stderr).toContain("Mode de référence expérimental"); expect(provider.requests.filter(request => request.purpose === "subagent")).toHaveLength(0);
  const status = await cli(["--non-interactive", "/status"], ws, { provider: new ScriptedProvider([]), env });
  expect(status.stdout).toContain("liste v1"); expect(status.stdout).toContain("context.autoCompact.enabled=false"); expect(status.stdout).toContain("tasks.enabled=false");
});
