import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { SkillImprovements } from "../src/skills/improvements";
import { proposeTestSkill } from "../src/skills/generate";
import { rankCandidates } from "../src/interactive/completion";
import { decide, type PermissionContext } from "../src/permissions/engine";
import { currentPlatform } from "../src/platform/system";

test("SPEC-EXT-037/CA-01 — package test scripts produce a minimal reviewable skill without executing commands", () => {
  const ws = workspace(); ws.write("project/package.json", JSON.stringify({ scripts: { test: "echo NEVER_EXECUTE_ANALYSIS" } }));
  const proposal = proposeTestSkill(ws.project, () => false)!; expect(proposal).toContain("name: project-tests"); expect(proposal).toContain("tools: [read_file]"); expect(proposeTestSkill(ws.project, () => true)).toBeUndefined();
});
test("SPEC-EXT-039/CA-01, SPEC-EXT-039/CA-02 — repeated corrections produce a proposal at the cadence, dismissed content is never proposed again", async () => {
  const shown: unknown[] = [], proposal = JSON.stringify({ skill: "check", reason: "The user twice corrected the procedure.", content: "Updated English instructions." });
  const improvements = new SkillImprovements({ every: () => 3, allowed: name => name === "check", analyze: async () => proposal, present: value => shown.push(value) });
  await improvements.turn(); await improvements.turn(); expect(shown).toEqual([]); await improvements.turn(); expect(shown).toHaveLength(1); improvements.dismiss();
  for (let n = 0; n < 6; n++) await improvements.turn(); expect(shown).toHaveLength(1);
});
test("TECH — dismissed skill proposals cannot recur merely by changing line endings", async () => {
  let alternate = false; const shown: unknown[] = [], content = "---\nname: check\ndescription: Check fixtures.\n---\nCheck the fixture.\n";
  const improvements = new SkillImprovements({ every: () => 1, allowed: () => true, analyze: async () => JSON.stringify({ skill: "check", reason: "Repeated correction", content: alternate ? content.replaceAll("\n", "\r\n") : content }), present: value => shown.push(value) });
  await improvements.turn(); improvements.dismiss(); alternate = true; await improvements.turn(); expect(shown).toHaveLength(1);
});
test("SPEC-EXT-040/CA-01 — actual skill invocations feed the slash completion ranking", async () => {
  const ws = workspace(); ws.write("home/config/skills/check/definition.md", "---\nname: check\ndescription: Checks fixtures.\n---\nRead the fixture.\n");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "check" } }] }, { text: "Skill used" }]);
  expect((await cli(["--non-interactive", "Use check"], ws, { provider, userConfig: { permissions: { allowRules: ["use_skill(check)"] } } })).code).toBe(0);
  const usage = new Map(Object.entries(JSON.parse(readFileSync(join(ws.configHome, "completion-usage.json"), "utf8"))));
  const ranked = rankCandidates("/", [{ value: "/other", label: "other", kind: "command" }, { value: "/check", label: "check", kind: "command" }] as never, { fuzzy: true, usage: usage as never }); expect(ranked[0]!.value).toBe("/check");
});
test("SPEC-BLD-005/CA-01 — file discovery works with no native search binary in the executable path", async () => {
  const ws = workspace(), a = ws.write("project/src/a.ts", "A"), b = ws.write("project/src/b.ts", "B"); ws.write("project/.gitignore", "ignored/\n"); ws.write("project/ignored/c.ts", "C");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "find_files", input: { pattern: "**/*.ts" } }] }, { text: "Found" }]);
  expect((await cli(["--non-interactive", "Find source"], ws, { provider, env: { PATH: "" } })).code).toBe(0);
  const results = JSON.stringify(provider.requests[1]!.history); expect(results).toContain(a.replace(/\\/g, "\\\\")); expect(results).toContain(b.replace(/\\/g, "\\\\")); expect(results).not.toContain("ignored/c.ts");
});
test("SPEC-PER-007/CA-03 — a shadow parser divergence is measured without changing the existing decision or logging commands", () => {
  const reports: unknown[] = [], ctx: PermissionContext = { mode: "unrestricted", rules: [], sessionAllows: [], managedRulesOnly: false, cwd: "/fixture", home: "/home", platform: currentPlatform(), shellShadow: value => reports.push(value) };
  const query = { toolName: "run_shell", subject: { kind: "command" as const, command: "echo $(printf SHADOW_PRIVATE_WITNESS)" }, available: true, flags: { readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: false } };
  expect(decide(query, ctx)).toEqual(decide(query, { ...ctx, shellShadow: undefined })); expect(reports).toEqual([{ existing: "allow", candidate: "ask" }]); expect(JSON.stringify(reports)).not.toContain("SHADOW_PRIVATE_WITNESS");
});
