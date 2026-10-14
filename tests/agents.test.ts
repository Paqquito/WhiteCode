// Sub-agents (SPEC-AGT-001, SPEC-OUT-016), built-in and custom agents (SPEC-AGT-002, SPEC-AGT-005), a skill run in a
// sub-agent (SPEC-OUT-037), the tools of a sub-agent (SPEC-MOT-001 CA-09).
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest } from "../src/providers/types";
import { cli, workspace, type Workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { PROJECT_DIR } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { productEnv, record } from "./helpers/hooks";

const header = (h: Record<string, unknown>, body: string) =>
  `---\n${Object.entries(h)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n${body}\n`;
const userAgent = (ws: Workspace, name: string, h: Record<string, unknown>, body: string) => ws.write(`home/config/agents/${name}.md`, header({ name, ...h }, body));
const projectAgent = (ws: Workspace, name: string, h: Record<string, unknown>, body: string) => ws.write(`project/${PROJECT_DIR}/agents/${name}.md`, header({ name, ...h }, body));
const spawn = (input: Record<string, unknown>, id?: string) => ({ name: "spawn_agent", input: { description: "une tâche", prompt: "fais-le", role: "general", ...input }, ...(id ? { id } : {}) });
const sub = (p: ScriptedProvider) => p.requests.filter((r) => r.purpose === "subagent");
const main = (p: ScriptedProvider) => p.requests.filter((r) => r.purpose !== "subagent");
const toolsOf = (r: ModelRequest | undefined) => (r?.tools ?? []).map((t) => t.name);
const lastResults = (r: ModelRequest | undefined) => JSON.stringify(r?.history.at(-1) ?? null);
const run = (ws: Workspace, p: ScriptedProvider, args: string[] = []) => cli(["--non-interactive", ...args, "go"], ws, { provider: p });

test("SPEC-AGT-003/CA-01 — explorer in planning mode reads the repository without any writing or modifying tool", async () => {
  const ws = workspace();
  const file = ws.write("project/entry.ts", "export const value = 7;");
  const p = new ScriptedProvider([{ toolCalls: [spawn({ role: "explorer", prompt: "Find value, exhaustiveness: quick." })] }, { text: "Parent finished." }], [
    { toolCalls: [{ name: "read_file", input: { path: file } }] },
    (request) => { expect(JSON.stringify(request.history)).toContain("export const value = 7;"); return { text: "entry.ts:1 defines value." }; },
  ]);
  const result = await run(ws, p, ["--approval-mode", "planning"]);
  expect(result.code).toBe(0);
  expect(sub(p)).toHaveLength(2);
  expect(sub(p)[0]!.model.id).toBe("test-small");
  expect(toolsOf(sub(p)[0])).toContain("read_file");
  for (const name of ["write_file", "edit_file", "run_shell", "run_powershell", "update_notebook_cell"]) expect(toolsOf(sub(p)[0])).not.toContain(name);
  expect(lastResults(main(p)[1])).toContain("entry.ts:1 defines value.");
});

test("SPEC-AGT-004/CA-01 — verifier executes a broken feature and returns its observed failure without editing files", async () => {
  const ws = workspace();
  ws.write("project/check.sh", "printf 'FEATURE_BROKEN_728\\n'; exit 3\n");
  let observedResult = "";
  let observedSystem = "";
  const p = new ScriptedProvider([{ toolCalls: [spawn({ role: "verifier", prompt: "Verify the feature with sh check.sh; report observed evidence." })] }, { text: "Parent finished." }], [
    { toolCalls: [{ name: "run_shell", input: { command: "sh check.sh" } }] },
    (request) => {
      observedResult = lastResults(request);
      observedSystem = JSON.stringify(request.system);
      return { text: "Failed: sh check.sh exited with code 3 and printed FEATURE_BROKEN_728." };
    },
  ]);
  const result = await cli(["--non-interactive", "--allow-rule", "run_shell", "go"], ws, { provider: p, env: productEnv(ws) });
  expect(result.code).toBe(0);
  expect(sub(p)).toHaveLength(2);
  expect(observedResult).toContain("FEATURE_BROKEN_728");
  expect(observedResult).toContain("Exit code 3.");
  expect(observedSystem).toContain("observed evidence");
  for (const name of ["write_file", "edit_file", "update_notebook_cell"]) expect(toolsOf(sub(p)[0])).not.toContain(name);
  expect(lastResults(main(p)[1])).toContain("Failed: sh check.sh exited with code 3 and printed FEATURE_BROKEN_728.");
}, 15_000);

describe("SPEC-AGT-001 sub-agents", () => {
  test("SPEC-HOK-001/CA-04 — before_tool identifies the actual child and its effective permission mode", async () => {
    const ws = workspace();
    const file = ws.write("project/read.txt", "READ CONTENT");
    userAgent(ws, "cautious", { description: "Read without asking.", approvalMode: "no_prompt" }, "Read pre-approved files only.");
    const before = record(ws, "agent-before");
    const p = new ScriptedProvider([{ toolCalls: [spawn({ role: "cautious" })] }, { text: "Parent finished." }], [{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "Child finished." }]);
    await cli(["--non-interactive", "--approval-mode", "auto_edit", "Delegate."], ws, { provider: p, env: productEnv(ws), userConfig: { hooks: { before_tool: [{ actions: [{ type: "command", command: before.command }] }] } } });
    const calls = before.read();
    const child = calls.find((call) => call.toolId === "read_file");
    expect(child.agent).toEqual({ id: sub(p)[0]?.agent, type: "cautious" });
    expect(child.approvalMode).toBe("no_prompt");
    expect(calls.find((call) => call.toolId === "spawn_agent").agent).toBeUndefined();
  });
  test("SPEC-AGT-001/CA-01 — a definition allowing every tool and a caller without writing tool: the agent has no writing tool", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ toolCalls: [spawn({})] }, { text: "rapport" }, { text: "fini" }]);
    const r = await run(ws, p, ["--toolset", "read_file,find_files,spawn_agent"]);
    expect(r.code).toBe(0);
    expect(toolsOf(main(p)[0])).toContain("spawn_agent");
    const tools = toolsOf(sub(p)[0]);
    expect(tools).toContain("read_file");
    for (const t of ["write_file", "edit_file", "run_shell"]) expect(tools).not.toContain(t);
    expect(lastResults(main(p)[1])).toContain("rapport");
  });

  test("SPEC-MOT-001/CA-09 — a sub-agent limited to some tools calling another: « tool not available »", async () => {
    const ws = workspace();
    userAgent(ws, "lecteur", { description: "Lit seulement.", tools: ["read_file"] }, "Tu lis.");
    const p = new ScriptedProvider([
      { toolCalls: [spawn({ role: "lecteur" })] },
      { toolCalls: [{ name: "write_file", input: { path: join(ws.project, "x.txt"), content: "x" } }] },
      { text: "je n'ai pas pu écrire" },
      { text: "fini" },
    ]);
    await run(ws, p, ["--approval-mode", "auto_edit"]);
    expect(toolsOf(sub(p)[0])).toEqual(["read_file"]);
    expect(lastResults(sub(p)[1])).toContain("Unknown tool: write_file");
  });

  test("TECH — the report alone comes back, with its statistics; an unknown type is refused with the list (SPEC-OUT-016 EF-02, ERR-01)", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ toolCalls: [spawn({ role: "inconnu" }), spawn({ prompt: "cherche le secret" })] }, { text: "le secret est 42" }, { text: "fini" }]);
    await run(ws, p);
    const results = lastResults(main(p)[1]);
    expect(results).toContain("Unknown agent type: inconnu. Available: explorer, planner, verifier, general, usage-guide, footer-line-setup.");
    expect(results).toContain("le secret est 42");
    expect(results).toMatch(/\[agent agent-[0-9a-f]{8} \(general\) · \d+ s · 1 iteration · \d+ tokens\]/);
    expect(results).not.toContain("cherche le secret"); // the conversation of the agent stays its own
    expect(JSON.stringify(sub(p)[0]!.history)).toContain("cherche le secret");
    expect(JSON.stringify(sub(p)[0]!.history)).not.toContain("\"go\""); // nor does it see the caller's (RG-01)
  });

  test("TECH — the permission demands of a sub-agent name it (SPEC-OUT-016 EF-04); the depth stops the delegation (FA-03)", async () => {
    const ws = workspace();
    const target = join(ws.project, "a.txt");
    const p = new ScriptedProvider([{ toolCalls: [spawn({})] }, { toolCalls: [{ name: "write_file", input: { path: target, content: "x" } }] }, { text: "écrit" }, { text: "fini" }]);
    const h = new Host(ws, { provider: p, init: { decisionAuthority: true }, userConfig: { agents: { maxDepth: 1 } }, answers: { approval_request: () => ({ decision: "allow" }) } });
    h.user("délègue");
    await h.waitFor((m) => m.type === "turn_completed");
    h.feed.end();
    await h.finish();
    expect((h.demands("approval_request")[0]!["params"] as Record<string, unknown>)["requester"]).toBe("general");
    expect(toolsOf(sub(p)[0])).not.toContain("spawn_agent");
  });
});

describe("SPEC-OUT-016 spawn_agent", () => {
  test("SPEC-AGT-009/CA-01 — a resumed agent retains the content of files it actually read", async () => {
    const ws = workspace();
    const file = ws.write("project/context.txt", "EARLIER FILE CONTENT");
    let previous = "";
    const p = new ScriptedProvider([
      { toolCalls: [spawn({ prompt: "Read context.txt and retain its content." })] },
      (request) => {
        previous = /\[agent (agent-[0-9a-f]{8})/.exec(JSON.stringify(request.history))?.[1] ?? "missing";
        writeFileSync(file, "NEW CONTENT AFTER THE REPORT");
        return { toolCalls: [spawn({ resume: previous, prompt: "Report the earlier file content without rereading." })] };
      },
      { text: "Parent finished." },
    ], [
      { toolCalls: [{ name: "read_file", input: { path: file } }] },
      { text: "File read." },
      (request) => {
        expect(request.agent).toBe(previous);
        expect(JSON.stringify(request.history)).toContain("EARLIER FILE CONTENT");
        expect(JSON.stringify(request.history)).not.toContain("NEW CONTENT AFTER THE REPORT");
        return { text: "EARLIER FILE CONTENT" };
      },
    ]);
    const result = await run(ws, p);
    expect(result.code).toBe(0);
    expect(lastResults(main(p)[2])).toContain("EARLIER FILE CONTENT");
    expect(sub(p).filter((request) => request.tools.some((tool) => tool.name === "read_file"))).toHaveLength(3);
  });
  test("SPEC-OUT-016/CA-01 — three calls in one response: they progress together and each returns its report", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([
      { toolCalls: [spawn({ prompt: "un" }), spawn({ prompt: "deux" }), spawn({ prompt: "trois" })] },
      { text: "rapport A", delayMs: 900 },
      { text: "rapport B", delayMs: 900 },
      { text: "rapport C", delayMs: 900 },
      { text: "fini" },
    ]);
    const started = Date.now();
    await run(ws, p);
    expect(Date.now() - started).toBeLessThan(2_400); // one after the other would take 2.7 s
    const results = lastResults(main(p)[1]);
    for (const r of ["rapport A", "rapport B", "rapport C"]) expect(results).toContain(r);
  });

  test("SPEC-OUT-016/CA-02 — a caller in planning mode: its sub-agent cannot write", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ toolCalls: [spawn({})] }, { text: "rapport" }, { text: "fini" }]);
    await run(ws, p, ["--approval-mode", "planning"]);
    const tools = toolsOf(sub(p)[0]);
    expect(tools).toContain("read_file");
    for (const t of ["write_file", "edit_file", "run_shell", "update_notebook_cell"]) expect(tools).not.toContain(t);
  });

  test("SPEC-OUT-016/CA-04 — an agent that ended and is resumed: it goes on with its earlier context", async () => {
    const ws = workspace();
    const idOf = (r: ModelRequest) => /\[agent (agent-[0-9a-f]{8})/.exec(JSON.stringify(r.history))?.[1] ?? "absent";
    const p = new ScriptedProvider([
      { toolCalls: [spawn({ prompt: "retiens le mot girafe" })] },
      { text: "retenu" },
      (r) => ({ toolCalls: [spawn({ resume: idOf(r), prompt: "quel était le mot ?" })] }),
      { text: "girafe" },
      { text: "fini" },
    ]);
    await run(ws, p);
    const second = sub(p)[1]!;
    expect(JSON.stringify(second.history)).toContain("retiens le mot girafe");
    expect(JSON.stringify(second.history)).toContain("quel était le mot ?");
    expect(second.agent).toBe(sub(p)[0]!.agent);
    expect(lastResults(main(p)[2])).toContain("girafe");
  });
});

describe("SPEC-AGT-002 and SPEC-AGT-005 definitions", () => {
  test("SPEC-AGT-002/CA-02 — a custom agent named general: it replaces the built-in one, with a warning", async () => {
    const ws = workspace();
    userAgent(ws, "general", { description: "Mon agent général." }, "INSTRUCTIONS PERSONNELLES");
    const p = new ScriptedProvider([{ toolCalls: [spawn({})] }, { text: "rapport" }, { text: "fini" }]);
    const r = await run(ws, p);
    expect(r.stderr).toContain("l'agent general (user) remplace l'agent intégré du même nom.");
    expect(JSON.stringify(sub(p)[0]!.system)).toContain("INSTRUCTIONS PERSONNELLES");
  });

  test("SPEC-AGT-005/CA-01 — a project agent and a user agent with the same name: the project's is used", async () => {
    const ws = workspace();
    userAgent(ws, "relecteur", { description: "Relit (utilisateur)." }, "VERSION UTILISATEUR");
    projectAgent(ws, "relecteur", { description: "Relit (projet)." }, "VERSION PROJET");
    const p = new ScriptedProvider([{ toolCalls: [spawn({ role: "relecteur" })] }, { text: "rapport" }, { text: "fini" }]);
    await run(ws, p, ["--allow-project-trust"]);
    const system = JSON.stringify(sub(p)[0]!.system);
    expect(system).toContain("VERSION PROJET");
    expect(system).not.toContain("VERSION UTILISATEUR");
  });

  test("SPEC-AGT-005/CA-02 — a definition changed during the session: the new version is used at the next launch", async () => {
    const ws = workspace();
    const file = userAgent(ws, "relecteur", { description: "Relit." }, "PREMIÈRE VERSION");
    const p = new ScriptedProvider([{ toolCalls: [spawn({ role: "relecteur" })] }, { text: "un" }, { text: "fini" }, { toolCalls: [spawn({ role: "relecteur" })] }, { text: "deux" }, { text: "fini" }]);
    const h = new Host(ws, { provider: p, init: {} });
    h.user("premier");
    await h.waitFor((m) => m.type === "turn_completed" && m["turn"] === 1);
    writeFileSync(file, header({ name: "relecteur", description: "Relit." }, "SECONDE VERSION"));
    h.user("second");
    await h.waitFor((m) => m.type === "turn_completed" && m["turn"] === 2);
    h.feed.end();
    await h.finish();
    expect(JSON.stringify(sub(p)[0]!.system)).toContain("PREMIÈRE VERSION");
    expect(JSON.stringify(sub(p)[1]!.system)).toContain("SECONDE VERSION");
  });

  test("TECH — an invalid definition is set aside without stopping the others; an unknown field is ignored with a warning (SPEC-AGT-005 EF-01, EF-02)", async () => {
    const ws = workspace();
    ws.write("home/config/agents/casse.md", "---\nname: Pas Valide\n---\ncorps\n");
    userAgent(ws, "bon", { description: "Fonctionne.", inconnu: 1 }, "corps");
    const p = new ScriptedProvider([{ text: "fini" }]);
    const r = await run(ws, p);
    expect(r.stderr).toContain("agent ignoré");
    expect(r.stderr).toContain("champ inconnu inconnu ignoré");
    expect(p.requests[0]!.tools.find((t) => t.name === "spawn_agent")!.description).toContain("- bon: Fonctionne.");
  });
});

describe("SPEC-OUT-037 a skill run in a sub-agent", () => {
  test("SPEC-OUT-037/CA-02 SPEC-EXT-020/CA-03 — a skill declaring a sub-agent: only its report comes back into the conversation", async () => {
    const ws = workspace();
    ws.write("home/config/skills/audit/definition.md", header({ name: "audit", description: "Audite le dépôt.", context: "agent" }, "CONSIGNES DÉTAILLÉES DE L'AUDIT"));
    const p = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "audit" } }] }, { text: "audit : rien à signaler" }, { text: "fini" }]);
    await run(ws, p);
    expect(JSON.stringify(sub(p)[0]!.history)).toContain("CONSIGNES DÉTAILLÉES DE L'AUDIT");
    const results = lastResults(main(p)[1]);
    expect(results).toContain("audit : rien à signaler");
    expect(results).not.toContain("CONSIGNES DÉTAILLÉES");
  });
});
