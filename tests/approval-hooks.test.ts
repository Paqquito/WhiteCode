// `approval_needed` hooks habilitated to answer a request (SPEC-PER-001 § 5.3 point c, SPEC-HOK-010 CA-06 to CA-10, SPEC-HOK-004 CA-04).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fingerprintOf } from "../src/hooks/config";
import { projectFileOf } from "../src/hooks/habilitation";
import { cli, workspace, type Workspace } from "./helpers/env";
import { prefix, productEnv, PROJECT_DIR, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

const userFile = (ws: Workspace) => join(ws.configHome, "config.json");
/** A `run_shell` call: in the `ask` mode (a run without interface defaults to `no_prompt`), it needs an answer (point c). */
const shellCall = () => new ScriptedProvider([{ toolCalls: [{ name: "run_shell", input: { command: "printf hello-from-shell" } }] }, { text: "done" }]);
const toolResult = (p: ScriptedProvider) => JSON.stringify(p.requests[1]?.history ?? []);
const run = (ws: Workspace, provider: ScriptedProvider, userConfig: Record<string, unknown>, args: string[] = []) =>
  cli(["--non-interactive", ...(args.includes("--approval-mode") ? [] : ["--approval-mode", "ask"]), ...args, "x"], ws, { provider, userConfig, env: productEnv(ws) });

/** A user-scope declaration `id` and the entry that habilitates it. */
function declared(ws: Workspace, id: string, command: string) {
  const declaration = { id, actions: [{ type: "command", command }] };
  return { declaration, entry: { scope: "user", file: userFile(ws), id, fingerprint: fingerprintOf("approval_needed", declaration) } };
}

describe("habilitated approval hooks", () => {
  test("SPEC-PER-001/CA-12 — mode ask, a request about to be shown and a habilitated hook answering allow: allowed without display, without a rule", async () => {
    const ws = workspace();
    const r = record(ws, "policy", { decision: "allow" });
    const { declaration, entry } = declared(ws, "policy", r.command);
    const p = shellCall();
    const res = await run(ws, p, { hooks: { approval_needed: [declaration] }, permissions: { decisionHooks: [entry] } });
    expect(res.code).toBe(0);
    expect(r.read()[0]).toMatchObject({ event: "approval_needed", toolId: "run_shell", toolArguments: { command: "printf hello-from-shell" } });
    expect(toolResult(p)).toContain("hello-from-shell");
    expect(toolResult(p)).not.toContain("Not allowed in this run");
    expect(JSON.parse(readFileSync(userFile(ws), "utf8")).permissions.allowRules ?? []).toEqual([]);
  });

  test("SPEC-HOK-010/CA-06 — SPEC-PER-001/CA-19 — an approved project whose approval_needed hook is not habilitated: it does not decide", async () => {
    const ws = workspace();
    const r = record(ws, "project-policy", { decision: "allow" });
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ hooks: { approval_needed: [{ id: "policy", actions: [{ type: "command", command: r.command }] }] } }));
    const p = shellCall();
    const res = await run(ws, p, {}, ["--allow-project-trust"]);
    expect(r.read()).toHaveLength(1); // it runs, but its answer is not a decision
    expect(toolResult(p)).toContain("Not allowed in this run");
    expect(res.stderr).toContain("project/approval_needed/policy : non habilité à répondre aux demandes");
  });

  test("SPEC-HOK-010/CA-08 — SPEC-PER-001/CA-26 — a project hook with the identifier of a hook habilitated in the user scope: it is not habilitated", async () => {
    const ws = workspace();
    const silent = record(ws, "user-policy");
    const { declaration, entry } = declared(ws, "policy", silent.command);
    const projectHook = record(ws, "project-policy", { decision: "allow" });
    ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ hooks: { approval_needed: [{ id: "policy", actions: [{ type: "command", command: projectHook.command }] }] } }));
    const p = shellCall();
    await run(ws, p, { hooks: { approval_needed: [declaration] }, permissions: { decisionHooks: [entry] } }, ["--allow-project-trust"]);
    expect(silent.read()).toHaveLength(1);
    expect(projectHook.read()).toHaveLength(1);
    expect(toolResult(p)).toContain("Not allowed in this run");
  });

  test("SPEC-HOK-010/CA-07 — mode no_prompt and a habilitated approval_needed hook: the hook is not invoked", async () => {
    const ws = workspace();
    const r = record(ws, "policy", { decision: "allow" });
    const { declaration, entry } = declared(ws, "policy", r.command);
    const p = shellCall();
    await run(ws, p, { hooks: { approval_needed: [declaration] }, permissions: { decisionHooks: [entry] } }, ["--approval-mode", "no_prompt"]);
    expect(r.read()).toEqual([]);
    expect(toolResult(p)).toContain("Not allowed in this run");
  });

  test("SPEC-HOK-010/CA-09 — SPEC-PER-001/CA-27 — permissions.decisionHooks in the local file of the project: ignored with a warning", async () => {
    const ws = workspace();
    const r = record(ws, "policy", { decision: "allow" });
    const { declaration, entry } = declared(ws, "policy", r.command);
    ws.write(`project/${PROJECT_DIR}/config.local.json`, JSON.stringify({ permissions: { decisionHooks: [entry] } }));
    const p = shellCall();
    const res = await run(ws, p, { hooks: { approval_needed: [declaration] } }, ["--allow-project-trust"]);
    expect(res.stderr).toContain("`permissions.decisionHooks` n'est pas autorisé dans les paramètres de portée locale");
    expect(toolResult(p)).toContain("Not allowed in this run");
  });

  test("SPEC-HOK-010/CA-10 — a project hook listed in permissions.decisionHooks in the user scope: the entry is ignored with a warning, the hook does not decide", async () => {
    const ws = workspace();
    const r = record(ws, "project-policy", { decision: "allow" });
    const declaration = { id: "policy", actions: [{ type: "command", command: r.command }] };
    const file = ws.write(`project/${PROJECT_DIR}/config.json`, JSON.stringify({ hooks: { approval_needed: [declaration] } }));
    const p = shellCall();
    const res = await run(ws, p, { permissions: { decisionHooks: [{ scope: "project", file, id: "policy", fingerprint: fingerprintOf("approval_needed", declaration) }] } }, ["--allow-project-trust"]);
    expect(res.stderr).toContain("seul un crochet déclaré hors du projet (portée utilisateur ou gérée) peut être habilité");
    expect(toolResult(p)).toContain("Not allowed in this run");
  });

  test("SPEC-PER-001/CA-28 — a habilitated hook whose declaration was modified: it is no longer habilitated", async () => {
    const ws = workspace();
    const r = record(ws, "policy", { decision: "allow" });
    const { declaration, entry } = declared(ws, "policy", r.command);
    const p = shellCall();
    const res = await run(ws, p, { hooks: { approval_needed: [{ ...declaration, match: "run_shell" }] }, permissions: { decisionHooks: [entry] } });
    expect(res.stderr).toContain("le crochet user/approval_needed/policy a été modifié depuis son habilitation ; il ne décide plus (empreinte actuelle : sha256:");
    expect(toolResult(p)).toContain("Not allowed in this run");
  });

  test("SPEC-PER-001/CA-31 — a user hook whose action launches a project script: the entry is ignored with a warning, the hook does not decide", async () => {
    const ws = workspace();
    const dirs = [ws.project];
    ws.write("project/check.py", "print('{}')\n");
    expect(projectFileOf("./scripts/verifier.sh", dirs)).toContain("chemin relatif");
    expect(projectFileOf("npm run check", dirs)).toContain("script défini par le projet");
    expect(projectFileOf("yarn lint", dirs)).toContain("script défini par le projet");
    expect(projectFileOf("bun run policy", dirs)).toContain("script défini par le projet");
    expect(projectFileOf("python check.py", dirs)).toContain("fichier du projet");
    expect(projectFileOf(`bash "${join(ws.project, "x.sh")}"`, dirs)).toContain("fichier du projet");
    expect(projectFileOf(`"$${prefix}PROJECT_DIR/hook.sh"`, dirs)).toContain("dossier du projet");
    expect(projectFileOf(`"${process.execPath}" "${join(ws.root, "scripts", "policy.ts")}"`, dirs)).toBeUndefined();
    expect(projectFileOf("curl -s https://policy.example.test/check --data @-", dirs)).toBeUndefined();
    const { declaration, entry } = declared(ws, "policy", "npm run approve");
    const p = shellCall();
    const res = await run(ws, p, { hooks: { approval_needed: [declaration] }, permissions: { decisionHooks: [entry] } });
    expect(res.stderr).toContain("le crochet user/approval_needed/policy ne peut pas être habilité : la commande lance un script défini par le projet (npm run)");
    expect(toolResult(p)).toContain("Not allowed in this run");
  }, 30_000); // a cold start of PowerShell on the Windows runners can take several seconds

  test("TECH — SPEC-PER-001 § 5.3 point c — an incomplete entry is ignored, and the warning gives the identity to copy", async () => {
    const ws = workspace();
    const r = record(ws, "policy", { decision: "allow" });
    const { declaration, entry } = declared(ws, "policy", r.command);
    const res = await run(ws, shellCall(), { hooks: { approval_needed: [declaration] }, permissions: { decisionHooks: [{ scope: "user", id: "policy" }] } });
    expect(res.stderr).toContain("identité incomplète");
    expect(res.stderr).toContain(JSON.stringify(entry));
  });

  test("SPEC-HOK-004/CA-04 — a server that answers a refusal on approval_needed: the permission is refused", async () => {
    const ws = workspace();
    const received: unknown[] = [];
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (req) => (received.push(await req.json()), Response.json({ decision: "deny", reason: "outside the change window" })) });
    servers.push(s);
    const declaration = { id: "server", actions: [{ type: "http", url: `http://127.0.0.1:${s.port}/approve` }] };
    const entry = { scope: "user", file: userFile(ws), id: "server", fingerprint: fingerprintOf("approval_needed", declaration) };
    const p = shellCall();
    const res = await run(ws, p, { hooks: { approval_needed: [declaration] }, permissions: { decisionHooks: [entry] } });
    expect(received).toHaveLength(1);
    expect(res.stderr).toContain("Bloqué par un crochet (approval_needed) : user/approval_needed/server : outside the change window");
    expect(toolResult(p)).toContain("Denied by an approval hook.");
  });
});
