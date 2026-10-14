// Supports: SPEC-MCP-014/CA-01/02/03.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, ROOT, workspace } from "./helpers/env";
import { BUN } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive } from "./helpers/interactive";
const BODY = "REMOTE_SKILL_BODY_WITNESS_614: review the requested code using the associated guide. Resource: skill://revue/guide.md.\n";
function fixture() {
  const ws = workspace(), log = join(ws.root, "methods.log"), config = ws.write("server.json", JSON.stringify({ tools: [], logFile: log, resources: [{ uri: "skill://revue/definition.md", name: "review skill", text: "---\nname: revue\ndescription: Review a change using the connector guide.\ntools: [run_shell(*)]\n---\n" + BODY }, { uri: "skill://revue/guide.md", name: "review guide", text: "REMOTE_GUIDE_WITNESS_614" }] }));
  ws.write("home/config/connectors.json", JSON.stringify({ servers: { docs: { command: BUN, args: [join(ROOT, "tests/helpers/mcp-server.ts"), config] } } }));
  return { ws, log };
}
const settings = (allowed: string[]) => ({ mcp: { skillsFromServers: allowed }, skills: { discovery: { enabled: false } } });

test("SPEC-MCP-014/CA-01 — an allowlisted docs connector publishes its namespaced skill at startup", async () => {
  const { ws, log } = fixture(), provider = new ScriptedProvider([]);
  const result = await cli(["--non-interactive", "--wait-for-mcp", "/skill-list"], ws, { provider, userConfig: settings(["docs"]) });
  expect(result.code).toBe(0); expect(result.stdout).toContain("cnx_docs_revue"); expect(result.stdout.toLowerCase()).toContain("connecteur docs"); expect(result.stdout).not.toContain("REMOTE_SKILL_BODY_WITNESS_614");
  expect(provider.requests).toHaveLength(0); expect(readFileSync(log, "utf8")).toContain("resources/read");
});

test("SPEC-MCP-014/CA-02 — an unlisted connector never supplies skill headers or bodies", async () => {
  const { ws, log } = fixture(); const result = await cli(["--non-interactive", "--wait-for-mcp", "/skill-list"], ws, { provider: new ScriptedProvider([]), userConfig: settings([]) });
  expect(result.code).toBe(0); expect(result.stdout).not.toContain("cnx_docs_revue"); expect(readFileSync(log, "utf8")).not.toContain("resources/read");
});

test("SPEC-MCP-014/CA-03 — homonymous extension and connector skills are both listed without collision", async () => {
  const { ws } = fixture(), extension = join(ws.root, "ext/docs");
  ws.write("ext/docs/extension.json", JSON.stringify({ name: "docs", version: "1.0.0", description: "Local reference skills." }));
  ws.write("ext/docs/skills/revue/definition.md", "---\nname: revue\ndescription: Local review instructions.\n---\nLOCAL_REVIEW_WITNESS_614\n");
  const result = await cli(["--non-interactive", "--wait-for-mcp", "--extension-dir", extension, "/skill-list"], ws, { provider: new ScriptedProvider([]), userConfig: settings(["docs"]) });
  expect(result.code).toBe(0); expect(result.stdout).toContain("docs:revue"); expect(result.stdout).toContain("cnx_docs_revue");
});

test("TECH — a connector skill loads its full body only at invocation and cannot grant a denied action", async () => {
  const { ws } = fixture(), target = join(ws.project, "denied.txt");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "cnx_docs_revue" } }] }, request => {
    expect(JSON.stringify(request.history)).toContain("REMOTE_SKILL_BODY_WITNESS_614"); expect(JSON.stringify(request.history)).toContain("read_connector_resource");
    return { toolCalls: [{ name: "write_file", input: { path: target, content: "Denied write." } }] };
  }, { text: "The write was refused." }]);
  const deny = `write_file(//${target.replace(/\\/g, "/").replace(/^\//, "")})`;
  const result = await cli(["--non-interactive", "--wait-for-mcp", "--deny-rule", deny, "Review the change."], ws, { provider, userConfig: settings(["docs"]) });
  expect(result.code).toBe(0); expect(JSON.stringify(provider.requests[0]!.system)).not.toContain("REMOTE_SKILL_BODY_WITNESS_614");
  expect(JSON.stringify(provider.requests[2]!.history)).toContain("Denied by the rule");
});

test("TECH — removing a live resource restriction invalidates remote skill metadata without reconnecting", async () => {
  const { ws } = fixture(), controller = new AbortController();
  const provider = new ScriptedProvider([{ text: "First request complete." }, request => { expect(JSON.stringify(request.history)).toContain("cnx_docs_revue"); return { text: "Second request complete." }; }]);
  const run = interactive(["--wait-for-mcp"], ws, { provider, signal: controller.signal, userConfig: { ...settings(["docs"]), permissions: { denyRules: ["read_connector_resource(docs)"] } } });
  try {
    await run.idle(); run.type("First request.\r"); await run.waitFor(text => text.includes("First request complete."));
    expect(JSON.stringify(provider.requests[0])).not.toContain("cnx_docs_revue");
    const file = join(ws.configHome, "config.json"), config = JSON.parse(readFileSync(file, "utf8")); config.permissions.denyRules = []; writeFileSync(file, JSON.stringify(config));
    run.type("Second request.\r"); await run.waitFor(text => text.includes("Second request complete.")); expect(provider.requests).toHaveLength(2);
  } finally { controller.abort(); await run.done; }
}, 15_000);
