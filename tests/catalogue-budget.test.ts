import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { estimateTokens } from "../src/engine/system-instructions";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { BUN, productEnv, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, KEY, sleep } from "./helpers/interactive";

test("TECH — offline minimal refuses mandatory hook incompatibility before the provider or hook runs", async () => {
  const ws = workspace();
  const hook = record(ws, "offline-required");
  ws.write("managed/policy.json", JSON.stringify({ hooks: { before_tool: [{ id: "required", mandatory: true, actions: [{ type: "command", command: hook.command }] }] } }));
  const provider = new ScriptedProvider([]);
  const result = await cli(["--non-interactive", "Work."], ws, { provider, env: productEnv(ws, { [`${loadIdentity().get("ENV_PREFIX")}OFFLINE_MINIMAL`]: "1" }) });
  expect(result.code).toBe(2);
  expect(result.stderr).toContain("crochet obligatoire");
  expect(provider.requests).toHaveLength(0);
  expect(hook.read()).toHaveLength(0);
});

test("TECH — offline sessions refuse extension downloads and external editors before effects", async () => {
  const ws = workspace();
  const editor = record(ws, "offline-editor");
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() { requests++; return new Response("missing", { status: 404 }); } });
  const provider = new ScriptedProvider([]);
  const prefix = loadIdentity().get("ENV_PREFIX");
  const run = interactive([], ws, { provider, env: productEnv(ws, { [`${prefix}OFFLINE_MINIMAL`]: "1", EDITOR: editor.command }), userConfig: { extensions: { catalogs: { remote: { source: { git: `http://127.0.0.1:${server.port}/catalogue.git` } } } } } });
  try {
    await run.idle();
    for (const line of ["/extensions install example@remote", "/shortcuts edit"]) {
      run.type(line); run.type(KEY.enter);
      await run.waitFor((t) => t.includes("Opération indisponible en mode minimal hors ligne."));
      await sleep(150);
    }
    expect(requests).toBe(0);
    expect(editor.read()).toHaveLength(0);
    expect(provider.requests).toHaveLength(0);
    const result = await cli(["catalog", "add", `http://127.0.0.1:${server.port}/other.git`], ws, { env: productEnv(ws, { [`${prefix}OFFLINE_MINIMAL`]: "1" }) });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("hors ligne");
    expect(requests).toBe(0);
    const tricky = await cli(["catalog", "add", `http://127.0.0.1:${server.port}/other.git`, "--", "--help"], ws, { env: productEnv(ws, { [`${prefix}OFFLINE_MINIMAL`]: "1" }) });
    expect(tricky.code).toBe(2);
    expect(tricky.stderr).toContain("hors ligne");
    expect(requests).toBe(0);
    expect((await cli(["catalog"], ws, { env: productEnv(ws, { [`${prefix}OFFLINE_MINIMAL`]: "1" }) })).code).toBe(0);
    run.type(KEY.ctrlD); run.type(KEY.ctrlD);
    expect((await run.done).code).toBe(0);
  } finally { server.stop(true); }
});

test("TECH — offline minimal refuses a remote connection before opening its transport", async () => {
  const ws = workspace();
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() { requests++; return new Response("no"); } });
  try {
    const prefix = loadIdentity().get("ENV_PREFIX");
    const result = await cli(["--non-interactive", "--control-connect", `ws://127.0.0.1:${server.port}`, "Work."], ws, { env: productEnv(ws, { [`${prefix}OFFLINE_MINIMAL`]: "1", [`${prefix}CONTROL_TOKEN`]: "fake-local-fixture-token" }), provider: new ScriptedProvider([]) });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("hors ligne");
    expect(requests).toBe(0);
  } finally { server.stop(true); }
});

test("SPEC-OUT-037/CA-01 — 500 installed skills fit the listing budget and an omitted skill remains callable", async () => {
  const ws = workspace();
  for (let i = 0; i < 500; i++) ws.write(`home/config/skills/skill-${String(i).padStart(3, "0")}/definition.md`, `---\ndescription: ${JSON.stringify("Detailed skill instructions. ".repeat(20))}\n---\nSKILL BODY ${i}\n`);
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "skill-499" } }] }, { text: "Finished." }]);
  const result = await cli(["--non-interactive", "Work."], ws, { provider });
  expect(result.code).toBe(0);
  const listing = provider.requests[0]?.system.find((block) => block.text.startsWith("# Skills"));
  expect(listing).toBeDefined();
  expect(estimateTokens(listing!.text)).toBeLessThanOrEqual(Math.floor(provider.requests[0]!.model.contextWindow * 0.01));
  expect(listing!.text).not.toContain("SKILL BODY");
  expect(JSON.stringify(provider.requests[1]?.history)).toContain("SKILL BODY 499");
});

test("SPEC-CFG-007/CA-04 — OFFLINE_MINIMAL excludes optional hooks and connector processes while the configured provider runs", async () => {
  const ws = workspace();
  const opened = record(ws, "offline-opened");
  const marker = join(ws.root, "connector-started");
  const server = ws.write("connector.ts", `await Bun.write(${JSON.stringify(marker)}, "started"); process.exit(0);`);
  writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers: { optional: { transport: "stdio", command: BUN, args: [server] } } }));
  const provider = new ScriptedProvider([{ text: "Local provider answer." }]);
  const result = await cli(["--non-interactive", "--wait-for-mcp", "Work."], ws, { provider, env: productEnv(ws, { [`${loadIdentity().get("ENV_PREFIX")}OFFLINE_MINIMAL`]: "1" }), userConfig: { hooks: { session_opened: [{ actions: [{ type: "command", command: opened.command }] }] } } });
  expect(result.code).toBe(0);
  expect(provider.requests).toHaveLength(1);
  expect(opened.read()).toHaveLength(0);
  expect(existsSync(marker)).toBe(false);
  const tools = provider.requests[0]!.tools.map((t) => t.name);
  for (const name of ["fetch_url", "run_shell", "run_powershell", "monitor_process"]) expect(tools).not.toContain(name);
});
