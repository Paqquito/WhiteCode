import { expect, test } from "bun:test";
import { workspace } from "./helpers/env";
import {
  YearReview,
  reviewYear,
  type Animation,
} from "../src/interactive/year-review";
function fixture(enabled = true, installed = false) {
  const ws = workspace(),
    calls: string[] = [],
    played: Animation[] = [];
  const r = new YearReview({
    enabled: () => enabled,
    months: () => [12, 1],
    official: () => "official",
    extensionReady: () => installed,
    install: async () => {
      calls.push("install");
      return false;
    },
    skill: async () => {
      calls.push("skill");
      return "Create a terminal animation from annual totals.";
    },
    config: ws.configHome,
    sessions: ws.root + "/sessions",
    date: () => new Date(2026, 11, 15),
    play: async (a) => {
      played.push(a);
    },
  });
  return { ws, calls, played, r };
}
test("SPEC-IHM-033/CA-01 — an absent official extension asks for installation before statistics or generation", async () => {
  const f = fixture();
  expect(await f.r.command("generate", new AbortController().signal)).toEqual({
    note: expect.stringContaining("Installation non confirmée"),
  });
  expect(f.calls).toEqual(["install"]);
  expect(f.played).toEqual([]);
});
test("SPEC-IHM-033/CA-02 — an included but disabled year review has no collection, suggestion, installation or model call", async () => {
  const f = fixture(false);
  expect(f.r.available).toBe(false);
  expect(
    (await f.r.command("generate", new AbortController().signal)).refused,
  ).toBeDefined();
  expect(f.calls).toEqual([]);
  expect(f.played).toEqual([]);
});
test("SPEC-CMD-078/CA-01 — watching the existing animation plays its exact cached frames without invoking the skill", async () => {
  const f = fixture(true, true),
    animation = {
      year: 2026,
      frames: [
        { text: "2026: 12 sessions", durationMs: 20 },
        { text: "Merci !", durationMs: 20 },
      ],
    };
  f.ws.write("home/config/year-review/2026.json", JSON.stringify(animation));
  expect(
    (await f.r.command("watch", new AbortController().signal)).note,
  ).toContain("cache local");
  expect(f.played).toEqual([animation]);
  expect(f.calls).toEqual([]);
});
test("TECH — annual generation uses only this year’s local counts and rejects executable animations", async () => {
  const f = fixture(true, true);
  for (const year of [2025, 2026])
    f.ws.write(
      `sessions/project/${year}.jsonl`,
      JSON.stringify({
        type: "user",
        ts: `${year}-04-02T12:00:00Z`,
        data: { content: "DO NOT EXPORT THIS MESSAGE" },
      }),
    );
  const result = await f.r.command("generate", new AbortController().signal);
  expect(result.send).toContain('"sessions":1,"userMessages":1');
  expect(result.send).not.toContain("DO NOT EXPORT");
  expect(reviewYear(new Date(2027, 0, 5))).toBe(2026);
  f.ws.write(
    "home/config/year-review/2026.json",
    JSON.stringify({
      year: 2026,
      frames: [{ text: "\x1b]52;attack", durationMs: 20 }],
    }),
  );
  expect(f.r.cached()).toBeUndefined();
});
