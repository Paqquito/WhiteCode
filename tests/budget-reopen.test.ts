import { expect, test } from "bun:test";
import { join } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
import { BudgetLedger } from "../src/engine/budget";
import { TranscriptWriter } from "../src/session/transcript";
import { projectSessions, readTranscript } from "../src/session/sessions";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-MOD-005/CA-15 — reopening preserves confirmed costs and refuses the next request instead of replenishing the cap", async () => {
  const ws = workspace();
  const first = await cli(["--non-interactive", "--model", "large", "--max-cost", "0.90", "--result-format", "json", "first"], ws, { provider: new ScriptedProvider([{ text: "completed", usage: { input: 1000, output: 30000 } }]) });
  expect(first.code).toBe(0); const result = JSON.parse(first.stdout); expect(result.cost.confirmed).toBeCloseTo(0.604);
  const provider = new ScriptedProvider([{ text: "must not send" }]);
  const resumed = await cli(["--non-interactive", `--reopen=${result.sessionId}`, "--model", "large", "--max-cost", "0.90", "--result-format", "json", "next"], ws, { provider });
  expect(resumed.code).toBe(3); expect(provider.requests).toHaveLength(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ haltReason: "budget_limit", cost: { cap: 0.9, confirmed: 0.604 } });
});

test("SPEC-MOD-005/CA-15 — a crash with a durable pending reservation preserves that reservation on actual CLI resumption", async () => {
  const ws = workspace(); const ledger = new BudgetLedger(0.9, "USD"); const settled = ledger.admit(0.3, "main");
  if (!settled.admitted) throw new Error("fixture admission failed"); ledger.settle(settled.reservation, 0.2);
  expect(ledger.admit(0.5, "subagent").admitted).toBe(true);
  const writer = new TranscriptWriter({ sessionsDir: join(ws.configHome, "sessions"), projectRealPath: ws.project });
  writer.append("session_meta", { model: "test-large", provider: "openai_compatible" }); writer.append("system", { event: "budget_state", state: ledger.state }); writer.close();
  const provider = new ScriptedProvider([{ text: "must not send" }]);
  const resumed = await cli(["--non-interactive", `--reopen=${writer.sessionId}`, "--model", "large", "--max-cost", "0.90", "--result-format", "json", "next"], ws, { provider });
  expect(resumed.code).toBe(3); expect(provider.requests).toHaveLength(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({ haltReason: "budget_limit", cost: { confirmed: 0.2, reserved: 0.5 } });
  const state = readTranscript(writer.path).records.filter(record => record.data.event === "budget_state").at(-1)!.data.state;
  expect(state).toMatchObject({ reservations: [{ consumer: "subagent", bound: 0.5 }] });
});

test("TECH — interrupted conservative costs and unknown unbounded charges survive serialization; journal failures block capped admissions", () => {
  const old = new BudgetLedger(2, "USD"); const pending = old.admit(1.5, "main");
  if (!pending.admitted) throw new Error("fixture admission failed"); old.keepConservatively(pending.reservation);
  const resumed = new BudgetLedger(2, "USD"); resumed.restore(JSON.parse(JSON.stringify(old.state)));
  expect(resumed.snapshot.conservative).toBe(1.5); expect(resumed.admit(0.6, "main").admitted).toBe(false);
  const uncapped = new BudgetLedger(undefined, "USD"); const unknown = uncapped.admit(undefined, "unknown model");
  if (!unknown.admitted) throw new Error("fixture admission failed"); uncapped.settle(unknown.reservation, undefined);
  resumed.restore(uncapped.state); expect(resumed.admit(0.1, "main")).toMatchObject({ admitted: false, reason: "cost_cap_unverifiable" });
  const failed = new BudgetLedger(2, "USD"); failed.journal(() => false);
  expect(failed.admit(0.1, "main")).toMatchObject({ admitted: false, reason: "cost_cap_unverifiable" });
  expect(() => resumed.restore({ ...old.state, currency: "EUR" })).toThrow("devise");
  expect(() => resumed.restore({ ...old.state, confirmed: -1 })).toThrow("invalide");
  expect(() => resumed.restore({ ...old.state, reservations: [pending.reservation, pending.reservation] })).toThrow("invalide");
});

test("TECH — reserving is journaled before the provider receives its request; reopening at an old branch cannot roll back later spending", async () => {
  const ws = workspace(); let reservationSeen = false;
  const provider = new ScriptedProvider([() => {
    const projects = readdirSync(join(ws.configHome, "sessions"));
    const dir = join(ws.configHome, "sessions", projects[0]!); const file = readdirSync(dir).find(name => name.endsWith(".jsonl"))!;
    const records = String(readFileSync(join(dir, file))).trim().split("\n").map(line => JSON.parse(line));
    reservationSeen = records.filter(record => record.data.event === "budget_state").at(-1).data.state.reservations.some((reservation: { consumer: string }) => reservation.consumer === "main");
    return { text: "first", usage: { input: 100, output: 10000 } };
  }, { text: "second", usage: { input: 100, output: 20000 } }]);
  const first = await cli(["--non-interactive", "--model", "large", "--max-cost", "2", "--request-format", "jsonl", "--result-format", "json"], ws, { provider, stdin: '{"type":"user","content":"first"}\n{"type":"user","content":"second"}\n' });
  expect(first.code).toBe(0); expect(reservationSeen).toBe(true);
  const sessionId = JSON.parse(first.stdout).sessionId;
  const info = projectSessions(join(ws.configHome, "sessions"), ws.project).find(session => session.id === sessionId)!;
  const firstAnswer = readTranscript(info.path).records.find(record => record.type === "assistant")!;
  const resumed = await cli(["--non-interactive", `--reopen=${sessionId}`, "--reopen-at", firstAnswer.id, "--max-cost", "0.90", "--result-format", "json", "branch"], ws, { provider: new ScriptedProvider([]) });
  expect(resumed.code).toBe(3); expect(JSON.parse(resumed.stdout).cost.confirmed).toBeCloseTo(0.6008);
});
