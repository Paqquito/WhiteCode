// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { Surveys } from "../src/interactive/surveys";
function fixture() {
  let enabled = true,
    accepted = false;
  const sent: any[] = [],
    shown: string[] = [],
    notices: string[] = [],
    frames: string[] = [];
  const s = new Surveys({
    enabled: () => enabled,
    available: () => true,
    busy: () => false,
    probability: () => 1,
    random: () => 0,
    shareProbability: () => 1,
    now: () => 1000,
    confirm: async (q) => {
      shown.push(q);
      return accepted;
    },
    comment: async () => "Great correction",
    send: async (body) => {
      sent.push(body);
    },
    history: () => [{ role: "user", text: "private conversation witness" }],
    redact: (s) => s,
    notice: (s) => notices.push(s),
    refresh: () => frames.push(s.prompt ?? ""),
    saveLast: () => {},
    last: 0,
  });
  return {
    s,
    sent,
    shown,
    notices,
    enabled: (v: boolean) => (enabled = v),
    accept: (v: boolean) => (accepted = v),
  };
}
test("SPEC-IHM-037/CA-01 — a bad rating followed by declined sharing sends neither transcript nor rating", async () => {
  const f = fixture();
  f.s.offer();
  expect(f.s.prompt).toContain("Alt+3");
  f.s.key({ name: "3", alt: true });
  await f.s.idle();
  expect(f.shown).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
  f.s.close();
});
test("SPEC-IHM-037/CA-02 — an administrative survey veto suppresses the prompt and every related request", async () => {
  const f = fixture();
  f.enabled(false);
  f.s.offer();
  expect(f.s.prompt).toBeUndefined();
  expect(f.shown).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
  f.s.close();
});
test("SPEC-CMD-099/CA-01 — praise without an attachment transmits only the reviewed positive comment", async () => {
  const f = fixture();
  let answer = 0;
  const s = new Surveys({
    ...f.s.options,
    confirm: async () => ++answer === 2,
  });
  await s.praise("Good exact fix", new AbortController().signal);
  expect(f.sent).toEqual([{ kind: "positive", comment: "Good exact fix" }]);
  expect(JSON.stringify(f.sent)).not.toContain("private conversation witness");
  s.close();
});
test("TECH — ordinary typing cancels a rating and remains available to the editor", () => {
  const f = fixture();
  f.s.offer();
  expect(f.s.key({ name: "a", text: "a" })).toBe(false);
  expect(f.s.prompt).toBeUndefined();
  expect(f.sent).toHaveLength(0);
  f.s.close();
});
