import { expect, test } from "bun:test";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

for (const reduced of [true, false]) test("SPEC-IHM-038/CA-02 SPEC-IHM-022/CA-02 — a reduced-motion turn has a static waiting display, with animation as a control", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([{ hang: true }]);
  const run = interactive(["Work."], ws, { provider, userConfig: { ui: { reducedMotion: reduced, hints: { enabled: false } } } });
  await run.waitFor(() => provider.requests.length === 1);
  await sleep(150);
  const before = run.screen().join("\n");
  const frames = new Set([before]);
  for (let i = 0; i < 4; i++) { await sleep(130); frames.add(run.screen().join("\n")); }
  if (reduced) expect(frames.size).toBe(1);
  else expect(frames.size).toBeGreaterThan(1);
  run.type(KEY.ctrlC);
  await run.idle();
  run.type(KEY.ctrlD); run.type(KEY.ctrlD);
  expect((await run.done).code).toBe(0);
});
