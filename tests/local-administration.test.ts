import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace, loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Host } from "./helpers/control";
import { interactive, sleep } from "./helpers/interactive";
import { sandboxDiagnostic } from "../src/permissions/sandbox-diagnostic";
import { parseSkill } from "../src/skills/registry";

test("SPEC-CMD-004/CA-01 — assisted creation returns an English definition for review before a protected save", async () => {
  const ws = workspace(), draft = '---\nname: test-helper\ndescription: Runs repository tests.\ntools: [read_file]\n---\nRead the project test procedure and report observed results.\n'; let approvals = 0;
  const provider = new ScriptedProvider([{ text: draft }]); const host = new Host(ws, { provider, init: { decisionAuthority: true }, answers: { approval_request: () => { approvals++; return { decision: "allow" }; } } });
  try {
    const proposed = await host.request("invoke_command", { command: "/agents create Help with tests" }); expect(JSON.stringify(proposed)).toContain("test-helper"); const path = join(ws.configHome, "agents", "test-helper.md"); expect(existsSync(path)).toBe(false); expect(approvals).toBe(0);
    const saved = await host.request("invoke_command", { command: "/agents save" }); expect(saved["ok"]).toBe(true); expect(readFileSync(path, "utf8")).toBe(draft); expect(approvals).toBeGreaterThan(0);
  } finally { host.feed.end(); await host.finish(); }
});
test("SPEC-CMD-004/CA-02 — a built-in agent is read-only and offers a homonymous user copy", async () => {
  const ws = workspace(), provider = new ScriptedProvider([]); const result = await cli(["--non-interactive", "/agents general"], ws, { provider });
  expect(result.code).toBe(0); expect(result.stdout + result.stderr).toContain("lecture seule"); expect(result.stdout + result.stderr).toContain("/agents copy general"); expect(existsSync(join(ws.configHome, "agents", "general.md"))).toBe(false); expect(provider.requests).toHaveLength(0);
});
test("TECH — incomplete assisted agent definitions and invalid skill headers are rejected", async () => {
  for (const draft of ["---\nname: incomplete\ndescription: Incomplete agent.\ntools: []\n---\n", "---\nname: incomplete\ndescription: Incomplete agent.\n---\nInstructions without explicit tools."]) {
    const ws = workspace(), result = await cli(["--non-interactive", "/agents create Fixture"], ws, { provider: new ScriptedProvider([{ text: draft }]) });
    expect(result.code).toBe(2); expect(existsSync(join(ws.configHome, "agents", "incomplete.md"))).toBe(false);
  }
  for (const content of ["---\nname: check\n---\nUpdated instructions.", "---\nname: check\ndescription: Check fixtures.\ntools: wrong\n---\nInstructions."]) expect(parseSkill(content, "fixture", "check", "project", false, [])).toBeUndefined();
});
test("SPEC-CMD-062/CA-01 — missing sandbox dependencies display specific installation instructions", async () => {
  expect(sandboxDiagnostic("linux", () => undefined)).toContain("bubblewrap et socat");
  const result = await cli(["--non-interactive", "/sandbox"], workspace(), { provider: new ScriptedProvider([]) }); expect(result.code).toBe(0); expect(result.stdout + result.stderr).toContain("isolation");
});
test("SPEC-CMD-042/CA-01 — selecting missing local instructions creates a protected file and opens its editor", async () => {
  const ws = workspace(), path = join(ws.project, loadIdentity().get("LOCAL_INSTRUCTIONS_FILE")), stop = new AbortController();
  const run = interactive([], ws, { signal: stop.signal, provider: new ScriptedProvider([]) });
  try {
    await run.idle(); run.type("/memory\r"); await run.waitFor(t => t.includes("Instructions locales")); await sleep(380); run.type("1");
    await run.waitFor(t => t.includes("Autorisation requise")); await sleep(380); run.type("1");
    await run.waitFor(t => t.includes("Éditer les instructions locales")); expect(existsSync(path)).toBe(true); expect(readFileSync(path, "utf8")).toContain("Local project instructions");
  } finally { stop.abort(); await run.done; }
}, 12000);
test("SPEC-EXT-034/CA-01 — model API guidance loads an independently dated distribution reference before answering", async () => {
  const ws = workspace(), path = ws.write("home/config/api-reference.json", JSON.stringify({ date: "2026-10-14", provider: "openai_compatible", content: "The recent model identifier in this fixture is reference-model-73." }));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "ai-api-guide", arguments: "Which recent model identifier?" } }] }, request => { expect(JSON.stringify(request.history)).toContain("reference-model-73"); expect(JSON.stringify(request.history)).toContain("2026-10-14"); return { text: "The dated reference specifies reference-model-73." }; }]);
  const result = await cli(["--non-interactive", "Find the recent model identifier"], ws, { provider, userConfig: { skills: { apiReferenceFile: path }, permissions: { allowRules: ["use_skill(ai-api-guide)"] } } }); expect(result.code).toBe(0);
});
test("TECH — host deny rules and intervening edits protect a pending skill improvement", async () => {
  const ws = workspace(), original = "---\nname: check\ndescription: Checks fixtures.\n---\nPRIVATE_SKILL_SOURCE_51\n", path = ws.write(`project/${loadIdentity().get("PROJECT_DIR")}/skills/check/definition.md`, original);
  const proposal = { skill: "check", reason: "Repeated user correction of the test command.", content: original.replace("PRIVATE_SKILL_SOURCE_51", "Use the corrected test procedure.") };
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "check" } }] }, { text: "First correction" }, { text: "Second correction" }, { text: JSON.stringify(proposal) }]);
  const host = new Host(ws, { provider, argv: ["--allow-project-trust"], init: { decisionAuthority: true }, userConfig: { skills: { improvements: { enabled: true, everyTurns: 2 } }, permissions: { allowRules: ["use_skill(check)"] } } });
  try {
    host.user("Use check"); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === 1); host.user("Correct the procedure again"); await host.waitFor(m => m.type === "notification" && String(m["message"]).includes("Amélioration proposée"));
    const rule = "read_file(/" + loadIdentity().get("PROJECT_DIR") + "/skills/check/definition.md)";
    await host.request("set_tool_permissions", { add: [{ decision: "deny", rule }] }); const denied = await host.request("invoke_command", { command: "/skill-improvements" });
    expect(JSON.stringify(denied)).toContain("exclue"); expect(JSON.stringify(denied)).not.toContain("PRIVATE_SKILL_SOURCE_51");
    await host.request("set_tool_permissions", { remove: [rule] }); const changed = original + "Human edit\n"; writeFileSync(path, changed);
    const stale = await host.request("invoke_command", { command: "/skill-improvements apply" }); expect(JSON.stringify(stale)).toContain("changé"); expect(readFileSync(path, "utf8")).toBe(changed);
  } finally { host.feed.end(); await host.finish(); }
});
