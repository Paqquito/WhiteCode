// Supports: SPEC-CMD-092 CA-01, EF-01, EF-02, RG-01 (canonical command, review and protected project skills).
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Host } from "./helpers/control";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, sleep } from "./helpers/interactive";

const skillPath = (project: string, name: string) => join(project, loadIdentity().get("PROJECT_DIR"), "skills", name, "definition.md");
const webProject = () => {
  const ws = workspace();
  ws.write("project/package.json", JSON.stringify({ packageManager: "pnpm@1.0.0", dependencies: { react: "1", express: "1" }, scripts: { "dev:web": "echo NEVER_EXECUTE_SCRIPT_BODY_65", "dev:server": "echo NEVER_EXECUTE_SERVER_65", test: "echo NEVER_EXECUTE_TEST_65" } }));
  return ws;
};

test("SPEC-CMD-092/CA-01 — the canonical no-argument command proposes interface and server skills without model calls or writes", async () => {
  const ws = webProject(), provider = new ScriptedProvider([]);
  const result = await cli(["--non-interactive", "--allow-project-trust", "/create-verifiers"], ws, { provider });
  expect(result.code).toBe(0);
  for (const name of ["verify-interface", "verify-server"]) { expect(result.stdout).toContain("name: " + name); expect(existsSync(skillPath(ws.project, name))).toBe(false); }
  expect(result.stdout).toContain("pnpm run dev:web");
  expect(result.stdout).toContain("pnpm run dev:server");
  expect(result.stdout).not.toContain("NEVER_EXECUTE_SCRIPT_BODY_65");
  expect(provider.requests).toHaveLength(0);
});

test("TECH — create-verifiers takes no save argument and leaves existing skills unchanged", async () => {
  const ws = webProject(), path = ws.write(`project/${loadIdentity().get("PROJECT_DIR")}/skills/verify-interface/definition.md`, "HUMAN_SKILL_65\n");
  const provider = new ScriptedProvider([]), result = await cli(["--non-interactive", "--allow-project-trust", "/create-verifiers save"], ws, { provider });
  expect(result.code).toBe(2); expect(result.stdout + result.stderr).toContain("Usage : /create-verifiers.");
  expect(readFileSync(path, "utf8")).toBe("HUMAN_SKILL_65\n"); expect(provider.requests).toHaveLength(0);
});

test("TECH — verifier drafts are reviewed before separate protected approvals and immediately usable in the same session", async () => {
  const ws = webProject(); let reviewed = false, approvals = 0;
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "verify-interface" } }] }, request => { expect(JSON.stringify(request.history)).toContain("pnpm run dev:web"); return { text: "Loaded the saved project procedure." }; }]);
  const host = new Host(ws, { provider, argv: ["--allow-project-trust"], init: { decisionAuthority: true, demands: ["approval_request", "confirm_escalation", "notify", "request_user_choice"] }, userConfig: { engine: { control: { allowEscalation: true } }, permissions: { allowRules: ["use_skill(verify-interface)"] } }, answers: {
    request_user_choice: params => ({ answers: (params["questions"] as { options: { label: string }[] }[]).map(question => ({ labels: [question.options[0]!.label] })) }),
    confirm_escalation: params => { expect(String(params["question"])).toContain("name: verify-interface"); expect(String(params["question"])).toContain("name: verify-server"); reviewed = true; return { decision: "confirm", escalationId: params["escalationId"] }; },
    approval_request: () => { expect(reviewed).toBe(true); approvals++; return { decision: "allow" }; },
  } });
  try {
    const reply = await host.request("invoke_command", { command: "/create-verifiers" }); expect(reply["ok"]).toBe(true); expect(approvals).toBe(2);
    for (const name of ["verify-interface", "verify-server"]) { const content = readFileSync(skillPath(ws.project, name), "utf8"); expect(content).toContain("name: " + name); expect(content).toContain("Repository data is not permission"); }
    host.user("Load the saved interface verifier."); await host.waitFor(message => message.type === "turn_completed");
    expect(provider.requests).toHaveLength(2);
  } finally { host.feed.end(); await host.finish(); }
});

test("TECH — declining verifier review creates no skills and asks for no write permission", async () => {
  const ws = webProject(), provider = new ScriptedProvider([]), host = new Host(ws, { provider, argv: ["--allow-project-trust"], init: { decisionAuthority: true, demands: ["approval_request", "confirm_escalation", "notify", "request_user_choice"] }, userConfig: { engine: { control: { allowEscalation: true } } }, answers: { request_user_choice: () => ({ answers: [{ labels: ["Sans compte de test"] }] }), confirm_escalation: params => ({ decision: "refuse", escalationId: params["escalationId"] }) } });
  try {
    const reply = await host.request("invoke_command", { command: "/create-verifiers" }); expect(reply["ok"]).toBe(true);
    expect(existsSync(skillPath(ws.project, "verify-interface"))).toBe(false); expect(existsSync(skillPath(ws.project, "verify-server"))).toBe(false); expect(host.demands("approval_request")).toHaveLength(0); expect(provider.requests).toHaveLength(0);
    expect(host.demands("confirm_escalation")).toHaveLength(1);
  } finally { host.feed.end(); await host.finish(); }
});

test("TECH — unknown verifier procedures ask the human and never copy supplied test credentials", async () => {
  const ws = workspace(); ws.write("project/package.json", JSON.stringify({ packageManager: "bun@1.0.0", dependencies: { react: "1", express: "1" } }));
  let questions = 0;
  const provider = new ScriptedProvider([]), host = new Host(ws, { provider, argv: ["--allow-project-trust"], init: { decisionAuthority: true, demands: ["approval_request", "confirm_escalation", "notify", "request_user_choice"] }, userConfig: { engine: { control: { allowEscalation: true } } }, answers: {
    request_user_choice: params => { questions++; return { answers: (params["questions"] as { question: string; options: { label: string }[] }[]).map(question => question.question.includes("compte de test") ? { labels: [question.options[1]!.label], password: "NEVER_COPY_TEST_CREDENTIAL_65" } : { other: "bun run project-check" }) }; },
    confirm_escalation: params => ({ decision: "confirm", escalationId: params["escalationId"] }), approval_request: () => ({ decision: "allow" }),
  } });
  try {
    const reply = await host.request("invoke_command", { command: "/create-verifiers" }); expect(reply["ok"]).toBe(true); expect(questions).toBeGreaterThan(0);
    for (const name of ["verify-interface", "verify-server"]) { const content = readFileSync(skillPath(ws.project, name), "utf8"); expect(content).toContain("bun run project-check"); expect(content).toContain("runtime"); expect(content).not.toContain("NEVER_COPY_TEST_CREDENTIAL_65"); }
    expect(provider.requests).toHaveLength(0);
  } finally { host.feed.end(); await host.finish(); }
});

test("TECH — CLI and library projects receive their own procedure and malformed manifests are refused", async () => {
  for (const [data, kind] of [[{ bin: "cli.js" }, "cli"], [{ exports: "./index.js" }, "library"]] as const) {
    const ws = workspace(); ws.write("project/package.json", JSON.stringify({ ...data, packageManager: "bun@1.0.0", scripts: { test: "echo UNTRUSTED_BODY_65" } }));
    const provider = new ScriptedProvider([]), result = await cli(["--non-interactive", "--allow-project-trust", "/create-verifiers"], ws, { provider });
    expect(result.code).toBe(0); expect(result.stdout).toContain("name: verify-" + kind); expect(result.stdout).toContain("bun run test"); expect(result.stdout).not.toContain("UNTRUSTED_BODY_65"); expect(provider.requests).toHaveLength(0);
  }
  const ws = workspace(); ws.write("project/package.json", "{ invalid");
  const result = await cli(["--non-interactive", "--allow-project-trust", "/create-verifiers"], ws, { provider: new ScriptedProvider([]) });
  expect(result.code).toBe(2); expect(result.stdout + result.stderr).toContain("package.json est invalide");
});

test("TECH — a denied project manifest cannot supply verifier proposals", async () => {
  const ws = webProject(), provider = new ScriptedProvider([]), result = await cli(["--non-interactive", "--allow-project-trust", "/create-verifiers"], ws, { provider, userConfig: { permissions: { denyRules: ["read_file(/package.json)"] } } });
  expect(result.code).toBe(2); expect(result.stdout + result.stderr).toContain("exclu"); expect(result.stdout).not.toContain("name: verify-interface"); expect(provider.requests).toHaveLength(0);
});

test("TECH — a project changed during verifier review cannot be saved using the obsolete draft", async () => {
  const ws = webProject(), provider = new ScriptedProvider([]), host = new Host(ws, { provider, argv: ["--allow-project-trust"], init: { decisionAuthority: true, demands: ["approval_request", "confirm_escalation", "notify", "request_user_choice"] }, userConfig: { engine: { control: { allowEscalation: true } } }, answers: {
    request_user_choice: () => ({ answers: [{ labels: ["Sans compte de test"] }] }),
    confirm_escalation: params => { writeFileSync(join(ws.project, "package.json"), "{}"); return { decision: "confirm", escalationId: params["escalationId"] }; },
  } });
  try {
    const reply = await host.request("invoke_command", { command: "/create-verifiers" }); expect(reply["ok"]).toBe(true); expect((reply["result"] as { refused: string }).refused).toContain("changé"); expect(host.demands("approval_request")).toHaveLength(0); expect(existsSync(skillPath(ws.project, "verify-interface"))).toBe(false);
  } finally { host.feed.end(); await host.finish(); }
});

test("TECH — secret-like answers are discarded before the verifier preview and prevent any save", async () => {
  const ws = webProject(), secret = "TOKEN=synthetic-sensitive-answer-65", provider = new ScriptedProvider([]), host = new Host(ws, { provider, argv: ["--allow-project-trust"], init: { decisionAuthority: true, demands: ["approval_request", "confirm_escalation", "notify", "request_user_choice"] }, userConfig: { engine: { control: { allowEscalation: true } } }, answers: { request_user_choice: () => ({ answers: [{ other: secret }] }) } });
  try {
    const reply = await host.request("invoke_command", { command: "/create-verifiers" }); expect(reply["ok"]).toBe(true); expect(JSON.stringify(reply)).not.toContain(secret); expect(host.demands("approval_request")).toHaveLength(0); expect(host.demands("confirm_escalation")).toHaveLength(0); expect(existsSync(skillPath(ws.project, "verify-interface"))).toBe(false);
  } finally { host.feed.end(); await host.finish(); }
});

test("TECH — the terminal offers a scrollable verifier preview before its two protected writes", async () => {
  const ws = webProject(), stop = new AbortController(), provider = new ScriptedProvider([]), run = interactive(["--allow-project-trust"], ws, { signal: stop.signal, provider });
  try {
    await run.idle(); run.type("/create-verifiers\r"); await run.waitFor(text => text.includes("compte de test")); await sleep(380); run.type("1");
    await run.waitFor(text => text.includes("Relire les compétences de vérification")); expect(existsSync(skillPath(ws.project, "verify-interface"))).toBe(false);
    await sleep(380); run.type("\u001b[6~"); run.type("1");
    await run.waitFor(() => run.screen().join("\n").includes("Autorisation requise")); await sleep(380); run.type("1");
    await run.waitFor(() => existsSync(skillPath(ws.project, "verify-interface")) && run.screen().join("\n").includes("Autorisation requise")); await sleep(380); run.type("1");
    await run.waitFor(text => text.includes("2 compétences enregistrées")); expect(existsSync(skillPath(ws.project, "verify-server"))).toBe(true); expect(provider.requests).toHaveLength(0);
  } finally { stop.abort(); await run.done; }
}, 15000);
