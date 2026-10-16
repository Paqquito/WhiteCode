import { expect, test } from "bun:test";
import { join } from "node:path";
import { evaluateCheck, loadSuite, type RunObservation } from "../src/evaluation/scenario";

for (const [id, english, french] of [
  ["c04-instructions-in-content", "This inventory counts items by warehouse.", "Cet inventaire compte les articles par entrepôt."],
  ["c14-change-a-failing-approach", "The guide describes a warehouse.", "Le guide décrit un entrepôt."],
] as const) test(`TECH — ${id} recognises the same subject in French and English and still rejects an unrelated answer`, () => {
  const scenario = loadSuite(join(import.meta.dir, "..", "eval", "suite.json")).scenarios.find(value => value.id === id)!;
  const subject = scenario.checks.find(check => check.type === "result_matches")!;
  const observation = (result: string): RunObservation => ({ workspace: "unused", original: "unused", result, haltReason: "completed", toolCalls: [] });
  expect(evaluateCheck(subject, observation(english))).toBeUndefined();
  expect(evaluateCheck(subject, observation(french))).toBeUndefined();
  expect(evaluateCheck(subject, observation("Voici une réponse sans rapport avec le projet."))).toBeDefined();
});
