// Coherent validation of a managed policy before session effects and between requests.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { cli, trustedPolicyFile, workspace } from "./helpers/env";
import { productEnv, record, hook } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { ManagedPolicyGuard, validateManagedPolicy } from "../src/config/managed-policy";
import { Host } from "./helpers/control";
import { interactive, KEY } from "./helpers/interactive";
import { bench, probe } from "./helpers/engine";
import { ResponseExecution } from "../src/engine/executor";
import { textOutcome } from "../src/tools/types";

for (const [kind, failure] of [["command failure", "process.exit(1);"], ["nonconforming response", "console.log(JSON.stringify({ decision: 'unsupported' }));"]] as const) {
  for (const driver of ["automated", "control", "interactive"]) {
    test("SPEC-CFG-003/CA-11 — mandatory " + kind + " refuses the " + driver + " action despite no-hooks", async () => {
      const ws = workspace();
      const target = join(ws.project, "created.txt");
      const command = hook(ws, "mandatory-control", failure);
      ws.write("managed/policy.json", JSON.stringify({ hooks: { before_tool: [{ id: "required-check", mandatory: true, actions: [{ type: "command", command }] }] } }));
      const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "MUST-NOT-EXIST" } }] }, { text: "CONTROL-REFUSAL-OBSERVED" }]);
      if (driver === "automated") {
        const result = await cli(["--non-interactive", "--no-hooks", "--approval-mode", "auto_edit", "Create created.txt."], ws, { provider, env: productEnv(ws) });
        expect(result.code).toBe(0);
        expect(result.stderr).toContain("contrôle obligatoire");
      } else if (driver === "control") {
        const host = new Host(ws, { argv: ["--no-hooks", "--approval-mode", "auto_edit"], provider, env: productEnv(ws) });
        try { host.user("Create created.txt."); await host.waitFor((m) => m.type === "turn_completed"); }
        finally { host.feed.end(); }
        expect((await host.finish()).code).toBe(0);
        expect(host.demands("approval_request")).toHaveLength(0);
      } else {
        const terminal = interactive(["--no-hooks", "--approval-mode", "auto_edit"], ws, { provider, env: productEnv(ws) });
        try {
          await terminal.idle();
          terminal.type("Create created.txt." + KEY.enter);
          await terminal.waitFor((t) => t.includes("CONTROL-REFUSAL-OBSERVED"), "completed turn after mandatory refusal");
          expect(terminal.all().join("\n")).toContain("contrôle obligatoire");
        } finally { terminal.type("/quit" + KEY.enter); }
        expect((await terminal.done).code).toBe(0);
      }
      expect(existsSync(target)).toBe(false);
      expect(provider.requests).toHaveLength(2);
      const feedback = JSON.stringify(provider.requests[1]!.history);
      expect(feedback).toContain("Action denied");
      expect(feedback).toContain("contrôle obligatoire");
    });
  }
}

test("SPEC-CFG-001/CA-06 — invalid managed JSON blocks every driver before provider creation; local diagnosis retains valid UI preferences", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", '{ "permissions": { "denyRules": [');
  const hook = record(ws, "prompt");
  const provider = new ScriptedProvider([]);
  let factories = 0;
  const options = {
    provider, env: productEnv(ws),
    userConfig: { ui: { colorMode: "none", history: { maxEntries: 123 } }, hooks: { prompt_submitted: [{ actions: [{ type: "command", command: hook.command }] }] } },
    extra: { providerFactory: () => { factories++; return provider; } },
  };
  for (const argv of [["--non-interactive", "Read the summary."], ["--control-channel"], ["connector-server", "start"], ["extension", "list"]]) {
    const result = await cli(argv, ws, options);
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("Politique obligatoire invalide");
  }
  const diagnostic = await cli(["--non-interactive", "/diagnose"], ws, options);
  const terminal = interactive([], ws, { provider, env: options.env, userConfig: options.userConfig });
  expect((await terminal.done).code).toBe(4);
  expect(diagnostic.code).toBe(4);
  expect(diagnostic.stdout).toContain("Diagnostic local de politique");
  expect(diagnostic.stdout).toContain('ui.colorMode = "none"');
  expect(diagnostic.stdout).toContain("ui.history.maxEntries = 123");
  expect(diagnostic.stdout).toContain("JSON");
  expect((await cli(["--help"], ws, options)).code).toBe(0);
  expect((await cli(["config", "validate", "--scope", "managed"], ws, options)).code).toBe(2);
  expect(factories).toBe(0);
  expect(provider.requests).toHaveLength(0);
  expect(hook.read()).toHaveLength(0);
});

test("SPEC-CFG-003/CA-07 — malformed mandatory rules invalidate the whole version despite weaker CLI or user settings", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([]);
  for (const permissions of [{ denyRules: ["read_file("], allowRules: ["write_file"] }, { askRules: ["nonexistent_tool"] }, { managedRulesOnly: "false" }]) {
    ws.write("managed/policy.json", JSON.stringify({ permissions }));
    const result = await cli(["--non-interactive", "--config-scopes", "user", "--allow-rule", "write_file", "Read the summary."], ws, { provider, userConfig: { permissions: { denyRules: [] } } });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("Politique obligatoire invalide");
    const validation = await cli(["config", "validate", "--scope", "managed", "--json"], ws, { provider });
    expect(validation.code).toBe(2);
    expect(validation.stdout).toContain('"kind":"policy"');
  }
  expect(provider.requests).toHaveLength(0);
});

test("SPEC-HOK-002/CA-06 — an invalid mandatory filter blocks before any optional or mandatory hook runs", async () => {
  const ws = workspace();
  const hook = record(ws, "mandatory");
  const provider = new ScriptedProvider([]);
  ws.write("managed/policy.json", JSON.stringify({ hooks: { prompt_submitted: [{ id: "check", mandatory: true, match: "invalid filter", actions: [{ type: "command", command: hook.command }] }] } }));
  const result = await cli(["--non-interactive", "--no-hooks", "Read the summary."], ws, { provider, env: productEnv(ws) });
  expect(result.code).toBe(4);
  expect(result.stderr).toContain("hooks");
  expect(hook.read()).toHaveLength(0);
  expect(provider.requests).toHaveLength(0);
});

test("SPEC-CFG-003/CA-16 — invalid optional detachedWaitTimeout is ignored alone while the mandatory deny rule still applies", async () => {
  const ws = workspace();
  const target = join(ws.project, "secret.txt");
  ws.write("project/secret.txt", "PRIVATE-CONTENT");
  ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["read_file(/secret.txt)"], detachedWaitTimeout: "invalid-duration" } }));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: target } }] }, { text: "done" }]);
  const result = await cli(["--non-interactive", "Read secret.txt."], ws, { provider });
  expect(result.code).toBe(0);
  expect(result.stderr).toContain("permissions.detachedWaitTimeout");
  expect(result.stderr).toContain("valeur ignorée");
  expect(result.stderr).not.toContain("Clé inconnue");
  expect(provider.requests).toHaveLength(2);
  const results = JSON.stringify(provider.requests[1]!.history);
  expect(results).toContain("denied");
  expect(results).not.toContain("PRIVATE-CONTENT");
});

test("TECH — requiredKeys rejects missing, unknown, unsupported-scope and invalid required values without default fallback", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([]);
  for (const policy of [
    { policy: { requiredKeys: ["permissions.detachedWaitTimeout"] } },
    { policy: { requiredKeys: ["unknown.setting"] } },
    { policy: { requiredKeys: ["ui.colorMode"] }, ui: { colorMode: "none" } },
    { policy: { requiredKeys: ["permissions.detachedWaitTimeout"] }, permissions: { detachedWaitTimeout: "bad" } },
    { policy: { requiredKeys: "permissions.denyRules" } },
  ]) {
    ws.write("managed/policy.json", JSON.stringify(policy));
    expect((await cli(["--non-interactive", "Read the summary."], ws, { provider })).code).toBe(4);
  }
  expect(provider.requests).toHaveLength(0);
});

test("TECH — malformed mandatory hook actions, types and identifiers cannot be silently discarded", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([]);
  const action = { type: "command", command: "exit 0" };
  for (const list of [
    [{ mandatory: true, actions: [action] }],
    [{ id: "check", mandatory: true, match: 12, actions: [action] }],
    [{ id: "check", mandatory: "true", actions: [action] }],
    [{ id: "check", mandatory: true, async: true, actions: [action] }],
    [{ id: "check", mandatory: true, actions: [{ type: "unknown", command: "exit 0" }, action] }],
    [{ id: "check", mandatory: true, actions: [{ ...action, timeout: "bad" }] }],
    [{ id: "check", mandatory: true, actions: [action], timeout: "bad" }],
    [{ id: "check", mandatory: true, actions: [action], matchh: "read_file" }],
    [{ id: "check", mandatory: true, actions: [{ ...action, commandd: "exit 1" }] }],
    [{ id: "check", mandatory: true, actions: [action] }, { id: "check", mandatory: true, actions: [{ ...action, command: "exit 1" }] }],
    [{ id: "check", actions: [action] }, { id: "check", mandatory: true, actions: [action] }],
  ]) {
    ws.write("managed/policy.json", JSON.stringify({ hooks: { before_tool: list } }));
    expect((await cli(["--non-interactive", "Read the summary."], ws, { provider })).code).toBe(4);
  }
  expect(provider.requests).toHaveLength(0);
});

test("TECH — invalid optional hook preferences do not invalidate valid managed rules", () => {
  for (const hooks of ["invalid", { before_tool: "invalid" }, { before_tool: [{ match: "invalid filter", actions: [{ type: "command", command: "exit 0" }] }] }]) {
    const policy = validateManagedPolicy(JSON.stringify({ hooks, permissions: { denyRules: ["run_shell"] } }));
    expect(policy.required).toBe(true);
    expect(policy.issues).toEqual([]);
  }
  expect(validateManagedPolicy(JSON.stringify({ hooks: { session_closed: [{ id: "check", mandatory: true, actions: [{ type: "command", command: "exit 0" }] }] } })).issues.length).toBeGreaterThan(0);
});

test("TECH — prototype properties cannot hide a mandatory declaration or break local recovery", async () => {
  const ws = workspace();
  const provider = new ScriptedProvider([]);
  for (const text of [
    '{"__proto__":{"permissions":{"denyRules":["read_file("]}}}',
    '{"hooks":{"constructor":[{"id":"check","mandatory":true,"actions":[{"type":"command","command":"exit 0"}]}]}}',
    '{"hooks":{"__proto__":[{"id":"check","mandatory":true,"actions":[{"type":"command","command":"exit 0"}]}]}}',
  ]) {
    ws.write("managed/policy.json", text);
    expect((await cli(["--non-interactive", "Read the summary."], ws, { provider })).code).toBe(4);
    const diagnostic = await cli(["--non-interactive", "/diagnose"], ws, { provider });
    expect(diagnostic.code).toBe(4);
    expect(diagnostic.stdout).toContain("Diagnostic local de politique");
    expect((await cli(["--help"], ws, { provider })).code).toBe(0);
  }
  expect(provider.requests).toHaveLength(0);
});

test("TECH — an approval cannot authorise a write after the mandatory policy becomes invalid", async () => {
  const ws = workspace();
  const target = join(ws.project, "created.txt");
  ws.write("managed/policy.json", JSON.stringify({ permissions: { askRules: ["write_file"] } }));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "must not be written" } }] }]);
  let approvals = 0;
  const result = await cli(["--non-interactive", "Create created.txt."], ws, { provider, extra: { authorities: {
    controlHost: { decide: async () => { approvals++; ws.write("managed/policy.json", '{"permissions":'); return { decision: "allow" }; } },
  } } });
  expect(approvals).toBe(1);
  expect(result.code).toBe(4);
  expect(existsSync(target)).toBe(false);
  expect(provider.requests).toHaveLength(1);
});

test("TECH — missing or changed mandatory rules suspend the composed session without adopting a weaker policy", async () => {
  for (const missing of [false, true]) {
    const ws = workspace();
    const path = ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["run_shell"] } }));
    const target = join(ws.project, "created.txt");
    const provider = new ScriptedProvider([() => {
      if (missing) unlinkSync(path);
      else ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: [] } }));
      return { toolCalls: [{ name: "write_file", input: { path: target, content: "must not be written" } }] };
    }]);
    const result = await cli(["--non-interactive", "--approval-mode", "auto_edit", "Create created.txt."], ws, { provider });
    expect(result.code).toBe(4);
    expect(result.stderr).toContain("session suspendue");
    expect(existsSync(target)).toBe(false);
    expect(provider.requests).toHaveLength(1);
  }
});

test("TECH — an optional managed copy does not erase the identical action of a mandatory control", async () => {
  const ws = workspace();
  const hook = record(ws, "check");
  const actions = [{ type: "command", command: `${hook.command}; exit 1` }];
  ws.write("managed/policy.json", JSON.stringify({ hooks: { before_tool: [
    { id: "optional", actions }, { id: "control", mandatory: true, actions },
  ] } }));
  const target = join(ws.project, "created.txt");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "must not be written" } }] }, { text: "done" }]);
  const result = await cli(["--non-interactive", "--approval-mode", "auto_edit", "--no-hooks", "Create created.txt."], ws, { provider, env: productEnv(ws) });
  expect(result.code).toBe(0);
  expect(existsSync(target)).toBe(false);
  expect(hook.read()).toHaveLength(2);
  expect(JSON.stringify(provider.requests[1]!.history)).toContain("Action denied");
});

test("TECH — only the mandatory projection suspends adoption; preferences and JSON formatting remain independent", () => {
  const ws = workspace();
  const path = ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["run_shell"] }, ui: { history: { maxEntries: 100 } } }));
  const guard = new ManagedPolicyGuard(path, undefined, undefined, trustedPolicyFile);
  ws.write("managed/policy.json", '{ // comment\n "ui": { "history": { "maxEntries": 200 } }, "permissions": { "denyRules": ["run_shell"] } }');
  expect(guard.check()).toEqual([]);
  ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: [] } }));
  expect(guard.check()).toHaveLength(1);
  ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["run_shell"] } }));
  expect(guard.check()).toHaveLength(1);
});

test("TECH — control commands can diagnose an invalid policy without mutating preferences or calling the model", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["run_shell"] } }));
  const provider = new ScriptedProvider([]);
  const host = new Host(ws, { provider,
    init: { decisionAuthority: true }, userConfig: { engine: { control: { allowEscalation: true } } },
    answers: { confirm_escalation: (params: Record<string, unknown>) => ({ decision: "confirm", escalationId: params["escalationId"] }) },
  });
  try {
    await host.request("invoke_command", { command: "/preferences ui.history.maxEntries" });
    const before = readFileSync(join(ws.configHome, "config.json"), "utf8");
    ws.write("managed/policy.json", '{"permissions":');
    const refused = await host.request("invoke_command", { command: "/preferences ui.history.maxEntries 100" });
    expect(JSON.stringify(refused)).toContain("Politique obligatoire invalide");
    const diagnostic = await host.request("invoke_command", { command: "/diagnose" });
    expect(JSON.stringify(diagnostic)).toContain("Diagnostic local de politique");
    expect(readFileSync(join(ws.configHome, "config.json"), "utf8")).toBe(before);
    expect(provider.requests).toHaveLength(0);
  } finally { host.feed.end(); expect((await host.finish()).code).toBe(0); }
});

test("TECH — duplicate JSON properties cannot hide an invalid restriction", async () => {
  const ws = workspace();
  ws.write("managed/policy.json", '{"permissions":{"denyRules":["read_file("],"denyRules":[]}}');
  const provider = new ScriptedProvider([]);
  expect((await cli(["--non-interactive", "Read the summary."], ws, { provider })).code).toBe(4);
  expect(provider.requests).toHaveLength(0);
});

test("TECH — a policy corrupted during the model response refuses the tool before its hooks or write and prevents another request", async () => {
  const ws = workspace();
  const policy = ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["run_shell"] } }));
  const hook = record(ws, "before-tool");
  const target = join(ws.project, "created.txt");
  const provider = new ScriptedProvider([() => {
    ws.write("managed/policy.json", '{"permissions":');
    return { toolCalls: [{ name: "write_file", input: { path: target, content: "must not be written" } }] };
  }]);
  const result = await cli(["--non-interactive", "--approval-mode", "auto_edit", "Create created.txt."], ws, {
    provider, env: productEnv(ws), userConfig: { hooks: { before_tool: [{ actions: [{ type: "command", command: hook.command }] }] } },
  });
  expect(result.code).toBe(4);
  expect(provider.requests).toHaveLength(1);
  expect(existsSync(target)).toBe(false);
  expect(hook.read()).toHaveLength(0);
  expect(readFileSync(policy, "utf8")).toBe('{"permissions":');
});

test("TECH — a queued tool is rechecked after the previous tool completes; completed work is reported accurately", async () => {
  const ws = workspace();
  const file = ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["run_shell"] } }));
  const guard = new ManagedPolicyGuard(file, undefined, undefined, trustedPolicyFile);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const calls: unknown[] = [];
  const first = probe("first", { run: async () => { started(); await gate; ws.write("managed/policy.json", '{"permissions":'); return textOutcome("first completed"); } });
  const second = probe("second", { calls });
  const b = bench([], { tools: [first, second], executor: { concurrency: 1, policyRefusal: () => guard.check().length > 0 ? "Blocked by mandatory policy." : undefined } });
  const execution = new ResponseExecution({ ...b.deps.executor, emit: b.deps.emit }, new AbortController().signal);
  execution.submit({ callId: "first", name: "first", input: {} });
  execution.submit({ callId: "second", name: "second", input: {} });
  execution.responseComplete("tool_use");
  await running;
  release();
  const results = await execution.results();
  expect(calls).toHaveLength(0);
  expect(results[0]!.isError).toBe(false);
  expect(JSON.stringify(results[0]!.content)).toContain("first completed");
  expect(results[1]!.isError).toBe(true);
  expect(JSON.stringify(results[1]!.content)).toContain("Blocked by mandatory policy");
  expect(b.events.filter((e) => e.type === "tool_started")).toHaveLength(1);
});
