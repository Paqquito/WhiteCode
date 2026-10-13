// Diagnostics and debug journal through the CLI, without a remote model service.
import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createDebugLog } from "../src/shared/debug-log";
import { cli, loadIdentity, TEST_USER_CONFIG, workspace } from "./helpers/env";
import { prefix, productEnv, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-OBS-015/CA-02 — SPEC-OBS-015/CA-03 — validate identifies the invalid key without modifying configuration or starting a model", async () => {
  const ws = workspace();
  const file = join(ws.configHome, "config.json");
  const original = JSON.stringify({ ...TEST_USER_CONFIG, ui: { colorMode: 42 } }, null, 2) + "\n";
  writeFileSync(file, original);
  let factories = 0;
  const result = await cli(["diagnostic", "validate", "--json"], ws, { userConfig: null, env: productEnv(ws), extra: { providerFactory: () => { factories++; throw new Error("No model may start during validation."); } } });
  expect(result.code).toBe(1);
  const document = JSON.parse(result.stdout);
  expect(document.errors).toBe(1);
  expect(document.findings).toContainEqual(expect.objectContaining({ status: "error", location: `${file}, clé ui.colorMode`, message: expect.stringContaining("`ui.colorMode`"), fix: "retirer `ui.colorMode` (la valeur par défaut s'appliquera)" }));
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(factories).toBe(0);
  expect(existsSync(join(ws.configHome, "sessions"))).toBe(false);
});

test("SPEC-OBS-012/CA-01 — the hooks filter records a real hook and excludes other domains", async () => {
  const ws = workspace();
  const hook = record(ws, "observed-hook");
  const path = join(ws.root, "hooks.log");
  const result = await cli(["--non-interactive", "--debug", "hooks", "--debug-output", path, "go"], ws, {
    provider: new ScriptedProvider([{ text: "done" }]), env: productEnv(ws),
    signal: AbortSignal.timeout(10_000),
    userConfig: { hooks: { session_opened: [{ actions: [{ type: "command", command: hook.command }] }] } },
  });
  expect(result.code).toBe(0);
  expect(hook.read()).toHaveLength(1);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  expect(lines.length).toBeGreaterThan(0);
  expect(lines.every((line) => /^\S+ \[hooks\] /.test(line))).toBe(true);
  expect(result.stderr).toContain(`Journal de débogage : ${path}`);
  expect(result.stdout).not.toContain("[hooks]");
}, 15_000);

test("TECH — debug exclusions win over inclusions; an exclusion alone retains other domains", () => {
  for (const filters of [["hooks", "api", "!api"], ["!api"]]) {
    const lines: string[] = [];
    const debug = createDebugLog({ kind: "stderr", write: (line) => lines.push(line) }, filters);
    debug.log("hooks", "ran"); debug.log("api", "requested"); debug.log("tools", "read");
    expect(lines.filter((line) => line.includes("[hooks]"))).toHaveLength(1);
    expect(lines.filter((line) => line.includes("[api]"))).toHaveLength(0);
    expect(lines.filter((line) => line.includes("[tools]"))).toHaveLength(filters.length === 1 ? 1 : 0);
  }
});

test("TECH — an inaccessible debug file falls back once to stderr without failing the execution", async () => {
  const ws = workspace();
  const path = join(ws.root, "directory.log"); mkdirSync(path);
  const provider = new ScriptedProvider([{ text: "done" }]);
  const result = await cli(["--non-interactive", "--debug=config", "--debug-output", path, "go"], ws, { provider, env: productEnv(ws) });
  expect(result.code).toBe(0);
  expect(provider.requests).toHaveLength(1);
  expect(result.stderr.match(/repli sur la sortie d'erreur/g)).toHaveLength(1);
  expect(result.stderr).toContain("[config] settings loaded");
  expect(result.stdout).not.toContain("[config]");
});

test("TECH — DEBUG_FILE supplies the file destination and an explicit CLI destination takes precedence", async () => {
  for (const explicit of [false, true]) {
    const ws = workspace();
    const envPath = join(ws.root, "environment.log"), cliPath = join(ws.root, "cli.log");
    const result = await cli(["--non-interactive", "--debug=config", ...(explicit ? ["--debug-output", cliPath] : []), "go"], ws, {
      provider: new ScriptedProvider([{ text: "done" }]), env: productEnv(ws, { [`${prefix}DEBUG_FILE`]: envPath }),
    });
    expect(result.code).toBe(0);
    expect(readFileSync(explicit ? cliPath : envPath, "utf8")).toContain("[config] settings loaded");
    expect(existsSync(explicit ? envPath : cliPath)).toBe(false);
  }
});

test("TECH — an error while appending switches the journal to stderr for all subsequent entries", () => {
  const ws = workspace(), path = join(ws.root, "append.log"), saved = join(ws.root, "saved.log");
  const lines: string[] = [];
  const debug = createDebugLog({ kind: "file", path, write: (line) => lines.push(line) }, []);
  debug.log("hooks", "before"); renameSync(path, saved); mkdirSync(path);
  debug.log("hooks", "during"); debug.log("hooks", "after");
  expect(debug.path).toBeUndefined();
  expect(readFileSync(saved, "utf8")).toContain("before");
  expect(readFileSync(saved, "utf8")).not.toContain("during");
  expect(lines.filter((line) => line.includes("repli"))).toHaveLength(1);
  expect(lines.filter((line) => line.includes("[hooks]"))).toHaveLength(2);
});

test("TECH — a debug destination with another physical name is preserved and never used for logging", () => {
  const ws = workspace(), path = ws.write("linked.log", "preserved\n"), alias = join(ws.root, "alias.log");
  linkSync(path, alias);
  const lines: string[] = [];
  const debug = createDebugLog({ kind: "file", path, write: (line) => lines.push(line) }, []);
  debug.log("api", "request", { nested: { authorization: "arbitrary-test-value" } });
  expect(debug.path).toBeUndefined();
  expect(readFileSync(path, "utf8")).toBe("preserved\n");
  expect(lines.join("")).toContain("••••");
  expect(lines.join("")).not.toContain("arbitrary-test-value");
});

test("TECH — replacing a private debug file with a regular file never transfers logging to the replacement", () => {
  const ws = workspace(), path = join(ws.root, "private.log");
  const lines: string[] = [];
  const debug = createDebugLog({ kind: "file", path, write: (line) => lines.push(line) }, []);
  debug.log("api", "first"); renameSync(path, join(ws.root, "original.log")); writeFileSync(path, "replacement\n");
  debug.log("api", "confidential second entry");
  expect(readFileSync(path, "utf8")).toBe("replacement\n");
  expect(debug.path).toBeUndefined();
  expect(lines.join("")).toContain("confidential second entry");
});

test("TECH — diagnostic text, JSON and repair prompts mask an accidental secret key without changing its real setting", async () => {
  const key = "sk-test-misplaced-key-012345678901234567";
  for (const args of [["validate"], ["validate", "--json"], ["repair"]]) {
    const ws = workspace();
    const result = await cli(["diagnostic", ...args], ws, { userConfig: { [key]: "mistaken property" }, env: productEnv(ws), tty: true, stdin: "n\n" });
    expect(result.stdout + result.stderr).not.toContain(key);
    expect(result.stdout + result.stderr).toContain("[masqué]");
    expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8"))[key]).toBe("mistaken property");
    if (args.includes("--json")) expect(JSON.parse(result.stdout).findings).toBeArray();
  }
});

test("SPEC-OBS-021/CA-02 — with a one-unit budget, the third half-unit request is refused before transmission", async () => {
  const provider = new ScriptedProvider([1, 2, 3].map((n) => ({ text: `step ${n}`, usage: { input: 0, output: 1000 }, toolCalls: [{ name: "read_file", input: { path: `/nowhere/${n}.txt` } }] })));
  const result = await cli(["--non-interactive", "--model", "large", "--max-cost", "1", "--result-format", "json", "go"], workspace(), {
    provider, env: { [`${loadIdentity().get("ENV_PREFIX")}RESPONSE_TOKEN_LIMIT`]: "1000" },
    userConfig: { models: { pricingOverrides: { "test-large": { inputPerMTok: 0, outputPerMTok: 500, cacheReadPerMTok: 0, cacheWritePerMTok: 0 } } } },
  });
  expect(result.code).toBe(3);
  expect(provider.requests).toHaveLength(2);
  expect(provider.requests.every((request) => request.maxOutputTokens === 1000)).toBe(true);
  expect(JSON.parse(result.stdout)).toMatchObject({ haltReason: "budget_limit", cost: { cap: 1, confirmed: 1, conservative: 1, reserved: 0 }, message: expect.stringContaining("Budget atteint") });
});
