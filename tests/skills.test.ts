// Skills (SPEC-EXT-019, SPEC-EXT-020) and the prompt commands of a request (SPEC-CMD-001, part needed by lot 4).
import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { recognize } from "../src/commands/recognize";
import { cli, workspace, type Workspace } from "./helpers/env";
import { productEnv, PROJECT_DIR } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const definition = (header: Record<string, unknown>, body: string) =>
  `---\n${Object.entries(header)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join("\n")}\n---\n${body}\n`;
const projectSkill = (ws: Workspace, name: string, header: Record<string, unknown>, body: string) => ws.write(`project/${PROJECT_DIR}/skills/${name}/definition.md`, definition(header, body));
const userSkill = (ws: Workspace, name: string, header: Record<string, unknown>, body: string) => {
  const path = join(ws.configHome, "skills", name, "definition.md");
  ws.write(`home/config/skills/${name}/definition.md`, definition(header, body));
  return path;
};
const system = (p: ScriptedProvider, i = 0) => JSON.stringify(p.requests[i]?.system ?? []);
const history = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]?.history ?? []);
const toolNames = (p: ScriptedProvider, i: number) => (p.requests[i]?.tools ?? []).map((t) => t.name);
const run = (ws: Workspace, provider: ScriptedProvider, args: string[], userConfig: Record<string, unknown> = {}, stdin?: string) =>
  cli(["--non-interactive", ...args], ws, { provider, userConfig, env: productEnv(ws), stdin });

describe("SPEC-EXT-019 skills", () => {
  test("SPEC-EXT-019/CA-01 — a valid project skill: its name and description are in the system instructions, not its content", async () => {
    const ws = workspace();
    projectSkill(ws, "revue", { description: "Reviews a change against the team checklist." }, "SECRET-CHECKLIST-BODY");
    const p = new ScriptedProvider([{ text: "done" }]);
    await run(ws, p, ["--allow-project-trust", "x"]);
    expect(system(p)).toContain("- revue: Reviews a change against the team checklist.");
    expect(system(p)).not.toContain("SECRET-CHECKLIST-BODY");
    expect(toolNames(p, 0)).toContain("use_skill");
  });

  test("SPEC-EXT-019/CA-02 — a skill changed during the session: the new description is taken and the model is told", async () => {
    const ws = workspace();
    const file = userSkill(ws, "deploy", { description: "Old description." }, "body");
    const a = ws.write("project/a.txt", "a\n");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    let changed = false;
    await cli(["--non-interactive", "x"], ws, {
      provider: p,
      env: productEnv(ws),
      extra: {
        onEvent: (e) => {
          if (e.type !== "tool_result" || changed) return;
          changed = true;
          writeFileSync(file, definition({ description: "New description, with deploy steps for staging." }, "body"));
        },
      },
    });
    expect(history(p, 1)).toContain("The available skills changed.");
    expect(history(p, 1)).toContain("deploy (updated): New description, with deploy steps for staging.");
  });

  test("SPEC-EXT-019/CA-03 — SPEC-EXT-020/CA-04 — invocation user: not listed for the model, and use_skill refuses it", async () => {
    const ws = workspace();
    userSkill(ws, "release", { description: "Cuts a release.", invocation: "user" }, "body");
    userSkill(ws, "notes", { description: "Writes notes." }, "body");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "release" } }] }, { text: "done" }]);
    await run(ws, p, ["x"]);
    expect(system(p)).not.toContain("release");
    expect(history(p, 1)).toContain("This skill cannot be invoked this way: release is reserved to the user.");
  });

  test("SPEC-EXT-019/CA-04 — two skills revue (project and user): the project one is used", async () => {
    const ws = workspace();
    projectSkill(ws, "revue", { description: "Project review." }, "project body");
    userSkill(ws, "revue", { description: "User review." }, "user body");
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p, ["--allow-project-trust", "x"]);
    expect(system(p)).toContain("- revue: Project review.");
    expect(system(p)).not.toContain("User review.");
    expect(res.stderr).toContain("La compétence revue de portée user est masquée par celle de portée project.");
  });

  test("TECH — SPEC-EXT-019/FA-01, FA-02, ERR-01, ERR-02 — project skill of a folder not approved ignored; simple commands for the user only; invalid headers reported", async () => {
    const ws = workspace();
    projectSkill(ws, "revue", { description: "Project review." }, "body");
    ws.write("home/config/commands/standup.md", "Summarise what changed since yesterday: ${ARGS}\n");
    ws.write("home/config/skills/broken/definition.md", "---\nname: [unclosed\n---\nbody\n");
    userSkill(ws, "silent", { name: "silent" }, "body");
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p, ["x"]);
    expect(system(p)).not.toContain("revue");
    expect(system(p)).not.toContain("standup");
    expect(res.stderr).toContain("Compétence broken ignorée : en-tête invalide");
    expect(res.stderr).toContain("Compétence silent ignorée : en-tête invalide : description absente.");
    const cmd = new ScriptedProvider([{ text: "done" }]);
    await run(ws, cmd, ["/standup the API work"]);
    expect(history(cmd, 0)).toContain("Summarise what changed since yesterday: the API work");
  });
});

describe("SPEC-EXT-020 invocation of skills", () => {
  test("SPEC-EXT-020/CA-01 — a skill using ${ARGS}: /revue module-auth puts module-auth in the content, with the skill named", async () => {
    const ws = workspace();
    userSkill(ws, "revue", { description: "Review." }, "Review the module ${ARGS} with care; root ${SKILL_ROOT}.");
    const p = new ScriptedProvider([{ text: "done" }]);
    await run(ws, p, ["/revue module-auth"]);
    const h = history(p, 0);
    expect(h).toContain("Review the module module-auth with care");
    expect(h).toContain('<skill name=\\"revue\\" scope=\\"user\\" invoked=\\"/revue module-auth\\">');
    const text = (p.requests[0]!.history[0] as unknown as { parts: Array<{ text: string }> }).parts[0]!.text;
    expect(text).toContain(`root ${join(ws.configHome, "skills", "revue")}.`);
  });

  test("SPEC-EXT-020/CA-02 — a skill with tools [run_shell(echo skill-ok)]: allowed without request while active; after the turn, a request again", async () => {
    const ws = workspace();
    userSkill(ws, "check", { description: "Runs the check.", tools: ["run_shell(echo skill-ok)"] }, "Run `echo skill-ok`.");
    const shell = { toolCalls: [{ name: "run_shell", input: { command: "echo skill-ok" } }] };
    const p = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "check" } }] }, shell, { text: "first done" }, shell, { text: "second done" }]);
    const stdin = [JSON.stringify({ type: "user", content: "run the check" }), JSON.stringify({ type: "user", content: "again" })].join("\n") + "\n";
    await run(ws, p, ["--approval-mode", "ask", "--request-format", "jsonl"], {}, stdin);
    expect(history(p, 2)).toContain('"text":"skill-ok"');
    expect(history(p, 2)).not.toContain("Not allowed in this run");
    expect(history(p, 4).split("Not allowed in this run: run_shell(echo skill-ok)")).toHaveLength(2);
  });

  test("TECH — SPEC-EXT-020 § 5.3 step 1 — a deny rule use_skill(check) refuses the invocation", async () => {
    const ws = workspace();
    userSkill(ws, "check", { description: "Runs the check." }, "body");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "use_skill", input: { name: "check" } }] }, { text: "done" }]);
    await run(ws, p, ["x"], { permissions: { denyRules: ["use_skill(che*)"] } });
    expect(history(p, 1)).toContain("Denied by the rule use_skill(che*)");
  });
});

describe("SPEC-CMD-001 commands in a request", () => {
  test("SPEC-CMD-001/CA-02 — an unknown name: suggestions are shown and nothing is sent to the model", async () => {
    const ws = workspace();
    userSkill(ws, "revue", { description: "Review." }, "body");
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p, ["/revu the change"]);
    expect(res.stderr).toContain("Commande inconnue : /revu. Noms proches : /revue.");
    expect(p.requests).toHaveLength(0);
  });

  test("SPEC-CMD-001/CA-05 — a prompt command with a required argument missing: the usage is shown and nothing is sent", async () => {
    const ws = workspace();
    userSkill(ws, "migrate", { description: "Migrates a table.", argumentsHelp: "<table>" }, "Migrate the table $1.");
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p, ["/migrate"]);
    expect(res.stderr).toContain("La compétence migrate attend des arguments (<table>).");
    expect(p.requests).toHaveLength(0);
  });

  test("SPEC-CMD-001/CA-06 — a command whose tools go beyond the current mode: they do not widen the permissions", async () => {
    const ws = workspace();
    userSkill(ws, "scaffold", { description: "Creates files.", tools: ["write_file"] }, "Create the file.");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: join(ws.project, "new.txt"), content: "x" } }] }, { text: "done" }]);
    await run(ws, p, ["--approval-mode", "planning", "/scaffold"]);
    expect(history(p, 1)).toContain("Planning mode: no modification is allowed.");
  });

  test("SPEC-CMD-001/CA-07 — an entry starting with a double slash: sent as literal text", async () => {
    expect(recognize("//etc/hosts explain")).toEqual({ kind: "text", text: "/etc/hosts explain" });
    expect(recognize("  /revue x y")).toEqual({ kind: "command", name: "revue", args: "x y" });
    expect(recognize("/ not a command")).toEqual({ kind: "text", text: "/ not a command" });
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "done" }]);
    await run(ws, p, ["//revue is a word"]);
    expect(history(p, 0)).toContain('"text":"/revue is a word"');
  });
});
