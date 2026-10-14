// Supports: SPEC-SES-008/CA-01 and SPEC-MOD-005/CA-18.
import { expect, test } from "bun:test";
import { readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { BudgetLedger } from "../src/engine/budget";
import { sampleSideText } from "../src/engine/side-text";
import { projectKey, readTranscript } from "../src/session/transcript";
import { sessionTitle } from "../src/session/sessions";
import { validGeneratedTitle } from "../src/session/title";
import { cli, testModel, workspace } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-SES-008/CA-01 — the first completed exchange gets a validated background title recorded in the session", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ text: "Pagination fixed." }, { text: "Correction de la pagination locale", delayMs: 200 }]);
  const run = interactive([], ws, { provider, signal: controller.signal, userConfig: { sessions: { autoTitle: true } } });
  try {
    await run.idle(); run.type("Correct pagination."); run.type(KEY.enter); await run.waitFor(text => text.includes("Pagination fixed."));
    const directory = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)));
    const title = () => sessionTitle(readTranscript(join(directory, readdirSync(directory).find(name => name.endsWith(".jsonl"))!)).records);
    await run.waitFor(() => title() === "Correction de la pagination locale", "stored background title");
    expect(provider.requests).toHaveLength(2); expect(provider.requests[1]!.purpose).toBe("side"); expect(provider.requests[1]!.tools).toHaveLength(0); expect(title()!.split(/\s+/)).toHaveLength(5);
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-MOD-005/CA-18 — an exhausted shared budget prevents the title request from reaching the provider", async () => {
  const model = testModel("small");
  const ledger = new BudgetLedger(0.001, "USD"), provider = new ScriptedProvider([{ text: "This call must not run" }]);
  const reserved = ledger.admit(0.001, "main"); if (!reserved.admitted) throw new Error("fixture admission failed"); ledger.settle(reserved.reservation, 0.001);
  const title = await sampleSideText({ provider, model, ledger, pricing: model.pricing, system: "Return a title.", text: "Conversation.", consumer: "session_title", signal: new AbortController().signal });
  expect(title).toBeUndefined(); expect(provider.requests).toHaveLength(0); expect(ledger.snapshot.confirmed).toBe(0.001);
});

test("TECH — invalid titles and noninteractive or minimal metadata traffic are excluded", async () => {
  for (const value of ["Two words", "a b c d e f g h", "line one\nline two", "x".repeat(81)]) expect(validGeneratedTitle(value)).toBeUndefined();
  for (const flags of [["--non-interactive"], ["--non-interactive", "--minimal"]]) {
    const provider = new ScriptedProvider([{ text: "Done." }]); const result = await cli([...flags, "Task."], workspace(), { provider, userConfig: { sessions: { autoTitle: true } } }); expect(result.code).toBe(0); expect(provider.requests).toHaveLength(1);
  }
});
