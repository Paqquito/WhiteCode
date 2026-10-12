// Auto-approval through the CLI, with a simulated model and real tool effects.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { BUN, productEnv } from "./helpers/hooks";
import type { ModeState } from "../src/permissions/modes";
import { PermissionDenials } from "../src/permissions/auto-approve";
import { ReminderCenter } from "../src/engine/reminders";
import { ExitCode } from "../src/cli/exit-codes";

const consent = { permissions: { autoApprove: { orgConsent: true } } };
const permit = (ws: ReturnType<typeof workspace>, policy: Record<string, unknown> = consent) => ws.write("managed/policy.json", JSON.stringify(policy));
const modeArgs = ["--non-interactive", "--approval-mode", "auto_approve", "go"];
const main = (p: ScriptedProvider) => p.requests.filter((r) => r.purpose !== "side");
const quotePosix = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";

test("SPEC-PER-004/CA-02 — SPEC-PER-001/CA-17 — a block returns its reason to the model, without consulting a human, hook or delegate", async () => {
  const ws = workspace(); permit(ws);
  const path = `${ws.project}/blocked.txt`;
  const p = new ScriptedProvider([
    { toolCalls: [{ name: "write_file", input: { path, content: "blocked" } }] },
    { text: JSON.stringify({ decision: "block", reason: "The request would expose private data." }) },
    { text: "refused" },
  ]);
  let others = 0;
  const r = await cli(modeArgs, ws, { provider: p, extra: { authorities: {
    human: { request: async () => { others++; return { answer: "yes" }; } },
    delegate: { decide: async () => { others++; return "allow"; } },
    habilitatedHook: { decide: async () => { others++; return "allow"; } },
  } } });
  expect(r.code).toBe(0);
  expect(others).toBe(0);
  expect(existsSync(path)).toBe(false);
  expect(JSON.stringify(main(p)[1]?.history)).toContain("The request would expose private data.");
  expect(p.requests.filter((q) => q.purpose === "side")).toHaveLength(1);
  expect(r.stderr).toContain("block");
});

test("SPEC-PER-004/CA-04 — SPEC-PER-001/CA-16 — an unreadable classifier answer without a human refuses the action", async () => {
  const ws = workspace(); permit(ws);
  const path = `${ws.project}/unavailable.txt`;
  const p = new ScriptedProvider([
    { toolCalls: [{ name: "write_file", input: { path, content: "never" } }] },
    { text: "allow, probably" }, { text: "finished" },
  ]);
  const r = await cli(modeArgs, ws, { provider: p });
  expect(r.code).toBe(0); expect(existsSync(path)).toBe(false);
  expect(JSON.stringify(main(p)[1]?.history)).toContain("unavailable");
});

test("SPEC-PER-004/CA-05 — SPEC-PER-001/CA-14 — an explicit ask reaches the human without a classifier request", async () => {
  const ws = workspace(); permit(ws);
  const path = `${ws.project}/human.txt`;
  const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "human approval" } }] }, { text: "done" }]);
  let human = 0;
  const r = await cli(modeArgs, ws, { provider: p, userConfig: { permissions: { askRules: ["write_file"] } }, extra: { authorities: { human: { request: async (request) => {
    human++; expect(request.origin).toBe("explicit"); return { answer: "yes" };
  } } } } });
  expect(r.code).toBe(0); expect(human).toBe(1);
  expect(p.requests.filter((q) => q.purpose === "side")).toHaveLength(0);
  expect(readFileSync(path, "utf8")).toBe("human approval");
});

test("SPEC-PER-001/CA-29 — a managed ask keeps its origin and never consults the classifier", async () => {
  const ws = workspace(); permit(ws, { permissions: { autoApprove: { orgConsent: true }, askRules: ["write_file"] } });
  const path = `${ws.project}/managed.txt`;
  const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "managed approval" } }] }, { text: "done" }]);
  let human = 0;
  const r = await cli(modeArgs, ws, { provider: p, extra: { authorities: { human: { request: async (request) => {
    human++; expect(request.origin).toBe("managed"); return { answer: "no" };
  } } } } });
  expect(r.code).toBe(0); expect(human).toBe(1); expect(existsSync(path)).toBe(false);
  expect(p.requests.filter((q) => q.purpose === "side")).toHaveLength(0);
});

test("SPEC-PER-004/CA-03 — SPEC-PER-001/CA-15 — an unavailable classifier explains why the human must decide, without consulting another automatic authority", async () => {
  const ws = workspace(); permit(ws);
  const path = `${ws.project}/${loadIdentity().get("INSTRUCTIONS_FILE")}`;
  const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "human decided" } }] }, { text: "invalid response" }, { text: "done" }]);
  let human = 0, automatic = 0;
  const r = await cli(modeArgs, ws, { provider: p, extra: { authorities: {
    human: { request: async (request) => { human++; expect(request.origin).toBe("tool_check"); expect(request.reason).toContain("unavailable"); return { answer: "yes" }; } },
    delegate: { decide: async () => { automatic++; return "allow"; } },
    habilitatedHook: { decide: async () => { automatic++; return "allow"; } },
  } } });
  expect(r.code).toBe(0); expect(human).toBe(1); expect(automatic).toBe(0);
  expect(readFileSync(path, "utf8")).toBe("human decided");
});

test("SPEC-PER-018/CA-01 — the first activation waits for human consent before any model request", async () => {
  const ws = workspace(), p = new ScriptedProvider([{ text: "ready" }]);
  const abort = new AbortController();
  const run = interactive(["--approval-mode", "auto_approve"], ws, { provider: p, signal: abort.signal });
  try {
    await run.waitFor((t) => t.includes("Consentement") && t.includes("classifieur"), "versioned consent");
    expect(p.requests).toHaveLength(0);
    await sleep(370); run.type("o"); await run.idle();
    run.type("hello" + KEY.enter); await run.waitFor((t) => t.includes("ready"));
    expect(p.requests[0]?.purpose ?? "main").toBe("main");
    run.type("/exit" + KEY.enter); expect((await run.done).code).toBe(0);
    expect(JSON.parse(readFileSync(`${ws.configHome}/state.json`, "utf8")).autoApproveConsent.version).toBe(1);
  } finally { abort.abort(); await run.done; }
});

test("TECH — no prior consent, a refusal, or a project consent cannot activate auto_approve", async () => {
  const ws = workspace(), p = new ScriptedProvider([]);
  ws.write(`project/${loadIdentity().get("PROJECT_DIR")}/config.json`, JSON.stringify(consent));
  const r = await cli([...modeArgs, "--allow-project-trust"], ws, { provider: p, userConfig: consent });
  expect(r.code).toBe(2); expect(r.stderr).toContain("consentement"); expect(p.requests).toHaveLength(0);
});

test("SPEC-PER-004/CA-01 — a generic interpreter allow is neutralized in auto_approve and restored when the session returns to ask", async () => {
  const ws = workspace(); permit(ws);
  const one = `${ws.project}/one.txt`, two = `${ws.project}/two.txt`;
  const script = (path: string) => `${quotePosix(BUN)} -e ${quotePosix(`require('node:fs').writeFileSync(${JSON.stringify(path.replace(/\\/g, "/"))}, 'executed')`)}`;
  let modes: ModeState | undefined;
  const p = new ScriptedProvider([
    { toolCalls: [{ name: "run_shell", input: { command: script(one) } }] },
    { text: JSON.stringify({ decision: "allow", reason: "An explicit test of the requested file creation." }) },
    () => { modes!.set("ask"); return { toolCalls: [{ name: "run_shell", input: { command: script(two) } }] }; },
    { text: "done" },
  ]);
  const r = await cli(modeArgs, ws, { provider: p, env: productEnv(ws), userConfig: { permissions: { allowRules: [`run_shell(${quotePosix(BUN)} *)`] } }, extra: { onSession: (s) => { modes = s.modes; } } });
  expect(r.code).toBe(0);
  expect(readFileSync(one, "utf8")).toBe("executed");
  expect(JSON.stringify(main(p)[2]?.history)).not.toContain("Nobody can approve");
  expect(readFileSync(two, "utf8")).toBe("executed");
  expect(p.requests.filter((q) => q.purpose === "side")).toHaveLength(1);
});

test("SPEC-PER-018/CA-02 — an older consent version requires a new dialog before activation", async () => {
  const ws = workspace(); ws.write("home/config/state.json", JSON.stringify({ autoApproveConsent: { version: 0, at: "2026-09-01T00:00:00.000Z" } }));
  const p = new ScriptedProvider([]), abort = new AbortController();
  const run = interactive(["--approval-mode", "auto_approve"], ws, { provider: p, signal: abort.signal });
  try {
    await run.waitFor((t) => t.includes("Consentement") && t.includes("classifieur")); expect(p.requests).toHaveLength(0);
    await sleep(370); run.type("n"); expect((await run.done).code).toBe(2);
    expect(p.requests).toHaveLength(0);
    expect(JSON.parse(readFileSync(`${ws.configHome}/state.json`, "utf8")).autoApproveConsent.version).toBe(0);
  } finally { abort.abort(); await run.done; }
});

test("SPEC-MOD-005/CA-16 — insufficient budget prevents the classifier request and follows the human fallback", async () => {
  const ws = workspace(); permit(ws);
  const path = `${ws.project}/budget.txt`;
  const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "never" } }] }, { text: "done" }]);
  let human = 0;
  const r = await cli([...modeArgs, "--model", "large", "--max-cost", "1"], ws, { provider: p,
    userConfig: { models: { pricingOverrides: { "test-small": { inputPerMTok: 1, outputPerMTok: 1_000_000, cacheReadPerMTok: 1, cacheWritePerMTok: 1 } } } },
    extra: { authorities: { human: { request: async (request) => { human++; expect(request.reason).toContain("budget is insufficient"); return { answer: "no" }; } } } },
  });
  expect(r.code).toBe(0); expect(human).toBe(1); expect(existsSync(path)).toBe(false);
  expect(p.requests.filter((q) => q.purpose === "side")).toHaveLength(0);
});

test("SPEC-PER-014/CA-01 — four classifier blocks send the next automatic demand to the human, then an allowance restores classification", async () => {
  const ws = workspace(); permit(ws);
  const scripts: ConstructorParameters<typeof ScriptedProvider>[0] = [];
  for (let i = 0; i < 4; i++) scripts.push({ toolCalls: [{ name: "write_file", input: { path: `${ws.project}/blocked${i}.txt`, content: "never" } }] }, { text: JSON.stringify({ decision: "block", reason: "Outside the requested scope." }) });
  scripts.push({ toolCalls: [{ name: "write_file", input: { path: `${ws.project}/human.txt`, content: "allowed by human" } }] },
    { toolCalls: [{ name: "write_file", input: { path: `${ws.project}/classified.txt`, content: "allowed by classifier" } }] },
    { text: JSON.stringify({ decision: "allow", reason: "Within the requested scope." }) }, { text: "done" });
  const p = new ScriptedProvider(scripts); let human = 0;
  const r = await cli(modeArgs, ws, { provider: p, extra: { authorities: { human: { request: async () => { human++; return { answer: "yes" }; } } } } });
  expect(r.code).toBe(0); expect(human).toBe(1);
  expect(p.requests.filter((q) => q.purpose === "side")).toHaveLength(5);
  expect(readFileSync(`${ws.project}/human.txt`, "utf8")).toBe("allowed by human");
  expect(readFileSync(`${ws.project}/classified.txt`, "utf8")).toBe("allowed by classifier");
  for (let i = 0; i < 4; i++) expect(existsSync(`${ws.project}/blocked${i}.txt`)).toBe(false);
});

test("SPEC-PER-014/CA-02 — SPEC-PER-014/CA-03 — SPEC-PER-001/CA-35 — after four blocks without a human, classification continues and the model receives a reminder to change approach", async () => {
  const ws = workspace(); permit(ws);
  const scripts: ConstructorParameters<typeof ScriptedProvider>[0] = [];
  for (let i = 0; i < 4; i++) scripts.push({ toolCalls: [{ name: "write_file", input: { path: `${ws.project}/blocked${i}.txt`, content: "never" } }] }, { text: JSON.stringify({ decision: "block", reason: "Outside the requested scope." }) });
  scripts.push({ toolCalls: [{ name: "write_file", input: { path: `${ws.project}/approved.txt`, content: "approved" } }] },
    { text: JSON.stringify({ decision: "allow", reason: "Within the requested scope." }) }, { text: "done" });
  const p = new ScriptedProvider(scripts);
  const r = await cli(modeArgs, ws, { provider: p });
  expect(r.code).toBe(0); expect(p.requests.filter((q) => q.purpose === "side")).toHaveLength(5);
  expect(JSON.stringify(main(p)[4]?.history)).toContain("change your approach");
  expect(JSON.stringify(main(p)[4]?.history)).toContain("Do not retry the denied action");
  expect(readFileSync(`${ws.project}/approved.txt`, "utf8")).toBe("approved");
});

test("TECH — malformed classifier fields, duplicate keys, extra fields and unfinished replies never authorize an action", async () => {
  for (const response of [
    { text: '{"decision":"block","decision":"allow","reason":"duplicate"}' },
    { text: '{"decision":["allow"],"reason":"wrong type"}' },
    { text: '{"decision":"allow","reason":"","extra":true}' },
    { text: '{"decision":"allow","reason":"unfinished"}', stopReason: "max_tokens" as const },
    { text: '{"decision":"allow","reason":"tool reply"}', toolCalls: [{ name: "write_file", input: {} }] },
  ]) {
    const ws = workspace(); permit(ws); const path = `${ws.project}/invalid.txt`;
    const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "never" } }] }, response, { text: "done" }]);
    const r = await cli(modeArgs, ws, { provider: p });
    expect(r.code).toBe(0); expect(existsSync(path)).toBe(false);
    expect(r.stderr).toContain("unavailable");
  }
});

test("TECH — a timed out classifier refuses the action and cannot execute its later answer", async () => {
  const ws = workspace(); permit(ws); const path = `${ws.project}/timeout.txt`;
  const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "never" } }] }, { hang: true }, { text: "done" }]);
  const r = await cli(modeArgs, ws, { provider: p });
  expect(r.code).toBe(0); expect(existsSync(path)).toBe(false); expect(r.stderr).toContain("timed out");
}, 10000);

test("TECH — revocation during classification invalidates the pending permission before file creation", async () => {
  const ws = workspace(); permit(ws); const path = `${ws.project}/revoked.txt`;
  const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "never" } }] }, () => {
    writeFileSync(`${ws.configHome}/state.json`, JSON.stringify({ autoApproveConsent: { version: 0, at: new Date().toISOString() } }));
    return { text: '{"decision":"allow","reason":"The consent was previously valid."}' };
  }, { text: "done" }]);
  const r = await cli(modeArgs, ws, { provider: p });
  expect(r.code).toBe(0); expect(existsSync(path)).toBe(false); expect(r.stderr).toContain("révoqué");
});

test("TECH — cumulative denials keep the human fallback after an allowance, and distinct refusal episodes repeat their reminder", () => {
  const cumulative = new PermissionDenials(() => ({ consecutive: 4, total: 2 }));
  cumulative.record("deny"); cumulative.record("allow"); cumulative.record("deny"); expect(cumulative.needsHuman).toBe(true);
  cumulative.record("allow"); expect(cumulative.needsHuman).toBe(true);
  const episodes = new PermissionDenials(() => ({ consecutive: 2, total: 100 }));
  const center = new ReminderCenter([episodes], 1000, (text) => text.length);
  episodes.record("deny"); episodes.record("deny"); expect(center.collect()).toHaveLength(1);
  episodes.record("allow"); expect(episodes.needsHuman).toBe(false);
  episodes.record("deny"); episodes.record("deny"); expect(center.collect()).toHaveLength(1);
});

test("TECH — sub-agent refusals count toward the session threshold before the parent's next action", async () => {
  const ws = workspace(); permit(ws); const path = `${ws.project}/parent.txt`;
  const child: ConstructorParameters<typeof ScriptedProvider>[0] = [];
  for (let i = 0; i < 4; i++) child.push({ toolCalls: [{ name: "write_file", input: { path: `${ws.project}/child${i}.txt`, content: "never" } }] });
  child.push({ text: "child finished" });
  const script: ConstructorParameters<typeof ScriptedProvider>[0] = [{ toolCalls: [{ name: "spawn_agent", input: { role: "general", description: "check permissions", prompt: "Check four unrelated files." } }] }];
  for (let i = 0; i < 4; i++) script.push({ text: '{"decision":"block","reason":"Outside the requested scope."}' });
  script.push({ toolCalls: [{ name: "write_file", input: { path, content: "human" } }] }, { text: "done" });
  const p = new ScriptedProvider(script, child); let human = 0;
  const r = await cli(modeArgs, ws, { provider: p, extra: { authorities: { human: { request: async () => { human++; return { answer: "yes" }; } } } } });
  expect(r.code).toBe(0); expect(human).toBe(1); expect(readFileSync(path, "utf8")).toBe("human");
  expect(p.requests.filter((q) => q.purpose === "side")).toHaveLength(4);
});

test("TECH — an automatic delegate cannot forge consent by writing the private user state", async () => {
  const ws = workspace(), path = `${ws.configHome}/state.json`;
  const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: JSON.stringify({ autoApproveConsent: { version: 1, at: new Date().toISOString() } }) } }] }, { text: "done" }]);
  let delegate = 0;
  const r = await cli(["--non-interactive", "go"], ws, { provider: p, extra: { authorities: { delegate: { decide: async () => { delegate++; return "allow"; } } } } });
  expect(r.code).toBe(0); expect(delegate).toBe(0);
  const next = new ScriptedProvider([]), rerun = await cli(modeArgs, ws, { provider: next });
  expect(rerun.code).toBe(2); expect(next.requests).toHaveLength(0);
});

test("TECH — an automatic child of an unrestricted parent filters its own interpreter rules and checks live consent", async () => {
  const ws = workspace(); permit(ws);
  ws.write("home/config/agents/cautious.md", '---\nname: cautious\ndescription: "Test a narrower approval mode."\napprovalMode: auto_approve\n---\nAct only inside the child scope.');
  const one = `${ws.project}/child-allowed.txt`, two = `${ws.project}/child-revoked.txt`;
  const command = `${quotePosix(BUN)} -e ${quotePosix(`require('node:fs').writeFileSync(${JSON.stringify(one.replace(/\\/g, "/"))}, 'approved')`)}`;
  const p = new ScriptedProvider([
    { toolCalls: [{ name: "spawn_agent", input: { role: "cautious", description: "exercise consent", prompt: "CHILD_SCOPE_ONLY" } }] },
    { text: '{"decision":"allow","reason":"The child requested this exact action."}' },
    () => { writeFileSync(`${ws.configHome}/state.json`, JSON.stringify({ autoApproveConsent: { version: 0, at: new Date().toISOString() } })); return { text: '{"decision":"allow","reason":"Pending old consent."}' }; },
    { text: "parent done" },
  ], [
    { toolCalls: [{ name: "run_shell", input: { command } }] },
    { toolCalls: [{ name: "write_file", input: { path: two, content: "never" } }] }, { text: "child done" },
  ]);
  const r = await cli(["--non-interactive", "--approval-mode", "unrestricted", "--allow-unrestricted-mode", "PARENT_SCOPE_ONLY"], ws, { provider: p, env: productEnv(ws), userConfig: { permissions: { allowRules: ["run_shell"] } } });
  expect(r.code).toBe(0); expect(readFileSync(one, "utf8")).toBe("approved"); expect(existsSync(two)).toBe(false);
  const side = p.requests.filter((q) => q.purpose === "side"); expect(side).toHaveLength(2);
  expect(JSON.stringify(side[0]?.history)).toContain("CHILD_SCOPE_ONLY"); expect(JSON.stringify(side[0]?.history)).not.toContain("PARENT_SCOPE_ONLY");
  expect(side[0]?.tools).toEqual([]);
});

test("TECH — configured automatic mode without consent refuses non-interactive startup", async () => {
  const ws = workspace(), p = new ScriptedProvider([]);
  const r = await cli(["--non-interactive", "go"], ws, { provider: p, userConfig: { engine: { nonInteractive: { defaultPermissionMode: "auto_approve" } } } });
  expect(r.code).toBe(2); expect(p.requests).toHaveLength(0); expect(r.stderr).toContain("consentement");
});

test("TECH — classifier defaults and customized instructions are consultable without a model request", async () => {
  const ws = workspace(), p = new ScriptedProvider([]);
  const r = await cli(["--non-interactive", "/access-rules classifier"], ws, { provider: p, userConfig: { permissions: { autoApprove: { environment: ["A trusted isolated test workspace."] } } } });
  expect(r.code).toBe(0); expect(p.requests).toHaveLength(0); expect(r.stdout).toContain("A trusted isolated test workspace."); expect(r.stdout).toContain("Dernières décisions");
});

test("TECH — managed consent withdrawn during classification blocks the pending action", async () => {
  const ws = workspace(); permit(ws); const path = `${ws.project}/org-revoked.txt`;
  const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path, content: "never" } }] }, () => {
    permit(ws, { permissions: { autoApprove: { orgConsent: false } } });
    return { text: '{"decision":"allow","reason":"Approved against the old consent."}' };
  }, { text: "done" }]);
  const r = await cli(modeArgs, ws, { provider: p });
  expect(existsSync(path)).toBe(false); expect(r.code).toBe(ExitCode.BlockedByPolicy); expect(r.stderr).toContain("politique");
});

test("TECH — a child receiving repeated blocks sees the shared refusal reminder in its own next request", async () => {
  const ws = workspace(); permit(ws);
  const child: ConstructorParameters<typeof ScriptedProvider>[0] = [];
  for (let i = 0; i < 4; i++) child.push({ toolCalls: [{ name: "write_file", input: { path: `${ws.project}/child${i}.txt`, content: "never" } }] });
  child.push({ text: "child finished" });
  const script: ConstructorParameters<typeof ScriptedProvider>[0] = [{ toolCalls: [{ name: "spawn_agent", input: { role: "general", description: "check refusals", prompt: "Child scope." } }] }];
  for (let i = 0; i < 4; i++) script.push({ text: '{"decision":"block","reason":"Outside the requested scope."}' });
  script.push({ text: "parent finished" });
  const p = new ScriptedProvider(script, child), r = await cli(modeArgs, ws, { provider: p });
  expect(r.code).toBe(0);
  expect(JSON.stringify(p.requests.filter((q) => q.purpose === "subagent")[4]?.history)).toContain("change your approach");
});
