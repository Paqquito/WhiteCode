// Supports: SPEC-CAD-003 (CA-02, complete activation inventory and reviewed contextual availability).
// The documented options and the implementation must agree.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { specIndex } from "../scripts/spec-index";
import { BUILD_OPTIONS, resolveBuildOptions } from "../src/extension-points/build-options";
import { BUILD_TARGETS, libcBuildValues } from "../src/platform/build-target";
const root = resolve(import.meta.dir, ".."), glossary = readFileSync(join(root, "docs/options-de-compilation.md"), "utf8");
const canonical = [...new Set(glossary.split(/\r?\n/).filter(line => /^\| `/.test(line)).flatMap(line => [...line.split("|")[1]!.matchAll(/`([a-z][a-z_0-9]+)`/g)].map(match => match[1]!)))].sort();
const retired = ["ui_year_review", "internal_discreet", "defect_scan", "voice_input", "installation_test_versions", "ide_bridge", "connector_websocket", "remote_sessions", "extension_maintenance", "company_account", "settings_sync", "organization_metrics", "team_memory", "agent_memory", "terminal_setup", "review_artifact", "prompt_hints"];
test("TECH — the build registry has exactly the 134 approved canonical names and no compatibility aliases", () => {
  expect(canonical).toHaveLength(134);
  expect(Object.keys(BUILD_OPTIONS).sort()).toEqual(canonical);
  for (const name of retired) expect(() => resolveBuildOptions("internal", { [name]: true })).toThrow("inconnue");
  for (const entry of Object.values(BUILD_OPTIONS)) { expect(entry.implemented).toBe(true); expect(entry.specs.length).toBeGreaterThan(0); }
});
test("TECH — libc presence derives from each executable target and incompatible overrides are refused", () => {
  for (const target of BUILD_TARGETS) for (const profile of ["public", "internal", "development", "test"] as const) {
    const expected = libcBuildValues(target), values = resolveBuildOptions(profile, {}, target);
    expect(values.libc_variant_musl).toBe(expected.libc_variant_musl); expect(values.libc_variant_glibc).toBe(expected.libc_variant_glibc);
    for (const name of ["libc_variant_musl", "libc_variant_glibc"] as const) {
      expect(() => resolveBuildOptions(profile, { [name]: !expected[name] }, target)).toThrow("incompatible");
      expect(resolveBuildOptions(profile, { [name]: expected[name] }, target)[name]).toBe(expected[name]);
    }
  }
});
test("TECH — every source macro refers to a canonical registry option after the alignment", () => {
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
  const unknown = walk(join(root, "src")).filter(file => file.endsWith(".ts")).flatMap(path => [...readFileSync(path, "utf8").matchAll(/buildFlag\(["']([a-z_0-9]+)["']\)/g)].filter(match => !Object.hasOwn(BUILD_OPTIONS, match[1]!)).map(match => ({path, flag: match[1]})));
  expect(unknown).toEqual([]);
});

test("SPEC-CAD-003/CA-02 — every documented build option points to active references and the advisor is available in all profiles", () => {
  for (const option of Object.values(BUILD_OPTIONS)) {
    for (const reference of option.specs) expect(specIndex.get(reference)?.obsolete, reference).toBe(false);
  }
  for (const profile of ["public", "internal", "development", "test"] as const) expect(resolveBuildOptions(profile).model_advisor).toBe(true);
});
