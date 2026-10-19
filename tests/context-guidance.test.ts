import { profiledTest } from "./helpers/profiled-test";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ModelProvider } from "../src/providers/types";
import { projectKey } from "../src/session/transcript";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
const internalProfileTest = profiledTest(import.meta.path, "internal");

test("SPEC-CMD-101/CA-01 — prune-history reduces the next request and preserves user text and the raw archive", async () => {
  const ws = workspace(), file = ws.write("project/large.txt", Array.from({ length: 400 }, (_, n) => `ARCHIVE_WITNESS_${n} ${"x".repeat(70)}`).join("\n"));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "READ_FINISHED" }, { text: "PRUNE_FINISHED" }]), controller = new AbortController();
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("USER_MUST_STAY" + KEY.enter); await run.waitFor(text => text.includes("READ_FINISHED")); await run.idle();
    const before = JSON.stringify(provider.requests[1]!.history).length; run.type("/prune-history" + KEY.enter); await run.waitFor(text => text.includes("Élagage demandé")); await run.idle();
    run.type("Continue." + KEY.enter); await run.waitFor(text => text.includes("PRUNE_FINISHED")); const history = JSON.stringify(provider.requests[2]!.history);
    expect(history.length).toBeLessThan(before / 2); expect(history).toContain("USER_MUST_STAY"); expect(history).toContain("Pruned result"); expect(history).not.toContain("ARCHIVE_WITNESS_399");
    expect(run.all().join("\n")).toContain("jetons libérés");
  } finally { controller.abort(); await run.done; }
  const directory = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)));
  const raw = readdirSync(directory).filter(name => name.endsWith(".jsonl")).map(name => readFileSync(join(directory, name), "utf8")).join("\n");
  expect(raw).toContain("ARCHIVE_WITNESS_0"); expect(raw).toContain("USER_MUST_STAY");
}, 15_000);

{
  const test = internalProfileTest;
test("SPEC-CMD-096/CA-01 — getting-started retains the selected theme and every existing setting when skipped", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([]);
  const run = interactive([], ws, { provider, signal: controller.signal, userConfig: { ui: { theme: "dark" } } });
  const config = join(ws.configHome, "config.json"), original = readFileSync(config, "utf8");
  try {
    await run.idle(); run.type("/getting-started" + KEY.enter); await run.waitFor(text => text.includes("Thème actuel : dark")); await sleep(380); run.type(KEY.enter);
    await run.waitFor(text => text.includes("Modèle actuel")); await sleep(380); run.type(KEY.enter); await run.waitFor(text => text.includes("Parcours terminé"));
    expect(readFileSync(config, "utf8")).toBe(original); expect(provider.requests).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
}, 15_000);
}


test("SPEC-IHM-002/CA-03 — reading earlier history holds its position while incoming text shows a new-content indicator", async () => {
  const base = new ScriptedProvider([{ text: "```text\n" + Array.from({ length: 40 }, (_, n) => `OLD_LINE_${n}`).join("\n") + "\n```" }, { text: "LIVE_START", delayMs: 50 }]);
  let release!: () => void, finish!: () => void; const more = new Promise<void>(resolve => { release = resolve; }), ending = new Promise<void>(resolve => { finish = resolve; });
  const provider: ModelProvider = { id: base.id, async *stream(request, signal) {
    for await (const event of base.stream(request, signal)) {
      if (base.requests.length === 2 && event.type === "message_complete") { await more; yield { type: "text_delta", text: "LIVE_MORE" }; await ending; }
      yield event;
    }
  } };
  const controller = new AbortController(), run = interactive([], workspace(), { provider, signal: controller.signal, rows: 18, userConfig: { ui: { transcript: { collapseThreshold: 100 } } } });
  try {
    await run.idle(); run.type("First." + KEY.enter); await run.waitFor(text => text.includes("OLD_LINE_39")); await run.idle(); run.type("Next." + KEY.enter); await run.waitFor(text => text.includes("LIVE_START"));
    run.type("\u001bt"); await sleep(40); run.type("\u001b[H"); await sleep(40); const top = run.screen().slice(1, 8).join("\n"); release();
    await run.waitFor(() => run.screen()[0]?.includes("nouveau contenu") ?? false); expect(run.screen().slice(1, 8).join("\n")).toBe(top);
    run.type("\u001b[F"); await sleep(50); expect(run.screen()[0]).not.toContain("nouveau contenu");
  } finally { release(); finish(); controller.abort(); await run.done; }
}, 15_000);
