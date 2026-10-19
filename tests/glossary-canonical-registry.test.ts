// Supports: SPEC-CAD-003 (CA-02, complete activation inventory and reviewed contextual availability).
// Canonical names are read from the approved glossary, never inferred from code aliases.
import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILD_OPTIONS, resolveBuildOptions } from "../src/extension-points/build-options";
import { BUILD_TARGETS, libcBuildValues } from "../src/platform/build-target";
const root = resolve(import.meta.dir, ".."), glossary = readFileSync(join(root, "specs/00-cadre/SPEC-CAD-003-glossaire-et-nommage.md"), "utf8").split(/^## 4\./m)[1]!.split(/^## 5\./m)[0]!;
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

test("SPEC-CAD-003/CA-02 — every active activation header names a canonical option or retains its reviewed default availability", () => {
  const review = JSON.parse(readFileSync(join(root, "docs/audit-activation/qualifications.json"), "utf8")) as { qualifications: Array<{ id: string; path: string; activationHeader: string; reasoning: string; evidence: Array<{ path: string; text: string }> }> };
  expect(review.qualifications).toHaveLength(47);
  const walk = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]);
  const counts = { inactive: 0, option: 0, qualification: 0, always: 0, global: 0 };
  for (const path of walk(join(root, "specs")).filter(path => /SPEC-[A-Z]+-\d+[^\\/]*\.md$/.test(path))) {
    const text = readFileSync(path, "utf8"), lines = text.split(/\r?\n/), id = /SPEC-[A-Z]+-\d+/.exec(path)![0];
    const activation = lines.find(line => line.includes("**Activation cible**"))?.split("|")[2]?.trim() ?? "";
    const state = lines.find(line => line.includes("**État de la fiche**")) ?? "";
    if (/obsol[eè]te/i.test(state) || /^Hors (?:périmètre|du produit)/i.test(activation) || id === "SPEC-CAD-001") { counts.inactive++; continue; }
    if (canonical.some(name => activation.includes("`" + name + "`"))) { counts.option++; continue; }
    const qualification = review.qualifications.find(row => row.id === id);
    if (qualification) {
      expect(activation, id).toBe(qualification.activationHeader.split("|")[2]!.trim());
      expect(qualification.reasoning.length, id).toBeGreaterThan(0);
      for (const evidence of qualification.evidence) expect(readFileSync(join(root, evidence.path), "utf8"), id + " reviewed evidence").toContain(evidence.text);
      counts.qualification++; continue;
    }
    if (/^Toujours active(?:[,. ]|$)/.test(activation)) { counts.always++; continue; }
    expect(["SPEC-CAD-004", "SPEC-CAD-005"], id + " has unreviewed activation").toContain(id); counts.global++;
  }
  expect(counts).toEqual({ inactive: 22, option: 176, qualification: 47, always: 294, global: 2 });
  for (const profile of ["public", "internal", "development", "test"] as const) expect(resolveBuildOptions(profile).model_advisor).toBe(true);
});
