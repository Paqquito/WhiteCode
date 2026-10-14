// run_shell and run_powershell, environment of child processes, compound commands, large results, cancellation.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EnvironmentView, PUBLIC_SECRET_VARIABLES } from "../src/config/environment";
import { Conversation } from "../src/engine/conversation";
import { runTurn, type LoopDeps } from "../src/engine/loop";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";
import { splitCommand } from "../src/permissions/command-split";
import { decide } from "../src/permissions/engine";
import { dangerousPowerShell } from "../src/permissions/powershell-danger";
import type { HumanAnswer } from "../src/permissions/resolver";
import { isRule, parseRule, ruleMatches, type Rule } from "../src/permissions/rules";
import { processExists } from "../src/platform/process";
import { currentPlatform } from "../src/platform/system";
import { ResultStore } from "../src/session/result-store";
import { readFileTool } from "../src/tools/read-file";
import { ToolRegistry } from "../src/tools/registry";
import { runPowerShellTool, runShellTool } from "../src/tools/run-shell";
import { detectPosixShell, detectPowerShell, ShellRuntime, type ShellSettings } from "../src/tools/shell-runtime";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome } from "../src/tools/types";
import { cli, loadIdentity, testModel, testToolFields, workspace, type Workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const platform = currentPlatform();
const identity = loadIdentity();
const prefix = identity.get("ENV_PREFIX");
const hostEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") hostEnv[k] = v;
const POSIX = detectPosixShell(undefined, hostEnv, platform);
const PWSH = detectPowerShell(undefined, platform);
const BUN = process.execPath.replace(/\\/g, "/");
const SETTINGS: ShellSettings = { defaultTimeoutMs: 60_000, maxTimeoutMs: 1_200_000, outputLimit: 24_000, graceMs: 1_000, powershellLoadProfile: false };

/** Environment given to the product in end-to-end tests: the host one (for PATH), with the workspace home. */
function productEnv(ws: Workspace, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(hostEnv)) if (!k.startsWith(prefix) && !PUBLIC_SECRET_VARIABLES.includes(k)) out[k] = v;
  return { ...out, HOME: ws.home, USERPROFILE: ws.home, ...extra };
}

function runtime(ws: Workspace, settings: Partial<ShellSettings> = {}, extraEnv: Record<string, string> = {}): ShellRuntime {
  const view = new EnvironmentView(prefix, productEnv(ws, extraEnv));
  return new ShellRuntime({
    platform,
    projectCwd: ws.project,
    allowedDirectories: [ws.project],
    childEnv: view.childEnvironment({}),
    forcedVariables: { [`${prefix}CHILD_PROCESS`]: "1" },
    excluded: (n) => n.startsWith(prefix) || PUBLIC_SECRET_VARIABLES.includes(n),
    posix: POSIX,
    powershell: PWSH,
    workDir: join(ws.root, "session", "shell"),
    settings: { ...SETTINGS, ...settings },
    store: new ResultStore(join(ws.root, "session", "tool-results")),
  });
}

function ctx(ws: Workspace, shell: ShellRuntime, signal = new AbortController().signal): ToolContext {
  return { platform, home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal, shell, ...testToolFields() } as ToolContext;
}
const text = (o: ToolOutcome) => o.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const sh = (ws: Workspace, shell: ShellRuntime, command: string, timeout?: number) => runShellTool.execute({ command, timeout }, ctx(ws, shell));
const ps = (ws: Workspace, shell: ShellRuntime, command: string) => runPowerShellTool.execute({ command }, ctx(ws, shell));

function rule(raw: string, decision: "allow" | "ask" | "deny", scope: Rule["scope"] = "user"): Rule {
  const r = parseRule(raw, decision, scope, "/");
  if (!isRule(r)) throw new Error(r.message);
  return r;
}
const matches = (raw: string, decision: "allow" | "deny", command: string, tool = "run_shell") =>
  ruleMatches(rule(raw, decision), tool, { kind: "command", command }, { cwd: "/", home: "/", platform });

describe.skipIf(!POSIX)("SPEC-OUT-008 run_shell", () => {
  test("SPEC-OUT-008/CA-01 — cd into a sub-folder then pwd, in two calls: the second shows the sub-folder", async () => {
    const ws = workspace();
    ws.write("project/sub/keep.txt", "x");
    const shell = runtime(ws);
    expect(text(await sh(ws, shell, "cd sub"))).toBe("(no output)");
    expect(text(await sh(ws, shell, "pwd")).trim()).toEndWith("/sub");
    expect(shell.cwd.replace(/\\/g, "/")).toEndWith("/sub");
  });

  test("SPEC-OUT-008/CA-02 — a command returning code 2: the result gives code 2 and is not a tool error", async () => {
    const ws = workspace();
    const r = await sh(ws, runtime(ws), "echo before; exit 2");
    expect(r.isError).toBe(false);
    expect(text(r)).toBe("before\n\n[Exit code 2.]");
  });

  test("SPEC-OUT-008/CA-03 — a long command with the default time limit is stopped with the time-limit notice", async () => {
    const ws = workspace();
    const started = Date.now();
    const r = await sh(ws, runtime(ws, { defaultTimeoutMs: 1_500 }), "echo started; sleep 600");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("started");
    expect(text(r)).toContain("Command stopped after 2 s (time limit)");
  }, 30_000);

  test("SPEC-OUT-008/CA-04 — 1 MB of output: the model gets the beginning and the end (24,000 characters at most) and the path of the complete output", async () => {
    const ws = workspace();
    const r = await sh(ws, runtime(ws), "yes 'line of output text 0123456789' | head -n 34000; echo LAST-LINE");
    const out = text(r);
    const body = out.split("\n\n[Output truncated")[0]!;
    expect(body.length).toBeLessThanOrEqual(24_100);
    expect(body.startsWith("line of output text 0123456789")).toBe(true);
    expect(body.trimEnd().endsWith("LAST-LINE")).toBe(true);
    expect(body).toContain("lines omitted");
    const path = /complete output is in (.+?) \(readable/.exec(out)![1]!;
    expect(readFileSync(path, "utf8").length).toBeGreaterThan(1_000_000);
  }, 60_000);

  test("SPEC-OUT-008/CA-06 — an alias defined in the profile of the user's shell works", async () => {
    const ws = workspace();
    ws.write("home/.bashrc", "alias greet='echo hello-from-alias'\nsay_twice() { echo \"$1$1\"; }\n");
    ws.write("home/.zshrc", "alias greet='echo hello-from-alias'\nsay_twice() { echo \"$1$1\"; }\n");
    const shell = runtime(ws);
    expect(text(await sh(ws, shell, "greet"))).toBe("hello-from-alias");
    expect(text(await sh(ws, shell, "say_twice ab"))).toBe("abab");
  }, 30_000);

  test("SPEC-OUT-008/CA-07 — cd / while / is not allowed: the working folder is reset and the model is told", async () => {
    const ws = workspace();
    const shell = runtime(ws);
    const r = await sh(ws, shell, "cd /");
    expect(text(r)).toContain("Working directory reset to");
    expect(text(r)).toContain("outside the allowed folders");
    expect(shell.cwd).toBe(ws.project);
  });

  test("TECH — SPEC-OUT-008/EF-11 and SPEC-CFG-007/RG-02 — CHILD_PROCESS=1 is set; product variables are not passed on", async () => {
    const ws = workspace();
    const shell = runtime(ws, {}, { [`${prefix}DEBUG`]: "1" });
    const out = text(await sh(ws, shell, `echo "child=$${prefix}CHILD_PROCESS debug=$${prefix}DEBUG"`));
    expect(out).toBe("child=1 debug=");
  });

  test("TECH — SPEC-OUT-008/§ 11 — the file named by SHELL_INIT_FILE is sourced before each command", async () => {
    const ws = workspace();
    const init = ws.write("init.sh", "export FROM_INIT=yes\n");
    const view = new EnvironmentView(prefix, productEnv(ws));
    const shell = new ShellRuntime({ ...runtime(ws).options, childEnv: view.childEnvironment({}), initFile: init });
    expect(text(await sh(ws, shell, "echo $FROM_INIT"))).toBe("yes");
  });

  test("TECH — SPEC-OUT-008/EF-06, ENF-03 — cancellation stops the whole process tree", async () => {
    const ws = workspace();
    const shell = runtime(ws);
    const pidFile = join(ws.root, "pid.txt").replace(/\\/g, "/");
    const controller = new AbortController();
    const running = runShellTool.execute({ command: `"${BUN}" -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 60000)"` }, ctx(ws, shell, controller.signal));
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(100);
    const pid = Number(readFileSync(pidFile, "utf8"));
    expect(processExists(pid)).toBe(true);
    controller.abort();
    const r = await running;
    expect(text(r)).toContain("Command interrupted.");
    for (let i = 0; i < 40 && processExists(pid); i++) await Bun.sleep(100);
    expect(processExists(pid)).toBe(false);
  }, 30_000);
});

describe.skipIf(!POSIX)("SPEC-CFG-007 environment of the commands", () => {
  const shellCall = (command: string) => ({ toolCalls: [{ name: "run_shell", input: { command } }] });
  const lastResult = (p: ScriptedProvider) =>
    p.requests[1]!.history.flatMap((m) => (m.role === "user" ? m.parts.flatMap((x) => (x.type === "tool_result" ? x.content.map((c) => (c.type === "text" ? c.text : "")) : [])) : [])).join("\n");

  test("SPEC-CFG-007/CA-02 — ANTHROPIC_API_KEY defined: env run through run_shell does not show it, even when the profile exports it", async () => {
    const ws = workspace();
    ws.write("home/.bashrc", "export OPENAI_API_KEY=profile-secret-value\n");
    ws.write("home/.zshrc", "export OPENAI_API_KEY=profile-secret-value\n");
    const provider = new ScriptedProvider([shellCall("env"), { text: "ok" }]);
    const r = await cli(["--non-interactive", "--allow-rule", "run_shell(env)", "go"], ws, { provider, env: productEnv(ws, { ANTHROPIC_API_KEY: "sk-secret-test-value" }) });
    expect(r.code).toBe(0);
    const out = lastResult(provider);
    expect(out).toContain(`${prefix}CHILD_PROCESS=1`);
    expect(out).not.toContain("sk-secret-test-value");
    expect(out).not.toContain("profile-secret-value");
  }, 60_000);

  test("SPEC-CFG-007/CA-03 — environment.variables {FOO: 1} in the settings: echo $FOO prints 1", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([shellCall("echo $FOO"), { text: "ok" }]);
    await cli(["--non-interactive", "--allow-rule", "run_shell(echo *)", "go"], ws, { provider, env: productEnv(ws), userConfig: { environment: { variables: { FOO: "1" } } } });
    expect(lastResult(provider)).toBe("1");
  }, 60_000);

  test("SPEC-CFG-007/CA-05 — environment.variables setting PATH in the project settings: ignored with a warning, the user's environment applies", async () => {
    const ws = workspace();
    ws.write(`project/${identity.get("PROJECT_DIR")}/config.json`, JSON.stringify({ environment: { variables: { PATH: "/project/only/bin" } } }));
    const provider = new ScriptedProvider([shellCall("echo $PATH"), { text: "ok" }]);
    const r = await cli(["--non-interactive", "--allow-project-trust", "--allow-rule", "run_shell(echo *)", "go"], ws, { provider, env: productEnv(ws) });
    expect(r.stderr).toContain("environment.variables");
    expect(lastResult(provider)).not.toContain("/project/only/bin");
    expect(lastResult(provider).length).toBeGreaterThan(0);
  }, 60_000);
});

describe("SPEC-PER-002 rules for commands", () => {
  test("SPEC-PER-002/CA-01 — allow run_shell(git log *) covers git log --oneline", () => {
    expect(matches("run_shell(git log *)", "allow", "git log --oneline")).toBe(true);
  });

  test("SPEC-PER-002/CA-02 — the same rule does not cover git logout", () => {
    expect(matches("run_shell(git log *)", "allow", "git logout")).toBe(false);
  });

  test("SPEC-PER-002/CA-03 — allow run_shell(npm test) does not cover npm test && curl http://x", () => {
    expect(matches("run_shell(npm test)", "allow", "npm test && curl http://x")).toBe(false);
    expect(matches("run_shell(npm test)", "allow", "npm test")).toBe(true);
    expect(matches("run_shell(curl *)", "deny", "npm test && curl http://x")).toBe(true);
  });

  test("SPEC-PER-002/CA-07 — allow run_shell(npm test) does not cover sudo npm test", () => {
    expect(matches("run_shell(npm test)", "allow", "sudo npm test")).toBe(false);
    expect(matches("run_shell(npm test)", "allow", "env npm test")).toBe(false);
    expect(matches("run_shell(npm test)", "allow", "CI=1 npm test")).toBe(true); // leading assignment ignored (§ 8)
  });

  test("E-008 — prudent splitting: unrecognised constructions are never covered by allow, nested commands count for deny", () => {
    expect(splitCommand("a && b || c; d | e & f", "posix")).toEqual({ parts: ["a", "b", "c", "d", "e", "f"], nested: [], complete: true });
    expect(splitCommand("echo 'x && y' \"a;b\"", "posix").parts).toEqual(["echo 'x && y' \"a;b\""]);
    expect(splitCommand("echo $(git push origin)", "posix")).toMatchObject({ nested: ["git push origin"], complete: false });
    expect(splitCommand("cat <<EOF\nrm -rf /\nEOF", "posix").complete).toBe(false);
    expect(splitCommand("npm test > out.txt", "posix").complete).toBe(false);
    expect(splitCommand("npm test 2>&1 >/dev/null", "posix").complete).toBe(true);
    expect(matches("run_shell(npm test *)", "allow", "npm test > out.txt")).toBe(false);
    expect(matches("run_shell(git push *)", "deny", "echo $(git push origin)")).toBe(true);
    expect(matches("run_shell(git push *)", "deny", "(cd x && git push origin)")).toBe(true);
    expect(splitCommand("Get-Item x; $(Remove-Item y)", "powershell")).toMatchObject({ parts: ["Get-Item x", "$(Remove-Item y)"], nested: ["Remove-Item y"], complete: false });
    expect(matches("run_powershell(Get-ChildItem *)", "allow", "Get-ChildItem . | Where-Object { $_.Length -gt 1 }", "run_powershell")).toBe(false);
  });
});

describe("SPEC-PER-001 commands and modes", () => {
  const flags = { readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: true };
  const base = { sessionAllows: [], managedRulesOnly: false, cwd: "/", home: "/", platform };

  test("SPEC-PER-001/CA-01 — deny run_shell(git push *) and unrestricted mode: git push origin main is refused", async () => {
    const q = { toolName: "run_shell", subject: { kind: "command" as const, command: "git push origin main" }, flags, available: true };
    expect(decide(q, { ...base, mode: "unrestricted", rules: [rule("run_shell(git push *)", "deny")] })).toMatchObject({ kind: "deny", step: 1 });
    if (!POSIX) return;
    const ws = workspace();
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: "git push origin main" } }] }, { text: "ok" }]);
    await cli(["--non-interactive", "--allow-unrestricted-mode", "--approval-mode", "unrestricted", "--deny-rule", "run_shell(git push *)", "go"], ws, { provider, env: productEnv(ws) });
    const result = provider.requests[1]!.history.flatMap((m) => (m.role === "user" ? m.parts.filter((p) => p.type === "tool_result") : []))[0] as unknown as { content: Array<{ text: string }> };
    expect(result.content[0]!.text).toContain("Action denied: Denied by the rule run_shell(git push *)");
  }, 60_000);

  test("D-02 — without an allow rule a command that is not read-only is asked, auto_edit included (read-only commands: SPEC-PER-008, E-109)", () => {
    const ctx = { cwd: "/", allowedDirectories: ["/"], platform: "linux" } as unknown as ToolContext;
    const q = { toolName: "run_shell", subject: { kind: "command" as const, command: "npm install" }, flags, available: true, contribution: runShellTool.permissionContribution?.({ command: "npm install" }, ctx) };
    expect(decide(q, { ...base, mode: "auto_edit", rules: [] })).toMatchObject({ kind: "ask", step: 8 });
    expect(decide(q, { ...base, mode: "ask", rules: [rule("run_shell(npm install)", "allow")] })).toMatchObject({ kind: "allow", step: 6 });
    expect(runShellTool.flags({ command: "npm install" }).concurrencySafe).toBe(false);
  });
});

describe("SPEC-OUT-009 run_powershell", () => {
  test("SPEC-OUT-009/CA-01 — with PowerShell 5.1 only, the description gives the edition and its syntax limits", () => {
    const env = { platform, home: "/", shells: { powershell: { path: "powershell.exe", edition: "5.1" as const } } };
    const d = runPowerShellTool.description(env);
    expect(d).toContain("Edition: Windows PowerShell 5.1.");
    expect(d).toContain("no pipeline chain operators (`&&`, `||`)");
    expect(runPowerShellTool.description({ ...env, shells: { powershell: { path: "pwsh", edition: "7" } } })).toContain("PowerShell 7 or later");
    expect(runPowerShellTool.isEnabled({ platform, home: "/" })).toBe(false); // FA-01
    const registry = ToolRegistry.build({ platform, home: "/", shells: {} });
    expect(registry.get("run_powershell")).toBeUndefined();
    expect(registry.get("run_shell")).toBeUndefined(); // ERR-02 of SPEC-OUT-008
  });

  test("SPEC-OUT-009/CA-03 — a recursive delete cmdlet in auto_edit mode: a confirmation is asked", async () => {
    expect(dangerousPowerShell("Remove-Item -Recurse -Force .\\build")).toContain("remove-item");
    expect(dangerousPowerShell("Get-ChildItem; rm x -r")).toContain("rm");
    expect(dangerousPowerShell("Set-ItemProperty -Path HKCU:\\Software\\X -Name a -Value 1")).toContain("registry");
    expect(dangerousPowerShell("Get-ChildItem -Recurse")).toBeUndefined();
    const flags = runPowerShellTool.flags({ command: "x" });
    const q = (command: string) => ({ toolName: "run_powershell", subject: { kind: "command" as const, command }, flags, available: true, contribution: runPowerShellTool.permissionContribution!({ command }, {} as ToolContext) });
    const base = { sessionAllows: [], managedRulesOnly: false, cwd: "/", home: "/", platform };
    // Even an allow rule does not lift it (step 5 comes before step 6); unrestricted does (RG-01).
    expect(decide(q("Remove-Item -Recurse build"), { ...base, mode: "auto_edit", rules: [rule("run_powershell(Remove-Item *)", "allow")] })).toMatchObject({ kind: "ask", step: 5, origin: "tool_check" });
    expect(decide(q("Remove-Item -Recurse build"), { ...base, mode: "unrestricted", rules: [] })).toMatchObject({ kind: "allow" });
    if (!PWSH) return;
    const ws = workspace();
    ws.write("project/build/a.txt", "x");
    const asked: string[] = [];
    const human = {
      async request(r: { summary: string }): Promise<HumanAnswer> {
        asked.push(r.summary);
        return { answer: "no" };
      },
    };
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_powershell", input: { command: "Remove-Item -Recurse -Force build" } }] }, { text: "ok" }]);
    await cli(["--non-interactive", "--approval-mode", "auto_edit", "go"], ws, { provider, env: productEnv(ws), extra: { authorities: { human } } });
    expect(asked).toEqual(["Run: remove-item -Recurse -Force build"]); // SPEC-PER-005: normalized cmdlet, arguments unchanged.
    expect(existsSync(join(ws.project, "build", "a.txt"))).toBe(true);
  }, 60_000);

  test.skipIf(!PWSH)("SPEC-OUT-009/CA-04 — a native program writing on its error output and returning 0: success", async () => {
    const ws = workspace();
    const r = await ps(ws, runtime(ws), `& '${BUN}' -e "console.error('a warning'); console.log('done')"`);
    expect(r.isError).toBe(false);
    expect(text(r)).toContain("done");
    expect(text(r)).not.toContain("Exit code");
  }, 60_000);

  test.skipIf(!PWSH)("SPEC-OUT-009/CA-05 — an output with accented characters is decoded correctly", async () => {
    const ws = workspace();
    const r = await ps(ws, runtime(ws), "Write-Output 'éèàçü — ÉÈ œ'");
    expect(text(r)).toBe("éèàçü — ÉÈ œ");
  }, 60_000);

  test.skipIf(!PWSH)("TECH — SPEC-OUT-009 — working folder kept, exit codes and syntax errors reported", async () => {
    const ws = workspace();
    ws.write("project/sub/f.txt", "x");
    const shell = runtime(ws);
    await ps(ws, shell, "Set-Location sub");
    expect(text(await ps(ws, shell, "(Get-Location).Path")).replace(/\\/g, "/")).toEndWith("/sub");
    expect(text(await ps(ws, shell, "exit 3"))).toContain("Exit code 3.");
    const syntax = await ps(ws, shell, "if ( {");
    expect(text(syntax)).toContain("Syntax error");
  }, 60_000);
});

describe("SPEC-OUT-001 and SPEC-MOT-002 execution limits", () => {
  function engine(ws: Workspace, tools: Tool<never>[], script: ConstructorParameters<typeof ScriptedProvider>[0], extra: Partial<LoopDeps["executor"]> = {}, shell?: ShellRuntime) {
    const registry = ToolRegistry.build({ platform, home: ws.home, shells: shell ? { posix: POSIX, powershell: PWSH } : {} }, { extraTools: tools.map((tool) => ({ tool })) });
    const provider = new ScriptedProvider(script);
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
        permissionContext: () => ({ mode: "unrestricted", rules: [], sessionAllows: [], managedRulesOnly: false, cwd: ws.project, home: ws.home, platform }),
        toolContext: (signal): ToolContext => ({ platform, home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal, shell, ...testToolFields() }) as ToolContext,
        ...extra,
      },
    };
    return { deps, provider };
  }
  const results = (p: ScriptedProvider, i = 1) => p.requests[i]!.history.flatMap((m) => (m.role === "user" ? m.parts.filter((x) => x.type === "tool_result") : [])) as unknown as Array<{ isError: boolean; content: Array<{ text: string }> }>;
  const probe = (name: string, run: (signal: AbortSignal) => Promise<ToolOutcome>, readOnly = true): Tool<never> =>
    ({
      name,
      inputSchema: { type: "object", properties: {} },
      description: () => name,
      flags: () => ({ readOnly, concurrencySafe: readOnly, destructive: false, requiresPermission: false, openWorld: false }),
      isEnabled: () => true,
      ruleSubject: () => ({ kind: "none" }),
      summary: () => name,
      execute: (_: unknown, c: ToolContext) => run(c.signal),
    }) as unknown as Tool<never>;

  test("SPEC-OUT-001/CA-03 — a result of 200,000 characters: the model gets a preview and a path, and can read the file", async () => {
    const ws = workspace();
    const store = new ResultStore(join(ws.root, "session", "tool-results"));
    const big = Array.from({ length: 2000 }, (_, i) => `row ${String(i).padStart(4, "0")} ${"x".repeat(94)}`).join("\n");
    expect(big.length).toBeGreaterThanOrEqual(200_000);
    const { deps, provider } = engine(ws, [probe("big_result", async () => textOutcome(big))], [{ toolCalls: [{ name: "big_result", input: {} }] }, { text: "ok" }], { largeResults: { store, limit: 40_000 } });
    await runTurn(deps, "go", new AbortController().signal);
    const got = results(provider)[0]!.content[0]!.text;
    expect(got.length).toBeLessThan(5_000);
    expect(got).toStartWith("row 0000");
    expect(got).toContain("row 1999");
    const path = /complete result is in (.+?) \(readable/.exec(got)![1]!;
    const c = { platform, home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], extraReadableDirectories: [store.dir], signal: new AbortController().signal, ...testToolFields() } as ToolContext;
    expect(readFileTool.permissionContribution!({ path }, c)).toBe("allow");
    const read = await readFileTool.execute({ path, offset: 1000, limit: 1 }, c);
    expect(text(read)).toContain("1000\trow 0999");
  });

  test("SPEC-MOT-002/CA-05 — a call beyond its time limit is cancelled and gets a time-limit result", async () => {
    const ws = workspace();
    const hang = probe("hang", (signal) => new Promise((resolve) => signal.addEventListener("abort", () => resolve(textOutcome("stopped", true)))));
    const { deps, provider } = engine(ws, [hang], [{ toolCalls: [{ name: "hang", input: {} }] }, { text: "ok" }], { toolTimeoutMs: 200 });
    await runTurn(deps, "go", new AbortController().signal);
    expect(results(provider)[0]).toMatchObject({ isError: true, content: [{ text: "Timed out after 0 s." }] });
  });

  test.skipIf(!POSIX)("SPEC-MOT-002/CA-06 — three calls in progress and an interruption: each gets a result and no process survives the grace period", async () => {
    const ws = workspace();
    const shell = runtime(ws, { graceMs: 500 });
    const pidFile = join(ws.root, "pid.txt").replace(/\\/g, "/");
    const command = `"${BUN}" -e "require('fs').writeFileSync('${pidFile}', String(process.pid)); setTimeout(() => {}, 60000)"`;
    const call = { name: "run_shell", input: { command } };
    const { deps, provider } = engine(ws, [], [{ toolCalls: [call, call, call] }, { text: "never" }], {}, shell);
    const controller = new AbortController();
    const turn = runTurn(deps, "go", controller.signal);
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await Bun.sleep(100);
    const pid = Number(readFileSync(pidFile, "utf8"));
    controller.abort();
    const r = await turn;
    expect(r.stopCause).toBe("interrupted");
    expect(provider.requests).toHaveLength(1);
    await Bun.sleep(600);
    expect(processExists(pid)).toBe(false);
    // The three calls have a result in the history.
    const last = deps.conversation.messages[deps.conversation.messages.length - 1];
    expect(last?.role === "user" ? last.parts.filter((p) => p.type === "tool_result").length : 0).toBe(3);
  }, 60_000);
});
