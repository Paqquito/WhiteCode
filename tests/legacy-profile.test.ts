// Supports: SPEC-MOD-023/024, SPEC-API-028, SPEC-OUT-046, SPEC-CMD-094/099, SPEC-IHM-037, SPEC-SES-013, SPEC-EXT-016, SPEC-CAD-002, SPEC-MCP-017.
import { test, expect } from "bun:test";
import { migrateLegacyProfile } from "../src/config/legacy-profile";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("SPEC-CAD-002/CA-16 — an explicitly declared previous profile is copied after human acceptance and remains intact", async () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-profile-")),
    old = join(root, "previous"),
    next = join(root, "current"),
    prompts: string[] = [];
  mkdirSync(old);
  writeFileSync(join(old, "config.json"), '{"ui":{"theme":"dark"}}');
  expect(
    await migrateLegacyProfile({
      sources: [old],
      destination: next,
      interactive: true,
      confirm: async (text) => {
        prompts.push(text);
        return true;
      },
    }),
  ).toBe(true);
  expect(prompts[0]).toContain(old);
  expect(readFileSync(join(next, "config.json"), "utf8")).toBe(
    readFileSync(join(old, "config.json"), "utf8"),
  );
  expect(existsSync(old)).toBe(true);
});
test("TECH — legacy migration never runs automatically, overwrites a new profile or follows overlapping roots", async () => {
  const root = mkdtempSync(join(tmpdir(), "legacy-refusal-")),
    old = join(root, "previous"),
    next = join(root, "current");
  mkdirSync(old);
  writeFileSync(join(old, "config.json"), "{}");
  let asked = false;
  expect(
    await migrateLegacyProfile({
      sources: [old],
      destination: next,
      interactive: false,
      confirm: async () => {
        asked = true;
        return true;
      },
    }),
  ).toBe(false);
  expect(asked).toBe(false);
  expect(
    await migrateLegacyProfile({
      sources: [old],
      destination: next,
      interactive: true,
      confirm: async () => false,
    }),
  ).toBe(false);
  expect(existsSync(next)).toBe(false);
  mkdirSync(next);
  writeFileSync(join(next, "config.json"), "keep");
  expect(
    await migrateLegacyProfile({
      sources: [old],
      destination: next,
      interactive: true,
      confirm: async () => {
        asked = true;
        return true;
      },
    }),
  ).toBe(false);
  expect(readFileSync(join(next, "config.json"), "utf8")).toBe("keep");
});
