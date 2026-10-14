// Permission modes planning, auto_edit, unrestricted; revalidation before execution; persisted answers; protected locations; registry.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Conversation } from "../src/engine/conversation";
import { runTurn, type LoopDeps } from "../src/engine/loop";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";
import { decide, type PermissionQuery } from "../src/permissions/engine";
import { ModeState, nextMode, type ModeAvailability } from "../src/permissions/modes";
import { isRule, parseRule, ruleMatches, type Rule } from "../src/permissions/rules";
import type { HumanAnswer } from "../src/permissions/resolver";
import { currentPlatform } from "../src/platform/system";
import { ToolRegistry } from "../src/tools/registry";
import { readFileTool } from "../src/tools/read-file";
import { textOutcome, type Tool, type ToolContext } from "../src/tools/types";
import { cli, loadIdentity, testModel, testToolFields, workspace, type Workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const platform = currentPlatform();
const identity = loadIdentity();
const NONE: ModeAvailability = { allowUnrestrictedOption: false, disableUnrestricted: false, disableAutoApprove: false, autoApproveConsent: false };

const toolResultTexts = (provider: ScriptedProvider, requestIndex: number) =>
  provider.requests[requestIndex]!.history.flatMap((m) => (m.role === "user" ? m.parts.flatMap((p) => (p.type === "tool_result" ? p.content.map((c) => (c.type === "text" ? c.text : "")) : [])) : []));

function rule(raw: string, decision: "allow" | "ask" | "deny", scope: Rule["scope"], anchor: string): Rule {
  const r = parseRule(raw, decision, scope, anchor);
  if (!isRule(r)) throw new Error(r.message);
  return r;
}

describe("SPEC-PER-003 modes", () => {
  test("SPEC-PER-003/CA-01 — from ask, without auto_approve nor unrestricted: auto_edit, planning, ask", () => {
    const seen: string[] = [];
    let mode = "ask" as Parameters<typeof nextMode>[0];
    for (let i = 0; i < 3; i++) seen.push((mode = nextMode(mode, NONE)));
    expect(seen).toEqual(["auto_edit", "planning", "ask"]);
    const state = new ModeState("ask", NONE);
    expect([state.cycle(), state.cycle(), state.cycle()]).toEqual(["auto_edit", "planning", "ask"]);
  });

  test("SPEC-PER-003/CA-03 — SPEC-CFG-003/CA-01 — managed disableUnrestrictedMode and --approval-mode unrestricted: the launch fails on ERR-02", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ permissions: { disableUnrestrictedMode: true } }));
    const r = await cli(["--non-interactive", "--allow-unrestricted-mode", "--approval-mode", "unrestricted", "x"], ws, { provider: new ScriptedProvider([{ text: "no" }]) });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("désactivé par votre administrateur");
    expect(r.stdout).toBe("");
  });

  test("SPEC-PER-003/CA-06 — after a mode change, the next request carries a reminder of the new mode", async () => {
    const ws = workspace();
    const file = ws.write("project/a.txt", "a\n");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "ok" }]);
    let modes: ModeState | undefined;
    const r = await cli(["--non-interactive", "--approval-mode", "ask", "go"], ws, {
      provider,
      extra: {
        onSession: (s) => (modes = s.modes),
        onEvent: (e) => void (e.type === "tool_call" && modes!.set("planning")),
      },
    });
    expect(r.code).toBe(0);
    const last = provider.requests[1]!.history[provider.requests[1]!.history.length - 1]!;
      expect(last).toEqual({ role: "system_note", contextId: expect.stringMatching(/^m[1-9][0-9]*$/), text: expect.stringContaining("The permission mode is now planning") });
    expect(provider.requests[0]!.history.some((m) => m.role === "system_note")).toBe(false);
  });

  test("SPEC-PER-003/CA-07 and SPEC-PER-001/CA-24 — unrestricted mode and a request imposed by the managed policy: not lifted", async () => {
    const ws = workspace();
    const target = join(ws.project, "out.txt");
    const managedAsk = rule("write_file", "ask", "managed", ws.project);
    const q: PermissionQuery = { toolName: "write_file", subject: { kind: "paths", access: "write", paths: [target] }, flags: { readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: false }, available: true };
    const base = { rules: [managedAsk], sessionAllows: [], managedRulesOnly: false, cwd: ws.project, home: ws.home, platform };
    expect(decide(q, { ...base, mode: "unrestricted" })).toMatchObject({ kind: "ask", step: 2, origin: "managed" });
    // End to end: the managed request cannot be answered in this run, so the write is denied; without it, unrestricted writes.
    ws.write("managed/policy.json", JSON.stringify({ permissions: { askRules: ["write_file"] } }));
    const denied = await cli(["--non-interactive", "--allow-unrestricted-mode", "--approval-mode", "unrestricted", "go"], ws, {
      provider: new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "x" } }] }, { text: "done" }]),
    });
    expect(denied.code).toBe(0);
    expect(existsSync(target)).toBe(false);
    const ws2 = workspace();
    const target2 = join(ws2.project, "out.txt");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target2, content: "x" } }] }, { text: "done" }]);
    await cli(["--non-interactive", "--allow-unrestricted-mode", "--approval-mode", "unrestricted", "go"], ws2, { provider });
    expect(existsSync(target2)).toBe(true);
  });

  test("SPEC-PER-003/CA-08 — a pending request in auto_edit, then planning: the approval is re-evaluated and the write is refused", async () => {
    const ws = workspace();
    const outside = join(ws.root, "outside", "x.txt"); // outside the allowed folders: auto_edit asks
    let modes: ModeState | undefined;
    const human = {
      async request(): Promise<HumanAnswer> {
        modes!.set("planning"); // the user switches mode while the request is pending
        return { answer: "yes" };
      },
    };
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: outside, content: "x" } }] }, { text: "done" }]);
    const r = await cli(["--non-interactive", "--approval-mode", "auto_edit", "go"], ws, { provider, extra: { authorities: { human }, onSession: (s) => (modes = s.modes) } });
    expect(r.code).toBe(0);
    expect(existsSync(outside)).toBe(false);
    expect(toolResultTexts(provider, 1)[0]).toContain("Planning mode");
  });
});

describe("SPEC-PER-001 modes and persisted answers", () => {
  const write = (path: string) => ({ toolCalls: [{ name: "write_file", input: { path, content: "new" } }] });

  test("SPEC-PER-001/CA-03 — planning mode: write_file is refused with the planning reason", async () => {
    const ws = workspace();
    const target = join(ws.project, "p.txt");
    const provider = new ScriptedProvider([write(target), { text: "ok" }]);
    await cli(["--non-interactive", "--approval-mode", "planning", "go"], ws, { provider });
    expect(existsSync(target)).toBe(false);
    expect(toolResultTexts(provider, 1)[0]).toBe("Action denied: Planning mode: no modification is allowed.");
  });

  test("SPEC-PER-001/CA-10 — planning mode and an allow rule on write_file: still refused with the planning reason", async () => {
    const ws = workspace();
    const target = join(ws.project, "p.txt");
    const provider = new ScriptedProvider([write(target), { text: "ok" }]);
    await cli(["--non-interactive", "--approval-mode", "planning", "--allow-rule", "write_file", "go"], ws, { provider });
    expect(existsSync(target)).toBe(false);
    expect(toolResultTexts(provider, 1)[0]).toContain("Planning mode");
  });

  test("SPEC-PER-001/CA-05 — \"yes, don't ask again\" at the local project level: allowed without request, in a new session too", async () => {
    const ws = workspace();
    const first = join(ws.project, "one.txt");
    const second = join(ws.project, "two.txt");
    let asked = 0;
    const human = {
      async request(): Promise<HumanAnswer> {
        asked++;
        return { answer: "yes_always", scope: "local", rule: "write_file(/**)" };
      },
    };
    const run = (path: string) =>
      cli(["--non-interactive", "--approval-mode", "ask", "--allow-project-trust", "go"], ws, { provider: new ScriptedProvider([write(path), { text: "ok" }]), extra: { authorities: { human } } });
    await run(first);
    expect(asked).toBe(1);
    expect(readFileSync(first, "utf8")).toBe("new");
    const local = JSON.parse(readFileSync(join(ws.project, identity.get("PROJECT_DIR"), "config.local.json"), "utf8"));
    expect(local.permissions.allowRules).toEqual(["write_file(/**)"]);
    await run(second);
    expect(asked).toBe(1); // no new request
    expect(readFileSync(second, "utf8")).toBe("new");
  });

  test("SPEC-PER-010/CA-02 — E-045 — auto_edit: writes inside the working folder are allowed, the product configuration is always asked", async () => {
    const ws = workspace();
    const inside = join(ws.project, "src", "ok.txt");
    const protectedFile = join(ws.project, identity.get("PROJECT_DIR"), "config.json");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: inside, content: "x" } }, { name: "write_file", input: { path: protectedFile, content: "{}" } }] }, { text: "ok" }]);
    await cli(["--non-interactive", "--approval-mode", "auto_edit", "go"], ws, { provider });
    expect(existsSync(inside)).toBe(true);
    expect(existsSync(protectedFile)).toBe(false);
    const results = toolResultTexts(provider, 1);
    expect(results[1]).toContain("Action denied");
  });
});

describe("SPEC-PER-002 rules for the file and web tools", () => {
  test("SPEC-PER-002/CA-05 — allow edit_file(/src/**) declared in the project settings covers <project>/src/a.ts", async () => {
    const ws = workspace();
    const file = ws.write("project/src/a.ts", "const a = 1;\n");
    mkdirSync(join(ws.project, identity.get("PROJECT_DIR")), { recursive: true });
    writeFileSync(join(ws.project, identity.get("PROJECT_DIR"), "config.json"), JSON.stringify({ permissions: { allowRules: ["edit_file(/src/**)"] } }));
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "read_file", input: { path: file } }] },
      { toolCalls: [{ name: "edit_file", input: { path: file, old_text: "1", new_text: "2" } }] },
      { text: "ok" },
    ]);
    const r = await cli(["--non-interactive", "--approval-mode", "ask", "--allow-project-trust", "go"], ws, { provider });
    expect(r.code).toBe(0);
    expect(readFileSync(file, "utf8")).toBe("const a = 2;\n");
    const r2 = rule("edit_file(/src/**)", "allow", "project", ws.project);
    expect(ruleMatches(r2, "edit_file", { kind: "paths", access: "write", paths: [join(ws.project, "lib", "a.ts")] }, { cwd: ws.project, home: ws.home, platform })).toBe(false);
  });

  test("SPEC-PER-002/CA-06 — allow fetch_url(domain:*.example.com) covers https://docs.example.com/x (matcher)", () => {
    const r = rule("fetch_url(domain:*.example.com)", "allow", "user", "/");
    const m = (url: string) => ruleMatches(r, "fetch_url", { kind: "url", url }, { cwd: "/", home: "/", platform });
    expect(m("https://docs.example.com/x")).toBe(true);
    expect(m("https://example.com/x")).toBe(false);
    expect(m("https://example.com.evil.test/x")).toBe(false);
  });
});

describe("SPEC-MOT-002 revalidation before execution", () => {
  test("SPEC-MOT-002/CA-08 — a call allowed then queued, and a switch to planning before it runs: revalidated and refused", async () => {
    const ws: Workspace = workspace();
    const target = join(ws.project, "later.txt");
    const modes = new ModeState("auto_edit", NONE);
    const barrier: Tool<{ id: string }> = {
      name: "slow_step",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      description: () => "barrier",
      flags: () => ({ readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: false }),
      isEnabled: () => true,
      ruleSubject: () => ({ kind: "none" }),
      permissionContribution: () => "allow",
      summary: () => "slow step",
      async execute() {
        await Bun.sleep(30);
        modes.set("planning"); // mode changed while the write waits in the queue
        return textOutcome("step done");
      },
    };
    const registry = ToolRegistry.build({ platform, home: ws.home }, { extraTools: [{ tool: barrier as Tool<never> }] });
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "slow_step", input: { id: "1" } }, { name: "write_file", input: { path: target, content: "x" } }] }, { text: "end" }]);
    const conversation = new Conversation([{ text: "s", cacheBoundary: true }], registry.list().map((t) => ({ name: t.name, description: "d", inputSchema: t.inputSchema })));
    const deps: LoopDeps = {
      provider,
      model: testModel("default"),
      conversation,
      hooks: NEUTRAL_HOOKS,
      maxOutputTokens: 1000,
      thinking: { enabled: false, mode: "adaptive", budgetTokens: 1000, showSummaries: false },
      maxOutputContinuations: 1,
      maxStopHookContinuations: 1,
      emit: () => undefined,
      executor: {
        registry,
        hooks: NEUTRAL_HOOKS,
        authorities: {},
        concurrency: 4,
        toolTimeoutMs: 5000,
        permissionContext: () => ({ mode: modes.mode, rules: [], sessionAllows: [], managedRulesOnly: false, cwd: ws.project, home: ws.home, platform }),
        toolContext: (signal): ToolContext => ({ platform, home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal, ...testToolFields() }) as ToolContext,
      },
    };
    const r = await runTurn(deps, "go", new AbortController().signal);
    expect(r.stopCause).toBe("completed");
    expect(existsSync(target)).toBe(false);
    expect(toolResultTexts(provider, 1)).toEqual(["step done", "Action denied: Planning mode: no modification is allowed."]);
  });
});

describe("SPEC-OUT-001 registry", () => {
  test("SPEC-OUT-001/CA-01 — --toolset read_file,find_files: only these two tools are presented to the model", async () => {
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const r = await cli(["--non-interactive", "--toolset", "read_file,find_files", "x"], workspace(), { provider });
    expect(r.code).toBe(0);
    expect(provider.requests[0]!.tools.map((t) => t.name)).toEqual(["find_files", "read_file"]);
    const all = new ScriptedProvider([{ text: "ok" }]);
    await cli(["--non-interactive", "x"], workspace(), { provider: all });
    const names = all.requests[0]!.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["background_output", "background_stop", "configure", "disband_team", "discover_skills", "edit_file", "fetch_url", "find_files", "form_team", "message_agent", "prune_history", "read_file", "run_workflow", "search_content", "spawn_agent", "update_notebook_cell", "update_todo_list", "use_skill", "work_item_create", "work_item_get", "work_item_list", "work_item_update", "write_file"]));
    // Shell tools depend on the shells detected on the machine.
    expect(names.filter((n) => !["background_output", "background_stop", "configure", "disband_team", "discover_skills", "edit_file", "fetch_url", "find_files", "form_team", "message_agent", "notify_device", "prune_history", "read_file", "run_workflow", "search_content", "spawn_agent", "update_notebook_cell", "update_todo_list", "use_skill", "work_item_create", "work_item_get", "work_item_list", "work_item_update", "write_file"].includes(n)).every((n) => n === "run_shell" || n === "run_powershell" || n === "monitor_process")).toBe(true);
  });

  test("SPEC-OUT-001/CA-05 — a connector exposing read_file: the built-in tool is kept, the connector tool gets its prefix", () => {
    const ws = workspace();
    const foreign = { ...readFileTool, description: () => "connector tool" } as Tool<never>;
    const registry = ToolRegistry.build({ platform, home: ws.home }, { extraTools: [{ tool: foreign, connector: "docs" }] });
    expect(registry.get("read_file")).toBe(readFileTool as Tool<never>);
    expect(registry.get("cnx_docs_read_file")?.description({ platform, home: ws.home })).toBe("connector tool");
  });
});
