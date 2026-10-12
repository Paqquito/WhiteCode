// Connectors (SPEC-MCP-001, 002, 009, 020, 021, 022), approval of project connectors (SPEC-PER-019) and deferred
// tools (SPEC-OUT-030), with a simulated MCP server run by Bun.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectStateKey } from "../src/connectors/session";
import { qualifiedToolName } from "../src/connectors/tools";
import { processExists } from "../src/platform/process";
import { currentPlatform, realPathOrSelf } from "../src/platform/system";
import { fingerprint } from "../src/shared/fingerprint";
import { searchDeferred } from "../src/tools/discover-tools";
import { cli, workspace, type Workspace } from "./helpers/env";
import { BUN, productEnv, PROJECT_DIR, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { httpConnectorServer } from "./helpers/fake-mcp-http";

const SERVER = join(import.meta.dir, "helpers", "mcp-server.ts").replace(/\\/g, "/");
const platform = currentPlatform();

/** A stdio declaration of the simulated server with `config`. */
function fake(ws: Workspace, file: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const path = join(ws.root, `${file}.json`).replace(/\\/g, "/");
  writeFileSync(path, JSON.stringify(config));
  return { transport: "stdio", command: BUN, args: [SERVER, path], ...extra };
}
const tools = (...names: string[]) => names.map((name) => ({ name }));
const userConnectors = (ws: Workspace, servers: Record<string, unknown>) => writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers }));
const toolNames = (p: ScriptedProvider, i: number) => (p.requests[i]?.tools ?? []).map((t) => t.name);
const history = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history ?? []);
const results = (p: ScriptedProvider, i: number): string[] =>
  (p.requests[i]?.history ?? []).flatMap((m) => (m.role === "user" ? m.parts.filter((x) => x.type === "tool_result").map((x) => JSON.stringify(x)) : []));
const allow = { permissions: { allowRules: ["cnx_docs"] } };
const run = (ws: Workspace, provider: ScriptedProvider, userConfig: Record<string, unknown> = {}, args: string[] = [], env: Record<string, string> = {}) =>
  cli(["--non-interactive", "--wait-for-mcp", ...args, "x"], ws, { provider, userConfig, env: productEnv(ws, env) });

describe("SPEC-MCP-001 configuration of the connectors", () => {
  test("SPEC-MCP-001/CA-01 — the example file in the project scope, approved: both connectors are configured", async () => {
    const ws = workspace();
    const docs = fake(ws, "docs", { tools: tools("search") });
    const tickets = httpConnectorServer();
    try {
    ws.write(
      `project/${PROJECT_DIR}/connectors.json`,
      JSON.stringify({
        servers: {
          docs: { ...docs, args: [...docs.args, "--root", "${PROJECT_ROOT}"], env: { TOKEN: "${DOCS_TOKEN}" } },
          tickets: { transport: "http", url: tickets.url, headers: { "X-Team": "core" } },
        },
      }),
    );
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p, { mcp: { enabledProjectServers: ["docs", "tickets"] } }, ["--allow-project-trust"], { DOCS_TOKEN: "t" });
    expect(toolNames(p, 0)).toContain("cnx_docs_search");
    expect(toolNames(p, 0)).toContain("cnx_tickets_lookup");
    expect(res.code).toBe(0);
    expect(tickets.requests.every((r) => r.headers.get("X-Team") === "core")).toBe(true);
    } finally { tickets.stop(); }
  });

  test("SPEC-MCP-001/CA-02 — docs defined in the user and local scopes: the local definition is used", async () => {
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "user-docs", { tools: tools("from_user") }) });
    const key = projectStateKey(realPathOrSelf(ws.project), platform);
    writeFileSync(join(ws.configHome, "state.json"), JSON.stringify({ trustedProjects: [ws.project], projects: { [key]: { connectors: { servers: { docs: fake(ws, "local-docs", { tools: tools("from_local") }) } } } } }));
    const p = new ScriptedProvider([{ text: "done" }]);
    await run(ws, p);
    expect(toolNames(p, 0)).toContain("cnx_docs_from_local");
    expect(toolNames(p, 0)).not.toContain("cnx_docs_from_user");
  });

  test("SPEC-MCP-001/CA-03 — ${DOCS_TOKEN} not defined: only docs is in configuration error", async () => {
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("search") }, { env: { TOKEN: "${DOCS_TOKEN}" } }), wiki: fake(ws, "wiki", { tools: tools("page") }) });
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p);
    expect(res.stderr).toContain("connecteur docs : erreur de configuration : variable DOCS_TOKEN non définie");
    expect(toolNames(p, 0)).toContain("cnx_wiki_page");
    expect(toolNames(p, 0)).not.toContain("cnx_docs_search");
  });

  test("SPEC-MCP-001/CA-04 — --connectors-only --connectors a.json: only the connectors of a.json and the managed ones", async () => {
    const ws = workspace();
    userConnectors(ws, { user: fake(ws, "user", { tools: tools("u") }) });
    writeFileSync(join(ws.managed, "policy-connectors.json"), JSON.stringify({ servers: { corp: fake(ws, "corp", { tools: tools("c") }) } }));
    const a = ws.write("a.json", JSON.stringify({ servers: { alpha: fake(ws, "alpha", { tools: tools("a") }) } }));
    const p = new ScriptedProvider([{ text: "done" }]);
    await run(ws, p, {}, ["--connectors-only", "--connectors", a]);
    const names = toolNames(p, 0).filter((n) => n.startsWith("cnx_"));
    expect(names).toEqual(["cnx_alpha_a", "cnx_corp_c"]);
  });

  test("TECH — SPEC-MCP-001/ERR-01 to ERR-03, EF-04 — invalid JSON, unknown transport, invalid name with a proposal", async () => {
    const ws = workspace();
    userConnectors(ws, { Docs_Server: fake(ws, "x", { tools: [] }), smoke: { transport: "pigeon", url: "x" } });
    const bad = ws.write("bad.json", "{ servers: ");
    const res = await run(ws, new ScriptedProvider([{ text: "done" }]), {}, ["--connectors", bad]);
    expect(res.stderr).toContain("Nom de connecteur invalide : Docs_Server");
    expect(res.stderr).toContain("nom proposé : docs-server");
    expect(res.stderr).toContain("Transport inconnu pour smoke");
    expect(res.stderr).toContain(`Configuration des connecteurs invalide dans ${bad}`);
  });
});

describe("SPEC-MCP-002 stdio transport", () => {
  test("SPEC-MCP-002/CA-01 — SPEC-MCP-009/CA-01 — SPEC-MCP-009/CA-02 — SPEC-OUT-027/CA-01 — SPEC-OUT-027/CA-02 — a valid stdio server publishing search: cnx_docs_search exists; an allow rule on cnx_docs: allowed without request", async () => {
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("search") }) });
    const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_docs_search", input: { q: "hooks" } }] }, { text: "done" }]);
    await run(ws, p, allow, ["--approval-mode", "ask"]);
    expect(toolNames(p, 0)).toContain("cnx_docs_search");
    expect(results(p, 1).join("")).toContain('called search with {\\"q\\":\\"hooks\\"}');
    const def = p.requests[0]!.tools.find((t) => t.name === "cnx_docs_search")!;
    expect(def.description).toContain("external source"); // EF-04
  });

  test("SPEC-HOK-002/CA-02 — a hook with match cnx_docs_*: it runs when a tool of the docs connector is called", async () => {
    const ws = workspace();
    const r = record(ws, "connector-hook");
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("search") }) });
    const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_docs_search", input: { q: "a" } }] }, { text: "done" }]);
    await run(ws, p, { ...allow, hooks: { before_tool: [{ match: "cnx_docs_*", actions: [{ type: "command", command: r.command }] }] } });
    expect(r.read().map((x) => x.toolId)).toEqual(["cnx_docs_search"]);
  });

  test("SPEC-MCP-002/CA-02 — the session ends: the server process no longer exists", async () => {
    const ws = workspace();
    const pidFile = join(ws.root, "pids.txt");
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("search"), pidFile }) });
    await run(ws, new ScriptedProvider([{ text: "done" }]));
    const pids = readFileSync(pidFile, "utf8").trim().split("\n").map(Number);
    expect(pids).toHaveLength(1);
    expect(processExists(pids[0]!)).toBe(false);
  });

  test("SPEC-MCP-002/CA-03 — a server that crashes: the connector goes in error and the last error lines are visible", async () => {
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("search"), stderrLines: ["starting docs"], crashAfterCalls: 0 }) });
    const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_docs_search", input: {} }] }, { text: "done" }]);
    const r = await run(ws, p, { ...allow, mcp: { maxReconnects: 0 } });
    expect(r.stderr).toContain("connecteur docs : connexion perdue");
    expect(r.stderr).toContain("fatal: simulated crash");
    expect(r.stderr).toContain("Connecteur docs indisponible : reconnexion depuis /connectors.");
    expect(results(p, 1).join("")).toContain('"isError":true');
  });
});

describe("SPEC-MCP-009 connector tools", () => {
  test("SPEC-MCP-009/CA-03 — a tool annotated read-only, mode ask without rule: a permission request is still made", async () => {
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "docs", { tools: [{ name: "lookup", annotations: { readOnlyHint: true } }] }) });
    const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_docs_lookup", input: {} }] }, { text: "done" }]);
    await run(ws, p, {}, ["--approval-mode", "ask"]);
    expect(results(p, 1).join("")).toContain("This action requires a permission");
  });

  test("SPEC-MCP-009/CA-04 — SPEC-OUT-030/CA-01 — SPEC-OUT-030/CA-02 — SPEC-OUT-030/CA-03 — 100 connector tools: deferred, announced by name, loaded by discover_tools; a deferred tool not loaded asks to be loaded", async () => {
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "docs", { tools: Array.from({ length: 100 }, (_, i) => ({ name: `tool${i}` })) }) });
    const p = new ScriptedProvider([
      { toolCalls: [{ name: "cnx_docs_tool7", input: {} }] },
      { toolCalls: [{ name: "discover_tools", input: { query: "select:cnx_docs_tool7,cnx_docs_tool8,nope" } }] },
      { toolCalls: [{ name: "cnx_docs_tool7", input: { q: "x" } }] },
      { text: "done" },
    ]);
    await run(ws, p, allow);
    expect(toolNames(p, 0).filter((n) => n.startsWith("cnx_"))).toEqual([]);
    expect(toolNames(p, 0)).toContain("discover_tools");
    expect(history(p, 0)).toContain("Deferred tools, known by name only");
    expect(history(p, 0)).toContain("cnx_docs_tool99");
    expect(results(p, 1).join("")).toContain("is deferred and not loaded: load it first with discover_tools");
    const loaded = results(p, 2).join("");
    expect(loaded).toContain('<tool name=\\"cnx_docs_tool7\\">');
    expect(loaded).toContain("Unknown tool: nope.");
    expect(toolNames(p, 2)).toEqual([...toolNames(p, 1), "cnx_docs_tool7", "cnx_docs_tool8"]);
    expect(results(p, 3).join("")).toContain("called tool7");
  });

  test("SPEC-MCP-009/CA-05 — a server that adds a tool during the session: the tool becomes available and the model is told", async () => {
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("search"), addToolAfterMs: { ms: 300, tool: { name: "late" } } }) });
    const p = new ScriptedProvider([{ delayMs: 1_500, toolCalls: [{ name: "cnx_docs_search", input: {} }] }, { toolCalls: [{ name: "cnx_docs_late", input: {} }] }, { text: "done" }]);
    await run(ws, p, allow);
    expect(toolNames(p, 0)).not.toContain("cnx_docs_late");
    expect(toolNames(p, 1)).toContain("cnx_docs_late");
    expect(history(p, 1)).toContain("The tools of the connector docs changed. New: cnx_docs_late.");
    expect(results(p, 2).join("")).toContain("called late");
  });

  test("TECH — SPEC-MCP-009/EF-06, ERR-02, ERR-03, RG-01 — qualified names: normalised, bounded to 64 with a stable fingerprint; an invalid schema is not exposed", async () => {
    expect(qualifiedToolName("docs", "get.page", new Set())).toBe("cnx_docs_get_page");
    const long = qualifiedToolName("docs", "a".repeat(80), new Set());
    expect(long.length).toBe(64);
    expect(long).toBe(qualifiedToolName("docs", "a".repeat(80), new Set()));
    expect(qualifiedToolName("docs", "get page", new Set(["cnx_docs_get_page"]))).toMatch(/^cnx_docs_get_page_[0-9a-f]{8}$/);
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "docs", { tools: [{ name: "ok" }, { name: "broken", inputSchema: { type: "string" } }] }) });
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p);
    expect(toolNames(p, 0)).toContain("cnx_docs_ok");
    expect(toolNames(p, 0)).not.toContain("cnx_docs_broken");
    expect(res.stderr).toContain("outil broken du connecteur docs non exposé");
    expect(searchDeferred([{ name: "cnx_t_search_issues", description: "Search the issues" }, { name: "cnx_t_create", description: "Create an issue" }], "+create issue", 5).names).toEqual(["cnx_t_create"]);
  });
});

describe("SPEC-MCP-020 large outputs", () => {
  test("SPEC-MCP-020/CA-01 — SPEC-OUT-027/CA-03 — a JSON result of 5 MB: the model receives a structured preview and a path", async () => {
    const ws = workspace();
    const rows = Array.from({ length: 50_000 }, (_, i) => ({ id: i, title: `Item ${i} of the big list`, tags: ["a", "b"], body: "x".repeat(60) }));
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("dump"), responses: { dump: { json: { total: rows.length, rows } } } }) });
    const p = new ScriptedProvider([{ toolCalls: [{ name: "cnx_docs_dump", input: {} }] }, { text: "done" }]);
    await run(ws, p, allow);
    const text = JSON.parse(results(p, 1)[0]!).content[0].text as string;
    expect(text).toContain("The result is large");
    expect(text).toContain("rows: array (50000 items) of object");
    const path = /saved to (.+?)\. Read/.exec(text)![1]!;
    expect(JSON.parse(readFileSync(path, "utf8")).rows).toHaveLength(50_000); // EF-01: the whole content, readable
    expect(text.length).toBeLessThan(20_000);
  }, 60_000);

  test("SPEC-MCP-020/CA-02 — a connector beyond the threshold 4 times: the user is warned", async () => {
    const ws = workspace();
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("big"), responses: { big: { text: "word ", repeat: 400 } } }, { maxOutputTokens: 100 }) });
    const call = { toolCalls: [{ name: "cnx_docs_big", input: {} }] };
    const res = await run(ws, new ScriptedProvider([call, call, call, call, { text: "done" }]), allow);
    expect(res.stderr).toContain("le connecteur docs a dépassé plus de 3 fois le seuil des sorties volumineuses");
  });
});

describe("SPEC-MCP-021 allow and deny lists", () => {
  test("SPEC-MCP-021/CA-01 — mcp.denyList with the URL https://*.example.com/*: a connector to https://mcp.example.com/x is blocked", async () => {
    const ws = workspace();
    writeFileSync(join(ws.managed, "policy.json"), JSON.stringify({ mcp: { denyList: [{ url: "https://*.example.com/*" }] } }));
    userConnectors(ws, { remote: { transport: "http", url: "https://mcp.example.com/x" } });
    const res = await run(ws, new ScriptedProvider([{ text: "done" }]));
    expect(res.stderr).toContain("connecteur remote (portée user) non démarré : Connecteur bloqué par votre organisation (mcp.denyList).");
  });

  test("SPEC-MCP-021/CA-02 — mcp.managedServersOnly: a user connector is blocked", async () => {
    const ws = workspace();
    writeFileSync(join(ws.managed, "policy.json"), JSON.stringify({ mcp: { managedServersOnly: true } }));
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("search") }) });
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p);
    expect(res.stderr).toContain("seuls les connecteurs gérés sont admis");
    expect(toolNames(p, 0)).not.toContain("cnx_docs_search");
  });
});

describe("SPEC-MCP-022 connections", () => {
  test("SPEC-MCP-022/CA-01 — a connector slow to connect: the session starts at once and its tools appear once connected", async () => {
    const ws = workspace();
    userConnectors(ws, { slow: fake(ws, "slow", { tools: tools("x"), initDelayMs: 1_500 }) });
    const a = ws.write("project/a.txt", "a\n");
    const p = new ScriptedProvider([{ delayMs: 3_000, toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    const res = await cli(["--non-interactive", "x"], ws, { provider: p, userConfig: {}, env: productEnv(ws) });
    expect(res.code).toBe(0);
    expect(toolNames(p, 0)).not.toContain("cnx_slow_x");
    expect(toolNames(p, 1)).toContain("cnx_slow_x");
    expect(history(p, 1)).toContain("The connector slow is connected.");
  });

  test("SPEC-MCP-022/CA-02 — a connector that restarts: it is reconnected automatically", async () => {
    const ws = workspace();
    const marker = join(ws.root, "crashed").replace(/\\/g, "/");
    const pidFile = join(ws.root, "pids.txt");
    userConnectors(ws, { docs: fake(ws, "docs", { tools: tools("search"), crashAfterCalls: 1, crashMarker: marker, pidFile }) });
    const call = (delayMs = 0) => ({ delayMs, toolCalls: [{ name: "cnx_docs_search", input: {} }] });
    const p = new ScriptedProvider([call(), call(), call(2_500), { text: "done" }]);
    const res = await run(ws, p, allow);
    expect(results(p, 1).join("")).toContain("called search");
    expect(results(p, 2).join("")).toContain('"isError":true');
    expect(results(p, 3).join("")).toContain("called search");
    expect(res.stderr).toContain("connexion perdue");
    expect(readFileSync(pidFile, "utf8").trim().split("\n")).toHaveLength(2);
  }, 30_000);
});

describe("SPEC-PER-019 approval of the project connectors", () => {
  const projectDocs = (ws: Workspace) => {
    const docs = fake(ws, "docs", { tools: tools("search") });
    ws.write(`project/${PROJECT_DIR}/connectors.json`, JSON.stringify({ servers: { docs } }));
    return docs;
  };
  const approve = (ws: Workspace, declaration: unknown) => {
    const key = projectStateKey(realPathOrSelf(ws.project), platform);
    writeFileSync(join(ws.configHome, "state.json"), JSON.stringify({ projects: { [key]: { connectorChoices: { docs: { decision: "approved", fingerprint: fingerprint({ name: "docs", declaration }) } } } } }));
  };

  test("SPEC-PER-019/CA-01 — a new project connector: it starts only after approval", async () => {
    const ws = workspace();
    const docs = projectDocs(ws);
    const before = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, before, {}, ["--allow-project-trust"]);
    expect(res.stderr).toContain("connecteur docs (portée project) non démarré : connecteur de projet non approuvé");
    expect(toolNames(before, 0)).not.toContain("cnx_docs_search");
    approve(ws, docs);
    const after = new ScriptedProvider([{ text: "done" }]);
    await run(ws, after, {}, ["--allow-project-trust"]);
    expect(toolNames(after, 0)).toContain("cnx_docs_search");
  });

  test("SPEC-PER-019/CA-02 — a connector command changed: a new approval is required at the next session", async () => {
    const ws = workspace();
    const docs = projectDocs(ws);
    approve(ws, { ...docs, args: [...docs.args, "--old"] });
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p, {}, ["--allow-project-trust"]);
    expect(res.stderr).toContain("connecteur de projet modifié depuis son approbation : nouvelle approbation requise");
    expect(toolNames(p, 0)).not.toContain("cnx_docs_search");
  });
});
