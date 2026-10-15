// The skills built into the product (lot 8, increment 6): batch (SPEC-EXT-021), debug (SPEC-EXT-022), promote-memory
// (SPEC-EXT-026), simplify (SPEC-EXT-028), skill-from-session (SPEC-EXT-029), config-guide (SPEC-EXT-031), verify
// (SPEC-EXT-032). Their behaviour belongs to the model; these tests check what the product gives it and enforces.
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { builtinSkills } from "../src/skills/builtin";
import { loadIdentity, workspace, type Workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { PROJECT_DIR } from "./helpers/hooks";
import { ScriptedProvider, type ScriptedResponse } from "./helpers/scripted-provider";

const identity = loadIdentity();
const history = (p: ScriptedProvider, i: number) => JSON.stringify(p.requests[i]!.history);
/** A host that approves every request of permission: the agreement of the user. */
const host = (ws: Workspace, steps: ScriptedResponse[], argv: string[] = [], userConfig: Record<string, unknown> = {}) => {
  const p = new ScriptedProvider(steps);
  const h = new Host(ws, { provider: p, argv, userConfig, init: { decisionAuthority: true }, answers: { approval_request: () => ({ decision: "allow" }) } });
  return { p, h };
};
const turn = async (h: Host, message: string, done: string) => {
  h.user(message);
  await h.waitFor((m) => m.type === "turn_completed" && JSON.stringify(m).includes(done));
};
const end = async (h: Host) => {
  h.feed.end();
  await h.finish();
};
function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-c", "user.name=test", "-c", "user.email=test@example.test", "-c", "init.defaultBranch=main", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

test("TECH — the built-in skills of the product have a valid header", () => {
  const skills = builtinSkills();
  expect(skills.map((s) => s.name).sort()).toEqual(["ai-api-guide", "batch", "config-guide", "debug", "filler-text", "loop", "memory-consolidation", "promote-memory", "schedule", "shortcut-help", "simplify", "skill-from-session", "verify"]);
  for (const s of skills) expect(s.description.length).toBeGreaterThan(40);
  expect(skills.filter((s) => s.invocation === "user").map((s) => s.name).sort()).toEqual(["debug", "filler-text", "skill-from-session"]);
});

describe("SPEC-EXT-021 batch", () => {
  test("SPEC-EXT-021/CA-01 — a renaming in 60 files: a split is proposed before any change", async () => {
    const ws = workspace();
    for (let i = 0; i < 60; i++) ws.write(`project/src/f${i}.ts`, `export const oldName${i} = ${i};\n`);
    const target = join(ws.project, "src", "names.ts");
    const { p, h } = host(ws, [{ toolCalls: [{ name: "write_file", input: { path: target, content: "export const newName0 = 0;\n" } }] }, { text: "Découpage proposé : 3 unités." }], ["--allow-rule", "write_file"]);
    await turn(h, "/batch renommer oldName en newName", "Découpage proposé");
    const state = await h.request("get_state");
    await end(h);
    const sent = history(p, 0);
    expect(sent).toContain("<skill name=\\\"batch\\\" scope=\\\"product\\\"");
    expect(sent).toContain("renommer oldName en newName");
    expect(sent).toContain("Submit the split with `submit_plan`");
    expect(sent).toContain("Between 1 and 20 units");
    expect(JSON.stringify(state)).toContain('"planning"');
    // The change attempted before the approval of the split is refused (EF-01).
    expect(history(p, 1)).toContain("Planning mode: no modification is allowed.");
    expect(existsSync(target)).toBe(false);
  }, 30_000);
});

describe("SPEC-EXT-022 debug", () => {
  test("SPEC-EXT-022/CA-01 — a hook that does not fire: the analysis is given the relevant lines of the journal", async () => {
    const ws = workspace();
    ws.write("project/notes.txt", "n");
    const hooks = { hooks: { before_tool: [{ match: "edit_file", actions: [{ type: "command", command: "echo jamais" }] }] } };
    const steps: ScriptedResponse[] = [{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "notes.txt") } }] }, { text: "lu" }, { text: "Le filtre edit_file écarte read_file." }];
    const { p, h } = host(ws, steps, ["--debug=hooks"], hooks);
    await turn(h, "lis notes.txt", "lu");
    await turn(h, "/debug le crochet before_tool ne se déclenche pas", "Le filtre");
    await end(h);
    const sent = history(p, 2);
    expect(sent).toContain("le crochet before_tool ne se déclenche pas");
    expect(sent).toMatch(/\[hooks\] event before_tool: 0 of 1 hook\(s\) selected/);
    expect(sent).toContain("user/before_tool/#1");
    expect(sent).toContain("Quote the relevant lines of the journal");
  }, 30_000);

  test("TECH — SPEC-EXT-022/EF-01, FA-01 — reserved to the user; without journal, it is enabled and a reproduction is asked", async () => {
    const ws = workspace();
    const steps: ScriptedResponse[] = [{ toolCalls: [{ name: "use_skill", input: { name: "debug" } }] }, { text: "non" }, { text: "Reproduisez." }];
    const { p, h } = host(ws, steps);
    await turn(h, "diagnostique-toi", "non");
    await turn(h, "/debug", "Reproduisez");
    await end(h);
    expect(history(p, 1)).toContain("This skill cannot be invoked this way: debug is reserved to the user.");
    expect(history(p, 2)).toContain("it is now enabled for this session");
  }, 30_000);
});

describe("SPEC-EXT-026 promote-memory", () => {
  test("SPEC-EXT-026/CA-01 — a memory describing a convention of the repository: its promotion to the project instructions is proposed", async () => {
    const ws = workspace();
    ws.write(`project/${identity.get("LOCAL_INSTRUCTIONS_FILE")}`, "- Les tests se lancent avec `bun test --bail`.\n");
    const { p, h } = host(ws, [{ text: "Proposition : promouvoir la convention des tests." }], ["--allow-project-trust"]);
    await turn(h, "/promote-memory", "Proposition");
    await end(h);
    const sent = history(p, 0);
    expect(sent).toContain("personal, this project");
    expect(sent).toContain("Les tests se lancent avec `bun test --bail`.");
    expect(sent).toContain(`belongs to the project instructions \`${identity.get("INSTRUCTIONS_FILE")}\``);
    expect(sent).toContain("remove it from its original layer");
  }, 30_000);
});

describe("SPEC-EXT-028 simplify", () => {
  test("SPEC-EXT-028/CA-01 — a duplicated function added while a helper exists: the code is changed to reuse the helper", async () => {
    const ws = workspace();
    ws.write("project/src/util.ts", "export const slug = (s: string) => s.toLowerCase().replace(/ /g, '-');\n");
    ws.write("project/src/app.ts", "export const title = 'A';\n");
    git(ws.project, "init", "-q");
    git(ws.project, "add", "-A");
    git(ws.project, "commit", "-q", "-m", "base");
    const app = join(ws.project, "src", "app.ts");
    ws.write("project/src/app.ts", "export const title = 'A';\nconst toSlug = (s: string) => s.toLowerCase().replace(/ /g, '-');\nexport const id = toSlug(title);\n");
    const reuse = "import { slug } from './util';\nexport const title = 'A';\nexport const id = slug(title);\n";
    const steps: ScriptedResponse[] = [{ toolCalls: [{ name: "read_file", input: { path: app } }] }, { toolCalls: [{ name: "write_file", input: { path: app, content: reuse } }] }, { text: "toSlug remplacée par slug." }];
    const { p, h } = host(ws, steps, ["--allow-rule", "write_file"]);
    await turn(h, "/simplify", "remplacée");
    await end(h);
    const sent = history(p, 0);
    expect(sent).toContain("+const toSlug = (s: string)");
    expect(sent).toContain("duplicates a helper that already exists in the project");
    expect(readFileSync(app, "utf8")).toBe(reuse);
  }, 30_000);
});

describe("SPEC-EXT-029 skill-from-session", () => {
  test("SPEC-EXT-029/CA-01 — a successful publication session: a parameterised skill is proposed, then saved after agreement", async () => {
    const ws = workspace();
    ws.write("project/package.json", JSON.stringify({ name: "outil", version: "1.2.0" }));
    const skillFile = join(ws.configHome, "skills", "publier", "definition.md");
    const document = '---\nname: publier\ndescription: "Publie une nouvelle version."\nargumentsHelp: <version>\ntools: ["read_file"]\n---\nLis package.json, puis publie la version $1.\n';
    const steps: ScriptedResponse[] = [
      { toolCalls: [{ name: "read_file", input: { path: join(ws.project, "package.json") } }] },
      { text: "Version 1.2.0 publiée." },
      { text: "Voici le document proposé : publier, avec la version en argument. Le valider ?" },
      { toolCalls: [{ name: "write_file", input: { path: skillFile, content: document } }] },
      { text: "Compétence enregistrée." },
    ];
    const { p, h } = host(ws, steps);
    await turn(h, "publie la version 1.2.0", "publiée");
    await turn(h, "/skill-from-session la publication", "Le valider");
    expect(existsSync(skillFile)).toBe(false); // nothing saved before the review
    await turn(h, "Oui, enregistre-la pour moi.", "enregistrée");
    await end(h);
    const sent = history(p, 2);
    expect(sent).toContain("User: publie la version 1.2.0");
    expect(sent).toContain("call read_file");
    expect(sent).toContain(join(ws.configHome, "skills").replace(/\\/g, "\\\\"));
    expect(readFileSync(skillFile, "utf8")).toContain("$1");
    // RG-01: available at once.
    expect(JSON.stringify(p.requests[4]!.history)).toContain("- publier (new): Publie une nouvelle version.");
  }, 30_000);
});

describe("SPEC-EXT-031 config-guide", () => {
  test("SPEC-EXT-031/CA-01 — « À chaque modification de fichier, lance le formateur »: an after_tool hook is proposed in the settings", async () => {
    const ws = workspace();
    const settingsFile = join(ws.configHome, "config.json");
    const steps: ScriptedResponse[] = [{ text: "Je propose un crochet after_tool sur write_file|edit_file qui lance le formateur." }];
    const { p, h } = host(ws, steps);
    await turn(h, "/config-guide À chaque modification de fichier, lance le formateur", "crochet after_tool");
    await end(h);
    const sent = history(p, 0);
    expect(sent).toContain("À chaque modification de fichier, lance le formateur");
    expect(sent).toContain("- after_tool (match on toolId)");
    expect(sent).toContain("is done with a hook");
    expect(sent).toContain(settingsFile.replace(/\\/g, "\\\\"));
    expect(sent).toContain("- hooks (user, project, local)");
  }, 30_000);
});

describe("SPEC-EXT-032 verify", () => {
  test("SPEC-EXT-032/CA-01 — a new option of the command line: the command is run with it and its output quoted in the report", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/verification.md`, "Lancer l'outil avec la nouvelle option et vérifier la sortie.\n");
    const steps: ScriptedResponse[] = [{ toolCalls: [{ name: "run_shell", input: { command: "printf 'format=json\\n'" } }] }, { text: "Vérifié : `outil --format json` affiche « format=json »." }];
    const { p, h } = host(ws, steps, ["--allow-project-trust"]);
    await turn(h, "/verify l'option --format", "Vérifié");
    await end(h);
    const sent = history(p, 0);
    expect(sent).toContain("The verification procedures of the project");
    expect(sent).toContain("Lancer l'outil avec la nouvelle option");
    expect(sent).toContain("run the command with the new or changed option");
    expect(history(p, 1)).toContain("format=json");
  }, 30_000);
});
