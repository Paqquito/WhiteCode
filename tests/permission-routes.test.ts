import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { Host, type Message } from "./helpers/control";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { hook, productEnv, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const write = (path: string, id?: string) => ({ name: "write_file", input: { path, content: "approved" }, ...(id ? { id } : {}) });
const spawn = (role?: string) => ({ name: "spawn_agent", input: { description: "A bounded task", prompt: "Write the requested file.", ...(role ? { role } : {}) } });
const answer = (host: Host, request: Message, result: Record<string, unknown>) => host.send({ type: "control_response", id: request["id"], ok: true, result });
const pending = (host: Host, except?: unknown) => host.waitFor((message) => message.type === "control_request" && message["request"] === "approval_request" && message["id"] !== except);
const done = (host: Host, turn = 1) => host.waitFor((message) => message.type === "turn_completed" && message["turn"] === turn);
const finish = async (host: Host) => { host.feed.end(); return host.finish(); };

test("TECH — cancellation during before_tool cannot open a late dialogue or persist its approval", async () => {
  const ws = workspace();
  const started = join(ws.root, "hook-started");
  const ended = join(ws.root, "hook-ended");
  const command = hook(ws, "slow", `const fs = await import("node:fs"); fs.writeFileSync(${JSON.stringify(started)}, "started"); await Bun.sleep(500); fs.writeFileSync(${JSON.stringify(ended)}, "ended");`);
  const target = join(ws.project, "cancelled-hook.txt");
  const provider = new ScriptedProvider([{ toolCalls: [write(target)] }, { toolCalls: [write(target)] }, { text: "Finished." }]);
  const run = interactive([], ws, { provider, env: productEnv(ws), userConfig: { hooks: { before_tool: [{ match: "write_file", actions: [{ type: "command", command }] }] } } });
  await run.idle(); run.type("Write.\r");
  const limit = Date.now() + 3000;
  while (!existsSync(started) && Date.now() < limit) await sleep(10);
  expect(existsSync(started)).toBe(true);
  run.type(KEY.ctrlC);
  while (!existsSync(ended) && Date.now() < limit) await sleep(10);
  await run.waitFor((text) => run.screen().join("\n").includes("Autorisation requise") || text.includes("Interrompu"));
  const late = run.screen().join("\n").includes("Autorisation requise");
  if (late) { await sleep(370); run.type("2"); }
  await run.waitFor((text) => text.includes("Interrompu"));
  expect(existsSync(target)).toBe(false);
  run.type("Try a fresh write.\r");
  await run.waitFor((text) => run.screen().join("\n").includes("Autorisation requise") || text.includes("Finished."));
  const fresh = run.screen().join("\n").includes("Autorisation requise");
  if (fresh) { await sleep(370); run.type("3"); }
  await run.waitFor((text) => text.includes("Finished."));
  run.type(KEY.ctrlD); run.type(KEY.ctrlD);
  expect((await run.done).code).toBe(0);
  expect(late).toBe(false);
  expect(fresh).toBe(true);
  expect(existsSync(target)).toBe(false);
});

test("TECH — a nested agent retains the no_prompt restriction of its immediate caller", async () => {
  const ws = workspace();
  ws.write("home/config/agents/cautious.md", '---\nname: "cautious"\ndescription: "Never ask for permissions."\napprovalMode: "no_prompt"\n---\nUse only pre-approved actions.\n');
  const target = join(ws.project, "nested.txt");
  const provider = new ScriptedProvider([{ toolCalls: [spawn("cautious")] }, { text: "Parent finished." }], [{ toolCalls: [spawn()] }, { toolCalls: [write(target)] }, { text: "Grandchild finished." }, { text: "Child finished." }]);
  const run = interactive([], ws, { provider, userConfig: { agents: { maxDepth: 3 } } });
  await run.idle();
  run.type("Delegate recursively.\r");
  await run.waitFor((text) => text.includes("Parent finished.") || text.includes("Autorisation requise"));
  const asked = run.all().join("\n").includes("Autorisation requise");
  if (asked) { await sleep(370); run.type("2"); await run.waitFor((text) => text.includes("Parent finished.")); }
  run.type(KEY.ctrlD); run.type(KEY.ctrlD);
  expect((await run.done).code).toBe(0);
  expect(asked).toBe(false);
  expect(existsSync(target)).toBe(false);
  expect(JSON.stringify(provider.requests.filter((request) => request.purpose === "subagent")[2]?.history)).toContain("no_prompt mode");
});

test("TECH — skill grants in a child neither authorize its parent nor survive resumption", async () => {
  const ws = workspace();
  ws.write("home/config/skills/permit/definition.md", '---\nname: "permit"\ndescription: "Permit bounded writes for this turn."\ntools: ["write_file"]\n---\nWrite only the requested file.\n');
  const paths = ["child", "parent", "resumed"].map((name) => join(ws.project, `${name}.txt`));
  const provider = new ScriptedProvider([{ toolCalls: [spawn()] }, { toolCalls: [write(paths[1]!)] }, (request) => ({ toolCalls: [{ name: "spawn_agent", input: { description: "Resume same child", prompt: "Try another write.", resume: /\[agent (agent-[0-9a-f]{8})/.exec(JSON.stringify(request.history))?.[1] ?? "missing" } }] }), { text: "Parent finished." }], [{ toolCalls: [{ name: "use_skill", input: { name: "permit" } }] }, { toolCalls: [write(paths[0]!)] }, { text: "Child finished." }, { toolCalls: [write(paths[2]!)] }, { text: "Resumed finished." }]);
  await cli(["--non-interactive", "Delegate."], ws, { provider });
  expect(readFileSync(paths[0]!, "utf8")).toBe("approved");
  expect(existsSync(paths[1]!)).toBe(false);
  expect(existsSync(paths[2]!)).toBe(false);
  expect(provider.requests.filter((request) => request.purpose === "subagent").at(-1)?.history).toBeDefined();
});

test("TECH — an agent skill respects the same depth limit as spawn_agent", async () => {
  const ws = workspace();
  ws.write("home/config/skills/check/definition.md", '---\nname: "check"\ndescription: "Check a bounded task."\ncontext: "agent"\n---\nWork within the delegation depth.\n');
  const provider = new ScriptedProvider([{ toolCalls: [spawn()] }, { text: "Parent finished." }], [{ toolCalls: [{ name: "use_skill", input: { name: "check" } }] }, { text: "Child finished." }]);
  await cli(["--non-interactive", "Delegate."], ws, { provider, userConfig: { agents: { maxDepth: 1 } } });
  const requests = provider.requests.filter((request) => request.purpose === "subagent");
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests[1]?.history)).toContain("beyond agents.maxDepth");
});

test("TECH — a changed ask rule after a pending approval requires a new correlated decision", async () => {
  const ws = workspace();
  const target = join(ws.project, "renewed.txt");
  const provider = new ScriptedProvider([{ toolCalls: [write(target)] }, { text: "Finished." }]);
  const host = new Host(ws, { provider, init: { decisionAuthority: true } });
  try {
    host.user("Write.");
    const old = await pending(host);
    await host.request("set_tool_permissions", { add: [{ decision: "ask", rule: "write_file" }] });
    answer(host, old, { decision: "allow" });
    const fresh = await pending(host, old["id"]);
    expect(existsSync(target)).toBe(false);
    answer(host, fresh, { decision: "deny" });
    await done(host);
    expect(existsSync(target)).toBe(false);
  } finally { await finish(host); }
});

test("TECH — an ask definition cannot reintroduce a human dialogue under no_prompt", async () => {
  const ws = workspace();
  ws.write("home/config/agents/asking.md", '---\nname: "asking"\ndescription: "Ask before changes."\napprovalMode: "ask"\n---\nRequest permission before changes.\n');
  const target = join(ws.project, "asking.txt");
  const provider = new ScriptedProvider([{ toolCalls: [spawn("asking")] }, { text: "Parent finished." }], [{ toolCalls: [write(target)] }, { text: "Child finished." }]);
  const run = interactive(["--approval-mode", "no_prompt"], ws, { provider });
  await run.idle();
  run.type("Delegate.\r");
  await run.waitFor((text) => text.includes("Parent finished.") || text.includes("Autorisation requise"));
  const asked = run.all().join("\n").includes("Autorisation requise");
  if (asked) { await sleep(370); run.type("2"); await run.waitFor((text) => text.includes("Parent finished.")); }
  run.type(KEY.ctrlD); run.type(KEY.ctrlD);
  expect((await run.done).code).toBe(0);
  expect(asked).toBe(false);
  expect(existsSync(target)).toBe(false);
});

test("TECH — a planning child under no_prompt keeps read-only tools and cannot ask a human for a protected read", async () => {
  const ws = workspace();
  const file = ws.write("project/protected.txt", "PROTECTED READ CONTENT");
  ws.write("home/config/agents/reader.md", '---\nname: "reader"\ndescription: "Read-only planning."\napprovalMode: "planning"\n---\nPlan without modifications.\n');
  const provider = new ScriptedProvider([{ toolCalls: [spawn("reader")] }, { text: "Parent finished." }], [{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "Child finished." }]);
  const run = interactive(["--approval-mode", "no_prompt"], ws, { provider, userConfig: { permissions: { askRules: ["read_file"] } } });
  await run.idle(); run.type("Delegate.\r");
  await run.waitFor((text) => text.includes("Parent finished.") || text.includes("Autorisation requise"));
  const asked = run.all().join("\n").includes("Autorisation requise");
  if (asked) { await sleep(370); run.type("2"); await run.waitFor((text) => text.includes("Parent finished.")); }
  run.type(KEY.ctrlD); run.type(KEY.ctrlD);
  expect((await run.done).code).toBe(0);
  expect(asked).toBe(false);
  const child = provider.requests.filter((request) => request.purpose === "subagent");
  expect(child[0]?.tools.map((tool) => tool.name)).not.toContain("write_file");
  expect(JSON.stringify(child[1]?.history)).not.toContain("PROTECTED READ CONTENT");
  expect(JSON.stringify(child[1]?.history)).toContain("no_prompt mode");
});

test("TECH — resumption by a different restricted caller cannot acquire an earlier agent's tools", async () => {
  const ws = workspace();
  ws.write("home/config/agents/limited.md", '---\nname: "limited"\ndescription: "Delegate without writing tools."\ntools: ["spawn_agent"]\n---\nKeep the restricted tools.\n');
  const target = join(ws.project, "resumed.txt");
  let previous = "";
  const provider = new ScriptedProvider([{ toolCalls: [spawn()] }, (request) => { previous = /\[agent (agent-[0-9a-f]{8})/.exec(JSON.stringify(request.history))?.[1] ?? "missing"; return { toolCalls: [spawn("limited")] }; }, { text: "Parent finished." }], [{ text: "Original report." }, () => ({ toolCalls: [{ name: "spawn_agent", input: { description: "Resume earlier agent", prompt: "Write the requested file.", resume: previous } }] }), { toolCalls: [write(target)] }, { text: "Child finished." }]);
  await cli(["--non-interactive", "--approval-mode", "auto_edit", "Delegate."], ws, { provider, userConfig: { agents: { maxDepth: 3 } } });
  expect(existsSync(target)).toBe(false);
  expect(JSON.stringify(provider.requests.filter((request) => request.purpose === "subagent")[2]?.history)).toContain("same caller");
});

test("TECH — a skill executed in an agent keeps its caller's excluded tools", async () => {
  const ws = workspace();
  ws.write("home/config/agents/limited.md", '---\nname: "limited"\ndescription: "Use skills without writing tools."\ntools: ["use_skill"]\n---\nKeep the restricted tools.\n');
  ws.write("home/config/skills/check/definition.md", '---\nname: "check"\ndescription: "Check a bounded task."\ncontext: "agent"\n---\nWork within your caller permissions.\n');
  const target = join(ws.project, "skill.txt");
  const provider = new ScriptedProvider([{ toolCalls: [spawn("limited")] }, { text: "Parent finished." }], [{ toolCalls: [{ name: "use_skill", input: { name: "check" } }] }, { toolCalls: [write(target)] }, { text: "Skill finished." }, { text: "Child finished." }]);
  await cli(["--non-interactive", "--approval-mode", "auto_edit", "Delegate."], ws, { provider, userConfig: { agents: { maxDepth: 3 } } });
  expect(existsSync(target)).toBe(false);
  expect(provider.requests.filter((request) => request.purpose === "subagent")[1]?.tools.map((tool) => tool.name)).toEqual(["use_skill"]);
});

test("TECH — an unavailable auto_approve definition falls back safely even under unrestricted", async () => {
  const ws = workspace();
  ws.write(`home/config/${basename(loadIdentity().get("USER_STATE_FILE"))}`, JSON.stringify({ unrestrictedAccepted: true }));
  ws.write("home/config/agents/automatic.md", '---\nname: "automatic"\ndescription: "Try automatic decisions."\napprovalMode: "auto_approve"\n---\nWork within available modes.\n');
  const target = join(ws.project, "automatic.txt");
  let classified = 0;
  const provider = new ScriptedProvider([{ toolCalls: [spawn("automatic")] }, { text: "Parent finished." }], [{ toolCalls: [write(target)] }, { text: "Child finished." }]);
  const result = await cli(["--non-interactive", "--allow-unrestricted-mode", "--approval-mode", "unrestricted", "Delegate."], ws, { provider, extra: { authorities: { classifier: { decide: async () => { classified++; return "allow"; } } } } });
  expect(result.code).toBe(0);
  expect(existsSync(target)).toBe(false);
  expect(classified).toBe(0);
  expect(result.stderr).toContain("indisponible");
});

test("SPEC-PER-001/CA-21 — a deny added while approval waits is enforced even when the mode stays the same", async () => {
  const ws = workspace();
  const target = join(ws.project, "pending.txt");
  const provider = new ScriptedProvider([{ toolCalls: [write(target)] }, { text: "Finished." }]);
  const host = new Host(ws, { provider, init: { decisionAuthority: true } });
  try {
    host.user("Write the file.");
    const request = await pending(host);
    const before = await host.request("get_state");
    expect((await host.request("set_tool_permissions", { add: [{ decision: "deny", rule: "write_file" }] }))["ok"]).toBe(true);
    const after = await host.request("get_state");
    expect((after["result"] as Record<string, unknown>)["permissionMode"]).toBe((before["result"] as Record<string, unknown>)["permissionMode"]);
    answer(host, request, { decision: "allow" });
    await done(host);
    expect(existsSync(target)).toBe(false);
    expect(JSON.stringify(provider.requests[1]?.history)).toContain("Denied by the rule write_file");
  } finally { await finish(host); }
});

test("TECH — a child follows a parent entering planning mode while its model response is still streaming", async () => {
  const ws = workspace();
  const target = join(ws.project, "child.txt");
  let started!: () => void;
  const childStarted = new Promise<void>((resolve) => { started = resolve; });
  const provider = new ScriptedProvider([{ toolCalls: [spawn()] }, { text: "Finished." }], [() => {
    started();
    return { toolCalls: [write(target)], delayMs: 300 };
  }, { text: "Child finished." }]);
  const host = new Host(ws, { provider, argv: ["--approval-mode", "ask"], init: { decisionAuthority: true }, answers: { approval_request: () => ({ decision: "allow" }) } });
  try {
    host.user("Delegate.");
    await childStarted;
    expect((await host.request("set_approval_mode", { mode: "planning" }))["ok"]).toBe(true);
    await done(host);
    expect(existsSync(target)).toBe(false);
    expect(host.demands("approval_request")).toHaveLength(0);
    expect(JSON.stringify(provider.requests.filter((request) => request.purpose === "subagent").at(-1)?.history)).toContain("Planning mode");
  } finally { await finish(host); }
});

test("SPEC-PER-001/CA-20 — an approved replacement path is fully reevaluated and cannot bypass its deny rule", async () => {
  const ws = workspace();
  const original = join(ws.project, "ordinary.txt");
  const changed = join(ws.home, "restricted.txt");
  const provider = new ScriptedProvider([{ toolCalls: [write(original)] }, { text: "Finished." }]);
  const host = new Host(ws, { provider, argv: ["--deny-rule", "write_file(~/restricted.txt)"], init: { decisionAuthority: true }, answers: {
    approval_request: () => ({ decision: "allow_modified", input: { path: changed, content: "replacement" } }),
  } });
  try {
    host.user("Write.");
    await done(host);
    expect(existsSync(original)).toBe(false);
    expect(existsSync(changed)).toBe(false);
    expect(host.demands("approval_request")).toHaveLength(1);
    expect(JSON.stringify(provider.requests[1]?.history)).toContain("Denied by the rule");
  } finally { await finish(host); }
});

test("SPEC-PER-001/CA-22 — only the first valid reply counts and an approval after cancellation cannot approve a fresh call", async () => {
  const ws = workspace();
  const paths = ["duplicate.txt", "cancelled.txt", "fresh.txt"].map((name) => join(ws.project, name));
  const provider = new ScriptedProvider([{ toolCalls: [write(paths[0]!)] }, { text: "Denied." }, { toolCalls: [write(paths[1]!)] }, { toolCalls: [write(paths[2]!)] }, { text: "Finished." }]);
  const host = new Host(ws, { provider, init: { decisionAuthority: true } });
  try {
    host.user("First.");
    const first = await pending(host);
    answer(host, first, { decision: "deny" });
    answer(host, first, { decision: "allow" });
    await done(host);
    expect(existsSync(paths[0]!)).toBe(false);
    host.user("Second.");
    const cancelled = await pending(host, first["id"]);
    await host.request("cancel_turn");
    await done(host, 2);
    host.user("Third.");
    const fresh = await host.waitFor((message) => message.type === "control_request" && message["request"] === "approval_request" && ![first["id"], cancelled["id"]].includes(message["id"]));
    answer(host, cancelled, { decision: "allow" });
    await sleep(30);
    expect(paths.every((path) => !existsSync(path))).toBe(true);
    answer(host, fresh, { decision: "allow" });
    await done(host, 3);
    expect(existsSync(paths[1]!)).toBe(false);
    expect(readFileSync(paths[2]!, "utf8")).toBe("approved");
  } finally { await finish(host); }
});

test("SPEC-PER-001/CA-23 — reversed answers to concurrent children with the same provider call id affect only their own resource", async () => {
  const ws = workspace();
  const first = join(ws.project, "first.txt");
  const second = join(ws.project, "second.txt");
  const provider = new ScriptedProvider([{ toolCalls: [spawn(), spawn()] }, { text: "Parent finished." }], [{ toolCalls: [write(first, "shared-id")] }, { toolCalls: [write(second, "shared-id")] }, { text: "Child report." }, { text: "Child report." }]);
  const host = new Host(ws, { provider, init: { decisionAuthority: true } });
  try {
    host.user("Delegate twice.");
    const one = await pending(host);
    const two = await pending(host, one["id"]);
    expect(one["id"]).not.toBe(two["id"]);
    const params = (request: Message) => request["params"] as { input: { path: string }; requester: string };
    expect(params(one).requester).toBe("general");
    expect(params(two).requester).toBe("general");
    answer(host, two, { decision: "allow" });
    answer(host, one, { decision: "deny" });
    await done(host);
    expect(existsSync(params(one).input.path)).toBe(false);
    expect(readFileSync(params(two).input.path, "utf8")).toBe("approved");
  } finally { await finish(host); }
});

test("SPEC-PER-001/CA-09 — a child in ask mode presents its identified demand to the human before writing", async () => {
  const ws = workspace();
  const target = join(ws.project, "human.txt");
  const provider = new ScriptedProvider([{ toolCalls: [spawn()] }, { text: "Parent finished." }], [{ toolCalls: [write(target)] }, { text: "Child finished." }]);
  const run = interactive([], ws, { provider });
  await run.idle();
  run.type("Delegate.\r");
  await run.waitFor((text) => text.includes("Autorisation requise") && text.includes("Demandé par : general"));
  expect(existsSync(target)).toBe(false);
  await sleep(370);
  run.type("1");
  await run.waitFor((text) => text.includes("Parent finished."));
  expect(readFileSync(target, "utf8")).toBe("approved");
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  expect((await run.done).code).toBe(0);
});

test("SPEC-PER-001/CA-11 — an allow from before_tool leaves the explicit ask rule and human decision effective", async () => {
  const ws = workspace();
  const target = ws.write("project/read.txt", "SENSITIVE TEST CONTENT");
  const hook = record(ws, "allow-read", { decision: "allow" });
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: target } }] }, { text: "Finished." }]);
  const run = interactive([], ws, { provider, env: productEnv(ws), userConfig: { permissions: { askRules: ["read_file"] }, hooks: { before_tool: [{ match: "read_file", actions: [{ type: "command", command: hook.command }] }] } } });
  await run.idle();
  run.type("Read.\r");
  await run.waitFor((text) => text.includes("Autorisation requise"));
  expect(hook.read()).toHaveLength(1);
  expect(provider.requests).toHaveLength(1);
  await sleep(370);
  run.type("2");
  await run.waitFor((text) => text.includes("Finished."));
  expect(JSON.stringify(provider.requests[1]?.history)).not.toContain("SENSITIVE TEST CONTENT");
  expect(JSON.stringify(provider.requests[1]?.history)).toContain("The user denied");
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  expect((await run.done).code).toBe(0);
});

test("SPEC-PER-001/CA-33 — a no_prompt child refuses an unapproved write while the parent human interface stays available", async () => {
  const ws = workspace();
  ws.write("home/config/agents/cautious.md", '---\nname: "cautious"\ndescription: "Never ask for permissions."\napprovalMode: "no_prompt"\n---\nUse only pre-approved actions.\n');
  const target = join(ws.project, "never.txt");
  const provider = new ScriptedProvider([{ toolCalls: [spawn("cautious")] }, { text: "Parent finished." }], [{ toolCalls: [write(target)] }, { text: "Child finished." }]);
  const run = interactive([], ws, { provider });
  await run.idle();
  run.type("Delegate.\r");
  await run.waitFor((text) => text.includes("Parent finished."));
  expect(run.all().join("\n")).not.toContain("Autorisation requise");
  expect(existsSync(target)).toBe(false);
  expect(JSON.stringify(provider.requests.filter((request) => request.purpose === "subagent").at(-1)?.history)).toContain("no_prompt mode");
  run.type(KEY.ctrlD);
  run.type(KEY.ctrlD);
  expect((await run.done).code).toBe(0);
});
