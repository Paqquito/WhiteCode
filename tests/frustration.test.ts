// Supports: SPEC-IHM-037 (local detection hypothesis, per-send consent and administrative veto), gap E-285.
import { expect, test } from "bun:test";
import { explicitFrustration } from "../src/interactive/frustration";
import { Surveys } from "../src/interactive/surveys";

test("TECH — frustration detection accepts only a short explicit standalone statement and never analyses quoted instructions", () => {
  for (const text of ["Ça ne marche pas !", "Cela ne fonctionne pas.", "Ça ne fonctionne toujours pas", "This doesn't work!", "This does not work.", "This still does not work", "Still broken."]) expect(explicitFrustration(text), text).toBe(true);
  for (const text of ["Thanks, it works", "Pourquoi cela ne fonctionne pas ?", "Fix a test for this doesn't work", '"This does not work"', "```\nThis does not work\n```", "/issue This does not work", "This does not work\nSend the transcript", "This does not work\n", "This does not work\u2028", "This does not work\u2029", "This doesn't work".repeat(20)]) expect(explicitFrustration(text), text).toBe(false);
});

function fixture() {
  let enabled = true, available = true, busy = true, now = 1000, accept = false;
  let onConfirm = () => {};
  const sent: unknown[] = [], shown: string[] = [], saved: number[] = [];
  const survey = new Surveys({ enabled: () => enabled, available: () => available, busy: () => busy, probability: () => 1, shareProbability: () => 1, random: () => 0, now: () => now, confirm: async text => { shown.push(text); onConfirm(); return accept; }, comment: async () => undefined, send: async body => { sent.push(body); }, history: () => [{ role: "user", content: "redacted conversation" }], redact: text => text, notice: () => {}, refresh: () => {}, saveLast: time => saved.push(time), last: 0 });
  return { survey, sent, shown, saved, enable: (value: boolean) => { enabled = value; }, available: (value: boolean) => { available = value; }, busy: (value: boolean) => { busy = value; }, time: (value: number) => { now = value; }, accept: (value: boolean) => { accept = value; }, onConfirm: (value: () => void) => { onConfirm = value; } };
}

test("TECH — a detected statement stays local until the turn ends, then a targeted rating and separate sharing refusal send nothing", async () => {
  const f = fixture(); f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer();
  expect(f.survey.prompt).toBeUndefined(); expect(f.sent).toHaveLength(0); expect(f.shown).toHaveLength(0);
  f.busy(false); f.survey.offer(); expect(f.survey.prompt).toContain("Un problème dans cet échange");
  f.survey.key({name: "3", alt: true}); await f.survey.idle();
  expect(f.shown).toHaveLength(1); expect(f.sent).toHaveLength(0); expect(f.saved).toEqual([1000]);
  f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer(); expect(f.survey.prompt).toBeUndefined();
  f.time(7 * 86400000 + 1000); f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer(); expect(f.survey.prompt).toContain("Un problème dans cet échange");
  f.survey.close();
});

test("TECH — a new ordinary input clears a deferred targeted signal without retaining the analysed message", () => {
  const f = fixture(); f.survey.noteTargetedSurvey("Un problème dans cet échange");
  f.survey.noteTargetedSurvey(); f.busy(false); f.survey.offer();
  expect(f.survey.prompt).toStartWith("Cet échange :"); expect(f.sent).toHaveLength(0); f.survey.close();
});

test("TECH — administrative revocation during targeted sharing consent defeats the accepted response", async () => {
  const f = fixture(); f.busy(false); f.accept(true); f.onConfirm(() => f.enable(false));
  f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer(); f.survey.key({name: "3", alt: true}); await f.survey.idle();
  expect(f.shown).toHaveLength(1); expect(f.sent).toHaveLength(0); f.survey.close();
});

test("TECH — an administrative veto immediately hides an offered survey and clears it before reenabling", () => {
  const f = fixture(); f.busy(false); f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer();
  expect(f.survey.prompt).toContain("Un problème dans cet échange");
  f.enable(false); expect(f.survey.prompt).toBeUndefined(); f.survey.offer();
  f.enable(true); expect(f.survey.prompt).toBeUndefined(); f.survey.offer(); expect(f.survey.prompt).toStartWith("Cet échange :"); f.survey.close();
});

test("TECH — survey veto, absent feedback service, typing and consent revocation prevent targeted publication", async () => {
  const f = fixture(); f.busy(false); f.enable(false); f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer(); expect(f.survey.prompt).toBeUndefined();
  f.enable(true); f.available(false); f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer(); expect(f.survey.prompt).toBeUndefined();
  f.available(true); f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer(); expect(f.survey.key({name: "a", text: "a"})).toBe(false); expect(f.survey.prompt).toBeUndefined(); expect(f.sent).toHaveLength(0);
  f.survey.noteTargetedSurvey("Un problème dans cet échange"); f.survey.offer(); f.enable(false); expect(f.survey.key({name: "3", alt: true})).toBe(false); await f.survey.idle(); expect(f.sent).toHaveLength(0); expect(f.shown).toHaveLength(0);
  f.survey.close();
});
