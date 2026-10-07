// Hooks: events and payloads (SPEC-HOK-001), configuration (SPEC-HOK-002), command hooks (SPEC-HOK-003), decisions
// (SPEC-HOK-010) and administrator controls (SPEC-HOK-012). Hook commands are small Bun scripts, alike on every system.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_SECRET_VARIABLES } from "../src/config/environment";
import { buildSnapshot, type SnapshotControls } from "../src/hooks/config";
import { currentPlatform } from "../src/platform/system";
import { detectPosixShell } from "../src/tools/shell-runtime";
import { cli, loadIdentity, workspace, type Workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const platform = currentPlatform();
const prefix = loadIdentity().get("ENV_PREFIX");
const hostEnv: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") hostEnv[k] = v;
const POSIX = detectPosixShell(undefined, hostEnv, platform);
const BUN = process.execPath.replace(/\\/g, "/");
const PROJECT_DIR = ".pilote-dev";

function productEnv(ws: Workspace): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(hostEnv)) if (!k.startsWith(prefix) && !PUBLIC_SECRET_VARIABLES.includes(k)) out[k] = v;
  return { ...out, HOME: ws.home, USERPROFILE: ws.home };
}

/** A hook command running `body` (TypeScript, with `payload` read from the standard input) through Bun. */
function hook(ws: Workspace, name: string, body: string): string {
  const path = ws.write(`scripts/${name}.ts`, `const payload = JSON.parse(await Bun.stdin.text());\n${body}\n`).replace(/\\/g, "/");
  return POSIX ? `"${BUN}" "${path}"` : `& "${BUN}" "${path}"`;
}
const record = (ws: Workspace, name: string) => {
  const out = join(ws.root, `${name}.jsonl`).replace(/\\/g, "/");
  return { command: hook(ws, name, `const fs = await import("node:fs"); fs.appendFileSync(${JSON.stringify(out)}, JSON.stringify(payload) + "\\n");`), read: () => (existsSync(out) ? readFileSync(out, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
};
const answer = (ws: Workspace, name: string, response: unknown) => hook(ws, name, `console.log(${JSON.stringify(JSON.stringify(response))});`);
const results = (provider: ScriptedProvider, i: number) =>
  provider.requests[i]!.history.flatMap((m) => (m.role === "user" ? m.parts.filter((p) => p.type === "tool_result") : [])) as unknown as Array<{ isError: boolean; content: Array<{ text: string }> }>;
const run = (ws: Workspace, provider: ScriptedProvider, userConfig: Record<string, unknown>, args: string[] = []) =>
  cli(["--non-interactive", ...args, "x"], ws, { provider, userConfig, env: productEnv(ws) });
const controls = (o: Partial<SnapshotControls> = {}): SnapshotControls => ({ managedOnly: false, noHooks: false, maxTimeoutMs: 600_000, ...o });
const one = (command: string, extra: Record<string, unknown> = {}) => [{ actions: [{ type: "command", command }], ...extra }];

describe("SPEC-HOK-001 events and payloads", () => {
  test.skipIf(!POSIX)("SPEC-HOK-001/CA-01 — a before_tool hook and a run_shell call: toolId is run_shell and the command is in toolArguments", async () => {
    const ws = workspace();
    const r = record(ws, "before");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: "echo hi" } }] }, { text: "done" }]);
    await run(ws, provider, { hooks: { before_tool: [{ match: "run_shell", actions: [{ type: "command", command: r.command }] }] } });
    const [p] = r.read();
    expect(p).toMatchObject({ event: "before_tool", toolId: "run_shell", toolArguments: { command: "echo hi" } });
  });

  test("SPEC-HOK-001/CA-02 — a session_opened hook and a reopened session: source is reopen", async () => {
    const ws = workspace();
    const r = record(ws, "opened");
    const userConfig = { hooks: { session_opened: one(r.command) } };
    const first = await cli(["--non-interactive", "--result-format", "json", "x"], ws, { provider: new ScriptedProvider([{ text: "a" }]), userConfig, env: productEnv(ws) });
    const id = JSON.parse(first.stdout).sessionId as string;
    await cli(["--non-interactive", `--reopen=${id}`, "y"], ws, { provider: new ScriptedProvider([{ text: "b" }]), userConfig, env: productEnv(ws) });
    expect(r.read().map((p) => p.source)).toEqual(["launch", "reopen"]);
  });

  test("SPEC-HOK-001/CA-03 — SPEC-HOK-001/CA-05 — a tool result over the payload limit is cut with the flag; the payload carries transcriptRef and no path of the session store", async () => {
    const ws = workspace();
    const r = record(ws, "after");
    const file = ws.write("project/big.txt", Array.from({ length: 300 }, (_, i) => `line ${i} of the file`).join("\n"));
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "done" }]);
    await run(ws, provider, { hooks: { after_tool: one(r.command) }, hooksConfig: { payloadMaxSize: 1024 } });
    const [p] = r.read();
    expect(Buffer.byteLength(p.toolResult)).toBeLessThanOrEqual(1024);
    expect(p.toolResultTruncated.originalBytes).toBeGreaterThan(1024);
    expect(p.transcriptRef).toMatch(/^session:/);
    expect(JSON.stringify(p)).not.toContain(join(ws.configHome, "sessions").replace(/\\/g, "\\\\"));
    expect(JSON.stringify(p)).not.toContain(realpathSync(ws.configHome).replace(/\\/g, "\\\\"));
  });
});

describe("SPEC-HOK-002 configuration of the hooks", () => {
  test("SPEC-HOK-002/CA-01 — the example declaration: when the model writes a file, the command runs", async () => {
    const ws = workspace();
    const r = record(ws, "format");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: join(ws.project, "new.txt"), content: "x" } }] }, { text: "done" }]);
    await run(ws, provider, { hooks: { after_tool: [{ match: "edit_file|write_file", actions: [{ type: "command", command: r.command, timeout: "30s" }] }] } }, ["--approval-mode", "auto_edit"]);
    expect(r.read()).toHaveLength(1);
  });

  test("SPEC-HOK-002/CA-04 — a folder not approved: no project hook is active", async () => {
    const ws = workspace();
    const r = record(ws, "project");
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ hooks: { session_opened: one(r.command) } }));
    await run(ws, new ScriptedProvider([{ text: "ok" }]), {});
    expect(r.read()).toEqual([]);
    await run(ws, new ScriptedProvider([{ text: "ok" }]), {}, ["--allow-project-trust"]);
    expect(r.read()).toHaveLength(1);
  });

  test("SPEC-HOK-002/CA-03 — a project hook added during the session: it is not active before a validated launch", async () => {
    const ws = workspace();
    const r = record(ws, "late");
    const a = ws.write("project/a.txt", "a\n");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    let written = false;
    const res = await cli(["--non-interactive", "--allow-project-trust", "x"], ws, {
      provider,
      env: productEnv(ws),
      extra: {
        onEvent: (e) => {
          if (e.type !== "tool_result" || written) return;
          written = true;
          ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ hooks: { before_tool: one(r.command) } }));
        },
      },
    });
    expect(res.stderr).toContain("les crochets du projet ont changé pendant la session");
    expect(r.read()).toEqual([]);
  });

  test("SPEC-HOK-002/CA-05 — SPEC-HOK-002/CA-07 — the same identifier in two scopes, a managed mandatory hook and its exact copy in the project: all kept apart, the managed one stays mandatory", () => {
    const decl = (extra: Record<string, unknown>) => ({ before_tool: [{ id: "check", match: "run_shell", actions: [{ type: "command", command: "check" }], ...extra }] });
    const s = buildSnapshot(
      [
        { origin: "managed", value: decl({ mandatory: true }) },
        { origin: "project", value: decl({}) },
        { origin: "user", value: decl({}) },
      ],
      controls(),
    );
    expect(s.declarations.map((d) => [d.label, d.mandatory])).toEqual([
      ["managed/before_tool/check", true],
      ["project/before_tool/check", false],
      ["user/before_tool/check", false],
    ]);
  });

  test("TECH — SPEC-HOK-002/ERR-01, ERR-02, EF-05 — unknown event with a suggestion, action types not delivered, invalid filter", () => {
    const s = buildSnapshot([{ origin: "user", value: { befor_tool: one("x"), after_tool: [{ match: "a b", actions: [{ type: "command", command: "x" }] }, { actions: [{ type: "http", url: "https://x" }] }] } }], controls());
    expect(s.warnings.join("\n")).toContain("Événement de crochet inconnu : befor_tool (portée user). Vouliez-vous dire : before_tool ?");
    expect(s.warnings.join("\n")).toContain("le type « http » n'est pas disponible dans cette version");
    expect(s.ignored.map((i) => i.reason)).toEqual(["filtre invalide : a b", "aucune action utilisable"]);
  });
});

describe("SPEC-HOK-003 command hooks", () => {
  test("SPEC-HOK-003/CA-01 — the hook reads the payload: a JSON object with the common fields of the schema", async () => {
    const ws = workspace();
    const r = record(ws, "payload");
    await run(ws, new ScriptedProvider([{ text: "ok" }]), { hooks: { prompt_submitted: one(r.command) } });
    const [p] = r.read();
    expect(Object.keys(p).sort()).toEqual(["approvalMode", "cwd", "event", "prompt", "schemaVersion", "sessionId", "timestamp", "transcriptRef"]);
    expect(p).toMatchObject({ schemaVersion: 1, event: "prompt_submitted", prompt: "x" });
  });

  test("SPEC-HOK-003/CA-02 — SPEC-HOK-003/CA-03 — a hook ending with code 1: the tool runs and the failure is reported; a blocking answer: the tool does not run", async () => {
    const ws = workspace();
    const a = ws.write("project/a.txt", "alpha\n");
    const failing = hook(ws, "failing", "process.exit(1);");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    const r1 = await run(ws, provider, { hooks: { before_tool: one(failing) } });
    expect(results(provider, 1)[0]!.content[0]!.text).toContain("alpha");
    expect(r1.stderr).toContain("code de sortie 1");
    const blocking = answer(ws, "blocking", { decision: "deny", reason: "reading is closed today" });
    const second = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    const r2 = await run(ws, second, { hooks: { before_tool: [{ id: "gate", actions: [{ type: "command", command: blocking }] }] } });
    expect(results(second, 1)[0]!.isError).toBe(true);
    expect(results(second, 1)[0]!.content[0]!.text).toContain("reading is closed today");
    expect(r2.stderr).toContain("Bloqué par un crochet (before_tool) : user/before_tool/gate : reading is closed today"); // SPEC-HOK-010 EF-05
  });

  test("SPEC-HOK-003/CA-04 — a hook lasting longer than its time limit: it is stopped at the limit", async () => {
    const ws = workspace();
    const slow = hook(ws, "slow", "await Bun.sleep(60_000);");
    const started = Date.now();
    const r = await run(ws, new ScriptedProvider([{ text: "ok" }]), { hooks: { prompt_submitted: [{ actions: [{ type: "command", command: slow, timeout: "1s" }] }] } });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(r.stderr).toContain("arrêté après 1 s");
  }, 30_000);
});

describe("SPEC-HOK-010 decisions of the hooks", () => {
  test("SPEC-HOK-010/CA-01 — SPEC-HOK-010/CA-02 — one hook allows, another denies: refused; a hook allows and a deny rule applies: refused", async () => {
    const ws = workspace();
    const a = ws.write("project/a.txt", "a\n");
    const allow = answer(ws, "allow", { decision: "allow" });
    const deny = answer(ws, "deny", { decision: "deny", reason: "no" });
    const p1 = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    await run(ws, p1, { hooks: { before_tool: [...one(allow), ...one(deny)] } });
    expect(results(p1, 1)[0]!.isError).toBe(true);
    const p2 = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    await run(ws, p2, { hooks: { before_tool: one(allow) } }, ["--deny-rule", "read_file(a.txt)"]);
    expect(results(p2, 1)[0]!.content[0]!.text).toContain("Denied by the rule read_file(a.txt)");
  });

  test.skipIf(!POSIX)("SPEC-HOK-010/CA-03 — SPEC-HOK-010/CA-04 — a hook changes the command: the changed one runs and is shown; session variables from session_opened reach the commands", async () => {
    const ws = workspace();
    const change = answer(ws, "change", { modifiedInput: { command: "echo changed $GREETING" } });
    const env = answer(ws, "env", { sessionEnv: { GREETING: "from-hook" } });
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: "echo original" } }] }, { text: "done" }]);
    const r = await run(ws, provider, { hooks: { before_tool: one(change), session_opened: one(env) } }, ["--allow-rule", "run_shell(echo *)"]);
    expect(results(provider, 1)[0]!.content[0]!.text).toContain("changed from-hook");
    expect(r.stderr).toContain('Paramètres de run_shell modifiés par un crochet : {"command":"echo changed $GREETING"}');
  });

  test("SPEC-HOK-010/CA-05 — SPEC-MOT-001/CA-07 — turn_completed asks to continue: the turn goes on with the reason; a hook that always asks stops at engine.maxStopHookContinuations", async () => {
    const ws = workspace();
    const flag = join(ws.root, "continued").replace(/\\/g, "/");
    const once = hook(ws, "once", `const fs = await import("node:fs"); if (!fs.existsSync(${JSON.stringify(flag)})) { fs.writeFileSync(${JSON.stringify(flag)}, "1"); console.log(JSON.stringify({ decision: "continue", reason: "Also update the changelog." })); }`);
    const p1 = new ScriptedProvider([{ text: "first" }, { text: "second" }]);
    await run(ws, p1, { hooks: { turn_completed: one(once) } });
    expect(p1.requests).toHaveLength(2);
    expect(JSON.stringify(p1.requests[1]!.history.at(-1))).toContain("Also update the changelog.");
    const always = answer(ws, "always", { decision: "continue", reason: "again" });
    const p2 = new ScriptedProvider([{ text: "1" }, { text: "2" }, { text: "3" }, { text: "4" }]);
    await run(ws, p2, { hooks: { turn_completed: one(always) }, engine: { maxStopHookContinuations: 2 } });
    expect(p2.requests).toHaveLength(3);
  });
});

describe("SPEC-HOK-012 administrator controls", () => {
  const decl = (extra: Record<string, unknown> = {}) => ({ prompt_submitted: [{ id: "h", actions: [{ type: "command", command: "x" }], ...extra }] });

  test("SPEC-HOK-012/CA-01 — SPEC-HOK-012/CA-02 — SPEC-HOK-012/CA-05 — SPEC-HOK-012/CA-06 — managedOnly keeps the managed hooks only; user disabling, --no-hooks and managed disabling never remove a managed mandatory hook", () => {
    const sources = [
      { origin: "managed", value: decl({ mandatory: true }) },
      { origin: "project", value: decl() },
      { origin: "user", value: decl() },
    ];
    const labels = (c: SnapshotControls) => buildSnapshot(sources, c).declarations.map((d) => d.label);
    expect(labels(controls({ managedOnly: true }))).toEqual(["managed/prompt_submitted/h"]);
    expect(labels(controls({ disabled: { value: true, origin: "user" } }))).toEqual(["managed/prompt_submitted/h"]);
    expect(labels(controls({ noHooks: true }))).toEqual(["managed/prompt_submitted/h"]);
    expect(labels(controls({ disabled: { value: true, origin: "managed" } }))).toEqual(["managed/prompt_submitted/h"]);
    const optional = buildSnapshot([{ origin: "managed", value: decl() }], controls({ disabled: { value: true, origin: "managed" } }));
    expect(optional.ignored).toEqual([{ label: "managed/prompt_submitted/h", reason: "crochets facultatifs désactivés par l'administrateur" }]); // EF-03
  });

  test("SPEC-HOK-012/CA-03 — --no-hooks: no hook outside the managed scope runs", async () => {
    const ws = workspace();
    const r = record(ws, "user");
    await run(ws, new ScriptedProvider([{ text: "ok" }]), { hooks: { prompt_submitted: one(r.command) } }, ["--no-hooks"]);
    expect(r.read()).toEqual([]);
  });

  test("SPEC-HOK-012/CA-04 — a managed mandatory hook that fails: the action it frames is refused", async () => {
    const ws = workspace();
    const a = ws.write("project/a.txt", "a\n");
    const failing = hook(ws, "control", "process.exit(3);");
    ws.write("managed/policy.json", JSON.stringify({ hooks: { before_tool: [{ id: "control", mandatory: true, actions: [{ type: "command", command: failing }] }] } }));
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    await run(ws, provider, {});
    expect(results(provider, 1)[0]!.isError).toBe(true);
    expect(results(provider, 1)[0]!.content[0]!.text).toContain("contrôle obligatoire managed/before_tool/control indisponible");
  });
});

describe("SPEC-CFG-005 settings_modified", () => {
  test("SPEC-CFG-005/CA-04 — a settings_modified hook: it receives the list of the changed keys", async () => {
    const ws = workspace();
    const r = record(ws, "settings");
    const a = ws.write("project/a.txt", "a\n");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    let written = false;
    await cli(["--non-interactive", "x"], ws, {
      provider,
      env: productEnv(ws),
      userConfig: { hooks: { settings_modified: one(r.command) } },
      extra: {
        onEvent: (e) => {
          if (e.type !== "tool_result" || written) return;
          written = true;
          const path = join(ws.configHome, "config.json");
          const config = JSON.parse(readFileSync(path, "utf8"));
          writeFileSync(path, JSON.stringify({ ...config, models: { ...config.models, effort: "low" } }));
        },
      },
    });
    expect(r.read()).toMatchObject([{ event: "settings_modified", keys: ["models.effort"], scope: "user" }]);
  });
});
