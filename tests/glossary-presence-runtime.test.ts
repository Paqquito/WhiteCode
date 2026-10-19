import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { activationProfile } from "./helpers/activation-profile";
const removed = Object.fromEntries(["model_fast_output", "engine_tool_summaries", "engine_control_channel", "browser_user_control", "storage_encryption", "ui_frustration_detection", "config_feature_overrides"].map(name => [name, false]));
function probe(profile: "public" | "internal", overrides: Record<string, boolean>, mode: string) {
  const fixture = activationProfile(profile, overrides), result = spawnSync(process.execPath, ["--no-env-file", "tests/fixtures/activation-thirty-one-probe.ts", mode], {cwd: fixture.root, env: fixture.environment, encoding: "utf8", windowsHide: true, timeout: 25000, maxBuffer: 2000000});
  const proof = {profile, overrides, mode, code: result.status, stdout: result.stdout, stderr: result.stderr}; writeFileSync(join(fixture.root, "proof-" + mode + ".json"), JSON.stringify(proof, null, 2));
  if (result.status !== 0) throw Error(JSON.stringify(proof));
  return JSON.parse(result.stdout) as {results: Record<string, {code: number; requests: number; vaultReads: number; vaultWrites: number; archives: boolean; stderr: string}>; outcomes: Array<{input: string; targeted: boolean; ordinarySurvey: boolean; requests: number; feedback: number; draftPreserved: boolean}>};
}
test("TECH — absent runtime capabilities refuse explicit settings, CLI options and environment before model, vault or archive effects", () => {
  const result = probe("internal", removed, "runtime");
  expect(result.results.ordinary?.code).toBe(0); expect(result.results.ordinary?.requests).toBe(1);
  for (const name of ["fast", "browser-setting", "browser-option", "encryption", "control-setting", "control-option", "overrides"]) {
    const actual = result.results[name]!; expect({name, code: actual.code, requests: actual.requests}).toEqual({name, code: 2, requests: 0});
    expect(actual.vaultReads).toBe(0); expect(actual.vaultWrites).toBe(0); expect(actual.archives).toBe(false);
  }
}, 30000);
test("TECH — frustration inspects only ordinary user text in the internal profile and never sends feedback automatically", () => {
  for (const [profile, overrides] of [["public", {}], ["internal", {}], ["internal", removed]] as Array<["public" | "internal", Record<string, boolean>]>) {
    const result = probe(profile, overrides, "frustration");
    for (const outcome of result.outcomes) {
      expect(outcome.requests).toBe(1); expect(outcome.feedback).toBe(0);
      expect({profile, input: outcome.input, targeted: outcome.targeted}).toEqual({profile, input: outcome.input, targeted: profile === "internal" && overrides.ui_frustration_detection !== false && outcome.input === "typed"});
      if (outcome.input === "veto") expect(outcome.ordinarySurvey).toBe(false);
      if (outcome.input === "edited-during-turn") expect(outcome.draftPreserved).toBe(true);
    }
  }
}, 60000);
