// Supports: SPEC-MOT-036/CA-01/02/03, SPEC-MOT-037/CA-01/02.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectKey } from "../src/session/transcript";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";

const INDEX = loadIdentity().get("MEMORY_INDEX_FILE");
const feedback = "---\nname: Integration tests\ndescription: Prefer integration tests for behavior changes\ntype: feedback\n---\nThe user prefers integration tests because they verify observable behavior.\n";
const deployment = "---\nname: Deployment procedure\ndescription: Runbook for deployment\ntype: reference\n---\nDEPLOY_PROCEDURE_543: validate migrations, then publish the staged artifact.\n";
const memoryDirectory = (ws: ReturnType<typeof workspace>) => join(ws.configHome, "memory", projectKey(realpathSync(ws.project)));
const config = { memory: { automatic: { enabled: true }, recall: { enabled: false }, autoExtraction: { enabled: false }, session: { enabled: false } } };

test("SPEC-MOT-036/CA-01 — an explicit memory request creates a feedback file and an index line without asking for file approval", async () => {
  const ws = workspace(), file = join(memoryDirectory(ws), "tests.md"); let approvals = 0;
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: file, content: feedback } }] }, { text: "Preference remembered." }]);
  const result = await cli(["--non-interactive", "--approval-mode", "auto_edit", "Remember that I prefer integration tests."], ws, { provider, userConfig: config, extra: { authorities: { human: { request: async () => { approvals++; return { answer: "no" }; } } } } });
  expect(result.code).toBe(0); expect(approvals).toBe(0); expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toContain("type: feedback"); expect(readFileSync(join(memoryDirectory(ws), INDEX), "utf8")).toContain("[Integration tests](tests.md) (feedback)");
});

test("SPEC-MOT-036/CA-02 — a new session includes the persisted project memory index in its system context", async () => {
  const ws = workspace(), file = join(memoryDirectory(ws), "tests.md");
  await cli(["--non-interactive", "--approval-mode", "auto_edit", "Remember the preference."], ws, { userConfig: config, provider: new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: file, content: feedback } }] }, { text: "Saved." }]) });
  const provider = new ScriptedProvider([{ text: "New session." }]); const result = await cli(["--non-interactive", "Continue."], ws, { userConfig: config, provider });
  expect(result.code).toBe(0); const system = provider.requests[0]!.system.map(block => block.text).join("\n");
  expect(system).toContain("[Integration tests](tests.md)"); expect(system).toContain("untrusted contextual data");
});

test("SPEC-MOT-036/CA-03 — disabled memory excludes an existing index and its instructions from the system context", async () => {
  const ws = workspace(); ws.write("home/config/memory/" + projectKey(realpathSync(ws.project)) + "/" + INDEX, "MEMORY_DISABLED_SENTINEL_543\n");
  const provider = new ScriptedProvider([{ text: "Done." }]); const result = await cli(["--non-interactive", "Work."], ws, { provider, userConfig: { memory: { automatic: { enabled: false }, session: { enabled: false } } } });
  expect(result.code).toBe(0); expect(JSON.stringify(provider.requests[0]!.system)).not.toContain("MEMORY_DISABLED_SENTINEL_543"); expect(JSON.stringify(provider.requests[0]!.system)).not.toContain("# Project memory");
});

test("SPEC-MOT-037/CA-01 — SPEC-MOT-037/CA-02 — a selected deployment memory is attached once and excluded from later selections", async () => {
  const ws = workspace(), dir = memoryDirectory(ws); ws.write("home/config/memory/" + projectKey(realpathSync(ws.project)) + "/deploy.md", deployment);
  ws.write("home/config/memory/" + projectKey(realpathSync(ws.project)) + "/" + INDEX, "# Project memory index\n- [Deployment procedure](deploy.md) (reference): Runbook for deployment\n");
  const provider = new ScriptedProvider([request => { expect(request.purpose).toBe("side"); expect(JSON.stringify(request.history)).toContain("deploy.md"); return { text: '["deploy.md"]' }; }, request => { expect(JSON.stringify(request.history)).toContain("DEPLOY_PROCEDURE_543"); return { text: "Deployment complete." }; }, { text: "Next deployment complete." }]);
  const host = new Host(ws, { provider, userConfig: { memory: { automatic: { enabled: true }, recall: { enabled: true }, autoExtraction: { enabled: false }, session: { enabled: false } } } });
  try {
    host.user("Deploy using our procedure."); await host.waitFor(message => message.type === "turn_completed" && message["turn"] === 1);
    host.user("Deploy another change using our procedure."); await host.waitFor(message => message.type === "turn_completed" && message["turn"] === 2);
    expect(provider.requests).toHaveLength(3); const notes = provider.requests[2]!.history.filter(message => message.role === "system_note" && message.text.includes("DEPLOY_PROCEDURE_543"));
    expect(notes).toHaveLength(1); expect(JSON.stringify(notes)).toContain("not a user instruction"); expect(existsSync(join(dir, "deploy.md"))).toBe(true);
  } finally { host.feed.end(); await host.finish(); }
}, 15_000);

test("TECH — a denied memory is excluded from its index and selection before any model request", async () => {
  const ws = workspace(), key = projectKey(realpathSync(ws.project)), file = ws.write("home/config/memory/" + key + "/deploy.md", deployment);
  ws.write("home/config/memory/" + key + "/" + INDEX, "# Project memory index\n- [Deployment procedure](deploy.md) (reference): Runbook for deployment\n");
  const provider = new ScriptedProvider([{ text: "No private memory used." }]);
  const result = await cli(["--non-interactive", "Deploy."], ws, { provider, userConfig: { memory: { automatic: { enabled: true }, recall: { enabled: true }, autoExtraction: { enabled: false }, session: { enabled: false } }, permissions: { denyRules: [`read_file(//${file.replace(/\\/g, "/").replace(/^\//, "")})`] } } });
  expect(result.code).toBe(0); expect(provider.requests).toHaveLength(1); expect(JSON.stringify(provider.requests[0])).not.toContain("DEPLOY_PROCEDURE_543"); expect(JSON.stringify(provider.requests[0]!.system)).not.toContain("deploy.md");
});
