import { expect, test } from "bun:test";
import { join } from "node:path";
import { workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-EXT-014/CA-02 — reloading a changed session extension uses the new skill body", async () => {
  const ws = workspace(), dir = join(ws.root, "extension"), controller = new AbortController();
  ws.write("extension/extension.json", JSON.stringify({ name: "local-check", version: "1.0.0", description: "Local checks." }));
  ws.write("extension/skills/check/definition.md", '---\ndescription: "Checks local changes."\n---\nFIRST_CHECK_WITNESS\n');
  const provider = new ScriptedProvider([{ text: "first check done" }, { text: "second check done" }]);
  const run = interactive(["--extension-dir", dir], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("/local-check:check"); run.type(KEY.enter); await run.waitFor(t => t.includes("first check done")); await run.idle();
    ws.write("extension/skills/check/definition.md", '---\ndescription: "Checks local changes."\n---\nSECOND_CHECK_WITNESS\n');
    run.type("/reload-extensions"); run.type(KEY.enter); await run.waitFor(t => t.includes("Extensions rechargées")); await run.idle();
    run.type("/local-check:check"); run.type(KEY.enter); await run.waitFor(t => t.includes("second check done"));
    expect(JSON.stringify(provider.requests[0]!.history)).toContain("FIRST_CHECK_WITNESS");
    expect(JSON.stringify(provider.requests[1]!.history.at(-1))).toContain("SECOND_CHECK_WITNESS");
  } finally { controller.abort(); await run.done; }
});

test("SPEC-EXT-038/CA-02 — a newly added local skill becomes selectable after reloading", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ text: "new skill done" }]);
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); ws.write("home/config/skills/fresh/definition.md", '---\ndescription: "Checks the new local feature."\n---\nNEW_LOCAL_SKILL_WITNESS\n');
    run.type("/reload-extensions"); run.type(KEY.enter); await run.waitFor(t => t.includes("Extensions rechargées")); await run.idle();
    run.type("/fresh"); run.type(KEY.enter); await run.waitFor(t => t.includes("new skill done"));
    expect(JSON.stringify(provider.requests[0]!.history)).toContain("NEW_LOCAL_SKILL_WITNESS");
  } finally { controller.abort(); await run.done; }
});
