import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runTurn } from "../src/engine/loop";
import { overflowTestTool } from "../src/tools/overflow-test";
import { ResultStore } from "../src/session/result-store";
import { cli, workspace } from "./helpers/env";
import { bench } from "./helpers/engine";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-MOT-024/CA-01 — typing the configured keyword highlights the actual editor cells", async () => {
  const controller = new AbortController(), run = interactive([], workspace(), { provider: new ScriptedProvider([]), signal: controller.signal, userConfig: { thinking: { maxKeyword: "focusnow" } } });
  try {
    await run.idle(); run.type("please FOCUSNOW"); await run.waitFor(text => text.includes("mot-clé sans effet"));
    const row = run.term.vt.grid.find(row => row.map(c => c.ch).join("").includes("FOCUSNOW")); expect(row).toBeDefined();
    const start = row!.map(c => c.ch).join("").indexOf("FOCUSNOW"); expect(row![start]?.sgr).toContain("1"); expect(row![start]?.sgr).toContain("4");
  } finally { controller.abort(); await run.done; }
});
test("SPEC-MOT-024/CA-02 — only the keyword turn uses maximum thinking, and the original message is retained", async () => {
  const controller = new AbortController(), provider = new ScriptedProvider([{ text: "first" }, { text: "second" }, { text: "fenced" }]);
  const run = interactive([], workspace(), { provider, signal: controller.signal, env: { ANTHROPIC_API_KEY: "fictitious-test-key" }, userConfig: { api: { provider: "anthropic", baseUrl: null }, thinking: { enabled: false }, models: { selected: "vendor-optional", effort: "low" } } });
  try {
    await run.waitFor(text => text.includes("Utiliser cette clé d'environnement")); await sleep(380); run.type("o");
    const startup = await Promise.race([run.idle().then(() => undefined), run.done]); if (startup) throw new Error(startup.stderr);
    run.type("deepthink solve this"); run.type(KEY.enter); await run.waitFor(text => text.includes("first")); await run.idle();
    run.type("next question"); run.type(KEY.enter); await run.waitFor(text => text.includes("second")); await run.idle();
    run.paste("```\ndeepthink\n```\nExplain this code"); run.type(KEY.enter); await run.waitFor(text => text.includes("fenced"));
    expect(provider.requests[0]?.thinking.enabled).toBe(true); expect(provider.requests[0]?.effort).toBe("high");
    expect(provider.requests[1]?.thinking.enabled).toBe(false); expect(provider.requests[1]?.effort).toBe("low"); expect(provider.requests[2]?.thinking.enabled).toBe(false);
    expect(JSON.stringify(provider.requests[0]?.history)).toContain("deepthink solve this");
  } finally { controller.abort(); await run.done; }
});
test("SPEC-OUT-048/CA-01 — the public CLI never advertises the internal overflow probe", async () => {
  const provider = new ScriptedProvider([{ text: "ok" }]); expect((await cli(["--non-interactive", "hello"], workspace(), { provider })).code).toBe(0);
  expect(provider.requests[0]?.tools.some(t => t.name === "overflow_test")).toBe(false);
});
test("SPEC-OUT-048/CA-02 — an overflow probe passes through the normal executor truncation and full-result store", async () => {
  const b = bench([{ toolCalls: [{ name: "overflow_test", input: { size: 50_000 } }] }, { text: "done" }], { tools: [overflowTestTool as never] });
  const store = new ResultStore(join(b.ws.root, "results"));
  await runTurn({ ...b.deps, executor: { ...b.deps.executor, largeResults: { store, limit: 4000 } } }, "probe", new AbortController().signal);
  const text = b.toolResults()[0]?.content[0]?.text ?? ""; expect(text.length).toBeLessThan(4500); expect(text).toContain("50000 characters");
  const full = readFileSync(join(store.dir, `overflow_test-${b.toolResults()[0]?.callId}.txt`), "utf8"); expect(full).toHaveLength(50_000); expect(full.startsWith("0123456789 probe ")).toBe(true);
});
