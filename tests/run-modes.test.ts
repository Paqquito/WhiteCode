// Structured output (SPEC-MOD-004), minimal mode (SPEC-MOD-009), start-up phases and deferred maintenance
// (SPEC-MOD-010), and the remaining criteria of the options (SPEC-MOD-011) and of the subcommands (SPEC-MOD-012).
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectKey } from "../src/session/transcript";
import { cli, loadIdentity, TEST_USER_CONFIG, workspace, type Workspace } from "./helpers/env";
import { BUN, productEnv, PROJECT_DIR } from "./helpers/hooks";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { StdioConnection } from "../src/connectors/stdio-client";
import { ConnectorManager } from "../src/connectors/manager";
import { currentPlatform } from "../src/platform/system";
import type { ModelEvent, ModelRequest } from "../src/providers/types";

const SERVER = join(import.meta.dir, "helpers", "mcp-server.ts").replace(/\\/g, "/");
const run = (ws: Workspace, provider: ScriptedProvider, args: string[], userConfig: Record<string, unknown> = {}, signal?: AbortSignal) =>
  cli(["--non-interactive", ...args], ws, { provider, userConfig, env: productEnv(ws), signal });
const SCHEMA = JSON.stringify({ type: "object", properties: { name: { type: "string" }, count: { type: "integer" } }, required: ["name", "count"], additionalProperties: false });
const system = (p: ScriptedProvider, i = 0) => JSON.stringify(p.requests[i]?.system ?? []);
const lastUser = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history.filter((m) => m.role === "user").pop() ?? null);
/** A connector of the simulated server; `pidFile` receives the pid of each start. */
function fakeConnector(ws: Workspace, name: string, config: Record<string, unknown>) {
  const path = join(ws.root, `${name}.json`).replace(/\\/g, "/");
  writeFileSync(path, JSON.stringify({ tools: [{ name: "lookup" }], ...config }));
  return { transport: "stdio", command: BUN, args: [SERVER, path] };
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("SPEC-MOD-004 structured output", () => {
  test("SPEC-MOD-004/CA-01 — a valid schema with two required fields: the result holds them and nothing else", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: '{"name": "revue", "count": 3}' }]);
    const r = await run(ws, p, ["--output-schema", SCHEMA, "--result-format", "json", "compte"]);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.structuredResult).toEqual({ name: "revue", count: 3 });
    expect(doc.structuredOutput).toEqual({ conforming: true, attempts: 1 });
    expect(system(p)).toContain("<output-schema>");
    const text = await run(ws, new ScriptedProvider([{ text: '{"name": "a", "count": 1}' }]), ["--output-schema", SCHEMA, "x"]);
    expect(JSON.parse(text.stdout)).toEqual({ name: "a", count: 1 });
  });

  test("SPEC-MOD-004/CA-02 — an invalid schema stops the run before any call to the model", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([]);
    const r = await run(ws, p, ["--output-schema", '{"type": "strng"}', "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Schéma de sortie invalide");
    expect(p.requests.length).toBe(0);
    const missing = await run(ws, p, ["--output-schema", "absent.json", "x"]);
    expect(missing.stderr).toContain("fichier introuvable");
  });

  test("SPEC-MOD-004/CA-03 — a first result that does not conform: an extra turn, and the final result conforms", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: '{"name": "revue"}' }, { text: '{"name": "revue", "count": 2}' }]);
    const r = await run(ws, p, ["--output-schema", SCHEMA, "--result-format", "json", "x"]);
    expect(r.code).toBe(0);
    expect(lastUser(p, 1)).toContain("does not conform to the required JSON Schema");
    expect(lastUser(p, 1)).toContain("count");
    expect(JSON.parse(r.stdout).structuredOutput.attempts).toBe(2);
  });

  test("SPEC-MOD-004/CA-04 — two corrections without conformity: the run fails and the errors are given", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "pas de json" }, { text: '{"name": 1}' }, { text: '{"count": "x"}' }]);
    const r = await run(ws, p, ["--output-schema", SCHEMA, "x"]);
    expect(r.code).toBe(1);
    expect(p.requests.length).toBe(3);
    expect(r.stderr).toContain("Le résultat ne respecte pas le schéma après 3 tentatives.");
    expect(r.stderr).toContain("missing required field");
    expect(r.stdout).toBe("");
  });

  test("SPEC-MOD-004/CA-05 — with the jsonl output, the closing event carries the structured result in its field", async () => {
    const ws = workspace();
    const r = await run(ws, new ScriptedProvider([{ text: '{"name": "z", "count": 9}' }]), ["--output-schema", SCHEMA, "--result-format", "jsonl", "x"]);
    const last = JSON.parse(r.stdout.trim().split("\n").pop()!);
    expect(last.structuredResult).toEqual({ name: "z", count: 9 });
  });

  test("SPEC-MOD-004/CA-06 — an answer with text then a conforming block: the block is kept, the text goes to the metadata", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: 'Voici le résultat :\n```json\n{"name": "n", "count": 4}\n```\nBonne journée.' }]);
    const r = await run(ws, p, ["--output-schema", SCHEMA, "--result-format", "json", "x"]);
    const doc = JSON.parse(r.stdout);
    expect(doc.structuredResult).toEqual({ name: "n", count: 4 });
    expect(doc.structuredOutput.surroundingText).toContain("Voici le résultat");
    expect(doc.structuredOutput.surroundingText).toContain("Bonne journée.");
    // Strict extraction: no text around the document is tolerated.
    const strict = await run(ws, new ScriptedProvider([{ text: 'Voici : {"name": "n", "count": 4}' }, { text: "x" }, { text: "y" }]), ["--output-schema", SCHEMA, "x"], { engine: { output: { schemaStrictExtraction: true } } });
    expect(strict.code).toBe(1);
  });
});

describe("SPEC-MOD-009 minimal mode", () => {
  const prepare = (ws: Workspace) => {
    const instructions = loadIdentity().get("INSTRUCTIONS_FILE");
    ws.write(`project/${instructions}`, "CONSIGNE-DU-PROJET-77");
    ws.write(`project/${PROJECT_DIR}/commands/revue.md`, "---\ndescription: Revue.\n---\nREVUE\n");
    ws.write("home/config/skills/outil/definition.md", '---\ndescription: "Une compétence."\n---\nbody\n');
    ws.write("ext/demo/extension.json", JSON.stringify({ name: "demo", version: "1.0.0", description: "Demo." }));
    ws.write("ext/demo/skills/aide/definition.md", '---\ndescription: "Compétence d\'extension."\n---\nbody\n');
    const pidFile = join(ws.root, "pids.txt");
    writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers: { docs: fakeConnector(ws, "docs", { pidFile }) } }));
    return { pidFile, ext: join(ws.root, "ext", "demo") };
  };

  test("SPEC-MOD-009/CA-01 — SPEC-MOD-009/CA-04 — instructions, extensions and connectors are not loaded, a message says so; the automated mode applies too", async () => {
    const ws = workspace();
    const { pidFile, ext } = prepare(ws);
    const p = new ScriptedProvider([{ text: "ok" }]);
    const r = await run(ws, p, ["--minimal", "--allow-project-trust", "--wait-for-mcp", "--extension-dir", ext, "--result-format", "json", "x"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).result).toBe("ok");
    expect(r.stderr).toContain("Session minimale :");
    expect(system(p)).not.toContain("CONSIGNE-DU-PROJET-77");
    expect(system(p)).not.toContain("Une compétence.");
    expect(system(p)).not.toContain("Compétence d'extension.");
    expect((p.requests[0]?.tools ?? []).map((t) => t.name).some((n) => n.startsWith("cnx_"))).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
    // Without the option, the same project loads them.
    const q = new ScriptedProvider([{ text: "ok" }]);
    await run(ws, q, ["--allow-project-trust", "--extension-dir", ext, "x"]);
    expect(system(q)).toContain("CONSIGNE-DU-PROJET-77");
  }, 30_000);

  test("SPEC-MOD-009/CA-02 — the managed permission rules still apply", async () => {
    const ws = workspace();
    ws.write("project/a.txt", "secret");
    ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["read_file"] } }));
    const path = join(realpathSync(ws.project), "a.txt");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { text: "fin" }]);
    await run(ws, p, ["--minimal", "--approval-mode", "unrestricted", "--allow-unrestricted-mode", "x"]);
    const results = JSON.stringify(p.requests[1]?.history ?? []);
    expect(results).not.toContain("secret");
  });

  test("SPEC-MOD-009/CA-03 — a custom command of the project is unknown in a minimal session", async () => {
    const ws = workspace();
    prepare(ws);
    const p = new ScriptedProvider([]);
    const r = await run(ws, p, ["--minimal", "--allow-project-trust", "/revue"]);
    expect(r.stderr).toContain("Commande inconnue : /revue.");
    expect(p.requests.length).toBe(0);
  });

  test("SPEC-MOD-009/CA-05 — a connector marked indispensable by the managed configuration: the minimal launch fails", async () => {
    const ws = workspace();
    writeFileSync(join(ws.managed, "policy-connectors.json"), JSON.stringify({ servers: { audit: { ...fakeConnector(ws, "audit", {}), required: true } } }));
    const p = new ScriptedProvider([]);
    const r = await run(ws, p, ["--minimal", "x"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Le mode minimal est incompatible avec la configuration en vigueur");
    expect(p.requests.length).toBe(0);
  });

  test("SPEC-MOD-009/CA-06 — a minimal session reopened without the option goes on as an ordinary session", async () => {
    const ws = workspace();
    prepare(ws);
    const first = new ScriptedProvider([{ text: "ok" }]);
    await run(ws, first, ["--minimal", "--allow-project-trust", "x"]);
    const again = new ScriptedProvider([{ text: "ok" }]);
    await run(ws, again, ["--reopen-last", "--allow-project-trust", "suite"]);
    expect(system(again)).toContain("CONSIGNE-DU-PROJET-77");
  });
});

describe("SPEC-MOD-010 start-up and deferred maintenance", () => {
  test("TECH — reconnect during initialization coalesces attempts and shutdown stops every server", async () => {
    const ws = workspace(), pidFile = join(ws.root, "overlap-pids.txt");
    const manager = new ConnectorManager({ connectors: [{ name: "waiting", scope: "user", source: "test", ...fakeConnector(ws, "waiting", { initDelayMs: 200, pidFile }), env: {}, headers: {}, fingerprint: "test" }], projectRoot: ws.project, platform: currentPlatform(), environment: () => productEnv(ws), variables: {}, connectTimeoutMs: 5_000, toolTimeoutMs: 1_000, maxParallel: 1, maxReconnects: 0, descriptionMax: 2_000, outputInlineLimit: 4_000, clientInfo: { name: "tests", version: "0.0.0" }, estimateTokens: (text) => text.length, store: () => "", report: () => {}, changed: () => {} });
    try {
      manager.start();
      await Promise.all([manager.reconnect("waiting"), manager.reconnect("waiting")]);
      await manager.close();
      const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids).toHaveLength(1);
      for (const pid of pids) expect(alive(pid)).toBe(false);
    } finally {
      await manager.close();
      if (existsSync(pidFile)) for (const pid of readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number)) if (alive(pid)) process.kill(pid);
    }
  }, 15_000);

  test("TECH — session shutdown returns only after an initializing connector and its delayed teardown have ended", async () => {
    const ws = workspace(), pidFile = join(ws.root, "initializing-pids.txt");
    writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers: { waiting: fakeConnector(ws, "waiting", { initDelayMs: "never", pidFile }) } }));
    class ReadyProvider extends ScriptedProvider {
      override async *stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelEvent> {
        const deadline = Date.now() + 5_000;
        while (!existsSync(pidFile) && Date.now() < deadline && !signal.aborted) await Bun.sleep(20);
        expect(existsSync(pidFile)).toBe(true);
        yield* super.stream(request, signal);
      }
    }
    const original = StdioConnection.prototype.close;
    StdioConnection.prototype.close = async function(this: StdioConnection, graceMs?: number) { await Bun.sleep(300); await original.call(this, graceMs); };
    try {
      const result = await run(ws, new ReadyProvider([{ text: "done" }]), ["x"], { mcp: { connectTimeout: "60s", maxReconnects: 0 } });
      expect(result.code).toBe(0);
      for (const pid of readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number)) expect(alive(pid)).toBe(false);
    } finally { StdioConnection.prototype.close = original; await Bun.sleep(1_000); }
  }, 15_000);

  test("TECH — reconnect supersedes a queued initialization without leaving an older server alive", async () => {
    const ws = workspace(), pidFile = join(ws.root, "queued-pids.txt");
    const connectors = ["first", "queued"].map((name) => ({ name, scope: "user" as const, source: "test", ...fakeConnector(ws, name, { initDelayMs: name === "first" ? 800 : 0, pidFile }), env: {}, headers: {}, fingerprint: "test" }));
    const manager = new ConnectorManager({ connectors, projectRoot: ws.project, platform: currentPlatform(), environment: () => productEnv(ws), variables: {}, connectTimeoutMs: 5_000, toolTimeoutMs: 1_000, maxParallel: 1, maxReconnects: 0, descriptionMax: 2_000, outputInlineLimit: 4_000, clientInfo: { name: "tests", version: "0.0.0" }, estimateTokens: (text) => text.length, store: () => "", report: () => {}, changed: () => {} });
    try {
      manager.start();
      await manager.reconnect("queued");
      await manager.waitAll(5_000);
      await manager.close();
      const pids = readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number);
      expect(pids).toHaveLength(2);
      for (const pid of pids) expect(alive(pid)).toBe(false);
    } finally {
      await manager.close();
      if (existsSync(pidFile)) for (const pid of readFileSync(pidFile, "utf8").trim().split(/\s+/).map(Number)) if (alive(pid)) process.kill(pid);
    }
  }, 15_000);

  test("SPEC-MOD-010/CA-01 — a connector that does not answer: the session starts without it, with a warning", async () => {
    const ws = workspace();
    writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers: { lent: fakeConnector(ws, "lent", { initDelayMs: "never" }) } }));
    // The answer takes longer than the connection limit, so that the failure of the connector comes during the session.
    const p = new ScriptedProvider([{ text: "réponse", delayMs: 6000 }]);
    const r = await run(ws, p, ["--result-format", "json", "x"], { mcp: { connectTimeout: "1s", maxReconnects: 0 } });
    expect(r.code).toBe(0);
    expect(p.requests.length).toBe(1);
    expect((p.requests[0]?.tools ?? []).some((t) => t.name.startsWith("cnx_"))).toBe(false);
    expect(r.stderr).toMatch(/connecteur lent/i);
  }, 30_000);

  test("SPEC-MOD-010/CA-02 — an invalid configuration: the launch fails before any connection", async () => {
    const ws = workspace();
    const pidFile = join(ws.root, "pids.txt");
    writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers: { docs: fakeConnector(ws, "docs", { pidFile }) } }));
    const p = new ScriptedProvider([]);
    const r = await run(ws, p, ["--config-source", "{ invalide", "x"]);
    expect(r.code).toBe(2);
    expect(p.requests.length).toBe(0);
    expect(existsSync(pidFile)).toBe(false);
  });

  test("SPEC-MOD-010/CA-04 — expired sessions are purged, after the input area is shown", async () => {
    const ws = workspace();
    const dir = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)));
    mkdirSync(dir, { recursive: true });
    const old = join(dir, "00000000-0000-4000-8000-000000000001.jsonl");
    writeFileSync(old, "{}\n");
    const longAgo = new Date(Date.now() - 60 * 86_400_000);
    utimesSync(old, longAgo, longAgo);
    const interactiveRun = interactive([], ws, { provider: new ScriptedProvider([]) });
    await interactiveRun.idle();
    await interactiveRun.waitFor(() => !existsSync(old), "purged after the display");
    interactiveRun.type(KEY.ctrlD);
    interactiveRun.type(KEY.ctrlD);
    await interactiveRun.done;
    // The recent ones stay.
    writeFileSync(old, "{}\n");
    await run(ws, new ScriptedProvider([{ text: "ok" }]), ["x"]);
    expect(existsSync(old)).toBe(true);
  });

  test("SPEC-MOD-010/CA-05 — an interruption during the start-up stops the processes of the connectors already started", async () => {
    const ws = workspace();
    const pidFile = join(ws.root, "pids.txt");
    writeFileSync(join(ws.configHome, "connectors.json"), JSON.stringify({ servers: { docs: fakeConnector(ws, "docs", { pidFile, initDelayMs: 20_000 }) } }));
    const stop = new AbortController();
    const at = Date.now();
    const pending = run(ws, new ScriptedProvider([]), ["--wait-for-mcp", "x"], { mcp: { connectTimeout: "30s" } }, stop.signal);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(pidFile)).toBe(true);
    stop.abort();
    await pending;
    expect(Date.now() - at).toBeLessThan(10_000);
    const pid = Number(readFileSync(pidFile, "utf8").trim().split("\n")[0]);
    for (let i = 0; i < 40 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(pid)).toBe(false);
  }, 30_000);

  test("SPEC-MOD-010/CA-06 — with the detailed journal, the duration of each phase can be read", async () => {
    const ws = workspace();
    const r = await run(ws, new ScriptedProvider([{ text: "ok" }]), ["x"], { engine: { startup: { verboseLog: true } } });
    expect(r.stderr).toMatch(/Démarrage : environnement, options et configuration \d+ ms · compatibilité et authentification \d+ ms · extensions et compétences \d+ ms · session \d+ ms · affichage \d+ ms\./);
  });
});

describe("SPEC-MOD-011 and SPEC-MOD-012 remaining criteria", () => {
  test("SPEC-MOD-011/CA-03 — a model locked by the managed configuration wins over --model, with a warning", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ models: { selected: "large" } }));
    const r = await run(ws, new ScriptedProvider([{ text: "ok" }]), ["--model", "small", "--result-format", "json", "x"]);
    expect(JSON.parse(r.stdout).model).toBe("test-large");
    expect(r.stderr).toContain("le modèle est imposé par votre organisation : large s'applique, --model small est ignoré.");
  });

  const catalog = (ws: Workspace) => {
    ws.write("cat/catalog.json", JSON.stringify({ name: "team", extensions: [] }));
    return join(ws.root, "cat");
  };
  const admin = (ws: Workspace, args: string[]) => cli(args, ws, { env: productEnv(ws), userConfig: null });

  test("SPEC-MOD-012/CA-03 — a removal without terminal and without --force fails with code 5", async () => {
    const ws = workspace();
    writeFileSync(join(ws.configHome, "config.json"), JSON.stringify(TEST_USER_CONFIG));
    expect((await admin(ws, ["catalog", "add", catalog(ws)])).code).toBe(0);
    const r = await admin(ws, ["catalog", "remove", "team"]);
    expect(r.code).toBe(5);
    expect(r.stderr).toContain("relancez avec --force");
    expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).extensions.catalogs.team).toBeDefined();
    expect((await admin(ws, ["catalog", "remove", "team", "--force"])).code).toBe(0);
  });

  test("SPEC-MOD-012/CA-04 — a setting locked by the managed configuration cannot be changed, with an explicit message", async () => {
    const ws = workspace();
    writeFileSync(join(ws.configHome, "config.json"), JSON.stringify(TEST_USER_CONFIG));
    ws.write("managed/policy.json", JSON.stringify({ extensions: { catalogs: { team: { source: catalog(ws) } } } }));
    const r = await admin(ws, ["catalog", "remove", "team", "--force"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Ce catalogue est ajouté par votre organisation : il ne peut pas être retiré.");
  });

  test("SPEC-MOD-012/CA-06 — a commented settings file keeps its comments and its layout when a setting is changed", async () => {
    const ws = workspace();
    const file = join(ws.configHome, "config.json");
    const before = `{\n  // Mon fournisseur\n  "api": { "provider": "openai_compatible", "baseUrl": "http://127.0.0.1:9/v1" },\n  /* gammes */\n  "models": { "identifierMap": { "large": "test-large", "medium": "test-medium", "small": "test-small" } }\n}\n`;
    writeFileSync(file, before);
    expect((await admin(ws, ["catalog", "add", catalog(ws)])).code).toBe(0);
    const after = readFileSync(file, "utf8");
    expect(after).toContain("// Mon fournisseur");
    expect(after).toContain("/* gammes */");
    expect(after).toContain('"api": { "provider": "openai_compatible", "baseUrl": "http://127.0.0.1:9/v1" },');
    expect(after).toContain('"team"');
  });
});
