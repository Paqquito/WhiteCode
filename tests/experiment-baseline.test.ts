import { expect, test } from "bun:test";
import { Settings } from "../src/config/settings";
import { baselineSettings, BASELINE_MECHANISMS } from "../src/autonomy/baseline";
test("SPEC-MOD-031/CA-01 — the reference mode disables implicit compaction, memory and background work", () => {
  const settings = Settings.load({ sources: [], projectTrusted: false }), baseline = baselineSettings(settings, true);
  for (const key of BASELINE_MECHANISMS) expect(baseline.get<boolean>(key)).toBe(false);
});
test("SPEC-MOD-031/CA-02 — explicitly enabled memory remains active while the other reference mechanisms stay disabled", () => {
  const settings = Settings.load({ sources: [{ scope: "user", name: "user", text: JSON.stringify({ memory: { automatic: { enabled: true } } }) }], projectTrusted: false }), baseline = baselineSettings(settings, true);
  expect(baseline.get<boolean>("memory.automatic.enabled")).toBe(true);
  for (const key of BASELINE_MECHANISMS.filter(key => key !== "memory.automatic.enabled")) expect(baseline.get<boolean>(key)).toBe(false);
});
test("TECH — experiment baseline never changes explicit or managed settings and keeps the original configuration untouched", () => {
  const settings = Settings.load({ sources: [{ scope: "user", name: "user", text: JSON.stringify({ memory: { automatic: { enabled: true } } }) }], projectTrusted: false });
  const baseline = baselineSettings(settings, true);
  expect(baseline.get<boolean>("memory.automatic.enabled")).toBe(true); expect(baseline.get<boolean>("context.autoCompact.enabled")).toBe(false); expect(settings.get<boolean>("context.autoCompact.enabled")).toBe(true);
  expect(BASELINE_MECHANISMS.length).toBe(7); expect(baselineSettings(settings, false)).toBe(settings);
});
