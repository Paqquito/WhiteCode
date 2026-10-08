// Administration within the session (lot 8, increment 4): /access-rules (SPEC-CMD-047) with the masked rules
// (SPEC-PER-012), /event-hooks (SPEC-CMD-031), /connectors (SPEC-CMD-041).
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { broadAllowWarning, covers, maskedRules } from "../src/permissions/rule-review";
import { isRule, parseRule, type Rule, type RuleDecision } from "../src/permissions/rules";
import { cli, workspace, type Workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { BUN, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const SERVER = join(import.meta.dir, "helpers", "mcp-server.ts").replace(/\\/g, "/");
const rule = (raw: string, decision: RuleDecision, scope: Rule["scope"] = "user"): Rule => {
  const r = parseRule(raw, decision, scope, "/anchor");
  if (!isRule(r)) throw new Error(r.message);
  return r;
};
const command = (ws: Workspace, line: string, userConfig: Record<string, unknown> = {}) => cli(["--non-interactive", line], ws, { provider: new ScriptedProvider([]), userConfig });
const shown = (m: Record<string, unknown>) => JSON.stringify((m["result"] as Record<string, unknown>)["shown"]);

describe("SPEC-PER-012 masked rules", () => {
  test("SPEC-PER-012/CA-01 — deny run_shell(git *) and allow run_shell(git status): the second is reported as masked by the first", async () => {
    const masked = maskedRules([rule("run_shell(git *)", "deny"), rule("run_shell(git status)", "allow", "project")]);
    expect(masked).toHaveLength(1);
    expect(masked[0]!.masked.raw).toBe("run_shell(git status)");
    expect(masked[0]!.by.raw).toBe("run_shell(git *)");
    // When the rules are loaded: the report, with the sources and the advice.
    const r = await command(workspace(), "/status", { permissions: { denyRules: ["run_shell(git *)"], allowRules: ["run_shell(git status)"] } });
    expect(r.stderr).toMatch(/Règle masquée : allow run_shell\(git status\) \(portée utilisateur, .*config\.json\), masquée par deny run_shell\(git \*\)/);
    expect(r.stderr).toContain("Conseil :");
  });

  test("TECH — SPEC-PER-012/EF-02 — only certain maskings: a partial overlap is not reported", () => {
    expect(covers(rule("run_shell(git status)", "deny"), rule("run_shell(git *)", "allow"))).toBe(false);
    expect(covers(rule("run_shell(git *)", "deny"), rule("run_shell(gitk)", "allow"))).toBe(false);
    expect(covers(rule("run_shell", "ask"), rule("run_shell(ls)", "allow"))).toBe(true);
    expect(covers(rule("fetch_url(domain:*.example.com)", "deny"), rule("fetch_url(domain:docs.example.com)", "allow"))).toBe(true);
    expect(covers(rule("fetch_url(domain:*.example.com)", "deny"), rule("fetch_url(domain:example.com)", "allow"))).toBe(false);
    expect(covers(rule("edit_file(/src/**)", "deny"), rule("edit_file(/src/a/b.ts)", "allow"))).toBe(true);
    expect(covers(rule("edit_file(/src/**)", "deny"), rule("edit_file(b.ts)", "allow"))).toBe(false);
    expect(maskedRules([rule("run_shell(npm *)", "allow"), rule("run_shell(npm test)", "ask")])).toHaveLength(0);
  });
});

describe("SPEC-CMD-047 /access-rules", () => {
  test("SPEC-CMD-047/CA-01 — a masked rule: the manager shows it with the rule that masks it", async () => {
    const r = await command(workspace(), "/access-rules", { permissions: { askRules: ["read_file"], allowRules: ["read_file(/docs/readme.md)", "run_shell(ls)"] } });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/allow :\n {2}read_file\(\/docs\/readme\.md\) — portée utilisateur/);
    expect(r.stdout).toContain("Règles masquées :");
    expect(r.stdout).toMatch(/Règle masquée : allow read_file\(\/docs\/readme\.md\).*masquée par ask read_file /);
    expect(r.stdout).not.toMatch(/Règle masquée : allow run_shell\(ls\)/);
  });

  test("SPEC-CMD-047/CA-02 — an allow rule on a generic interpreter: a warning is shown when it is added", async () => {
    const ws = workspace();
    const r = await command(ws, "/access-rules allow run_shell(python *) user");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Règle ajoutée : allow run_shell(python *) (portée utilisateur).");
    expect(r.stdout).toContain("Avertissement : la règle run_shell(python *) couvre un interpréteur générique (python)");
    const written = JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8"));
    expect(written.permissions.allowRules).toEqual(["run_shell(python *)"]);
    expect(broadAllowWarning(rule("run_shell(git log *)", "allow"))).toBeUndefined();
  });

  test("TECH — SPEC-CMD-047/ERR-01, FA-01 — an invalid rule is refused; a managed rule cannot be removed", async () => {
    const ws = workspace();
    const invalid = await command(ws, "/access-rules deny run_shell(git *");
    expect(invalid.stderr).toContain("Règle invalide : Règle mal formée : run_shell(git *");
    ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["run_shell(curl *)"] } }));
    const locked = await command(ws, "/access-rules remove run_shell(curl *)");
    expect(locked.stderr).toMatch(/Règle en lecture seule : run_shell\(curl \*\) \(portée gérée, .*policy\.json\)/);
  });
});

describe("SPEC-CMD-031 /event-hooks", () => {
  test("SPEC-CMD-031/CA-01 — a managed hook: its removal is refused, with its source", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ hooks: { before_tool: [{ id: "controle", actions: [{ type: "command", command: "true" }] }] } }));
    const list = await command(ws, "/event-hooks", { hooks: { turn_completed: [{ actions: [{ type: "command", command: "true" }] }] } });
    expect(list.stdout).toMatch(/before_tool \(1\) :\n {2}managed\/before_tool\/controle — commande « true » — .*policy\.json \(non modifiable\)/);
    expect(list.stdout).toMatch(/turn_completed \(1\) :\n {2}user\/turn_completed\/#1 — commande « true » — .*config\.json\n/);
    const r = await command(ws, "/event-hooks remove managed/before_tool/controle");
    expect(r.stderr).toMatch(/Ce crochet n'est pas modifiable : managed\/before_tool\/controle, source .*policy\.json/);
    expect(readFileSync(join(ws.managed, "policy.json"), "utf8")).toContain("controle");
  });

  test("TECH — SPEC-CMD-031 § 5.3 step 3 — a user hook is removed from its file", async () => {
    const ws = workspace();
    const r = await command(ws, "/event-hooks remove user/turn_completed/#1", { hooks: { turn_completed: [{ actions: [{ type: "command", command: "true" }] }] } });
    expect(r.stdout).toContain("Crochet supprimé : user/turn_completed/#1.");
    expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).hooks.turn_completed).toEqual([]);
  });
});

describe("SPEC-CMD-041 /connectors", () => {
  test("SPEC-CMD-041/CA-01 — a connector in failure: reconnected, its state becomes « connecté »", async () => {
    const ws = workspace();
    // The configuration of the simulated server is missing at start: it fails; once written, the reconnection succeeds.
    const config = join(ws.root, "docs.json").replace(/\\/g, "/");
    const servers = JSON.stringify({ servers: { docs: { transport: "stdio", command: BUN, args: [SERVER, config] } } });
    const h = new Host(ws, { provider: new ScriptedProvider([]), init: {}, argv: ["--connectors", servers, "--wait-for-mcp"], env: productEnv(ws) });
    const before = await h.request("invoke_command", { command: "/connectors" });
    writeFileSync(config, JSON.stringify({ tools: [{ name: "search" }] }));
    const after = await h.request("invoke_command", { command: "/connectors reconnect docs" });
    h.feed.end();
    await h.finish();
    expect(shown(before)).toMatch(/docs \(cli\) : (en échec|indisponible)/);
    expect(shown(after)).toContain("docs (cli) : connecté, 1 outil");
  }, 30_000);
});
