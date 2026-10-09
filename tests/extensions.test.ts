// Extensions: format (SPEC-EXT-001), loading (SPEC-EXT-011), validation (SPEC-EXT-012), session extensions
// (SPEC-EXT-014) and options (SPEC-EXT-015).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { cli, workspace, type Workspace } from "./helpers/env";
import { BUN, productEnv, record } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

const SERVER = join(import.meta.dir, "helpers", "mcp-server.ts").replace(/\\/g, "/");

/** An extension folder `ext/<folder>` with the given files (objects written as JSON). */
function extension(ws: Workspace, folder: string, files: Record<string, unknown>): string {
  for (const [path, content] of Object.entries(files)) ws.write(`ext/${folder}/${path}`, typeof content === "string" ? content : JSON.stringify(content));
  return join(ws.root, "ext", folder);
}
const manifest = (name: string, extra: Record<string, unknown> = {}) => ({ name, version: "1.0.0", description: `The ${name} extension.`, ...extra });
const skill = (description: string, body = "body") => `---\ndescription: ${JSON.stringify(description)}\n---\n${body}\n`;
const validate = (ws: Workspace, path: string, json = false) => cli(["extension", "validate", path, ...(json ? ["--json"] : [])], ws, { env: productEnv(ws) });
const run = (ws: Workspace, provider: ScriptedProvider, args: string[], userConfig: Record<string, unknown> = {}) => cli(["--non-interactive", ...args], ws, { provider, userConfig, env: productEnv(ws) });
const system = (p: ScriptedProvider) => JSON.stringify(p.requests[0]?.system ?? []);

describe("SPEC-EXT-001 and SPEC-EXT-012 format and validation", () => {
  test("SPEC-EXT-011/CA-03 — an invalid extension agent is reported while its valid skill and hook still load", async () => {
    const ws = workspace();
    const opened = record(ws, "mixed-opened");
    const path = extension(ws, "partial", { "extension.json": manifest("partial"), "agent-profiles/bad.md": '---\nname: [broken\n---\n', "skills/good/definition.md": skill("A valid skill."), "event-hooks.json": { hooks: { session_opened: [{ actions: [{ type: "command", command: opened.command }] }] } } });
    ws.write("ext/partial/agent-profiles/good.md", '---\nname: good\ndescription: A valid extension agent.\n---\nEXTENSION AGENT INSTRUCTIONS\n');
    const p = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { role: "partial:good", description: "Check the project.", prompt: "Report." } }] }, { text: "Finished." }], [{ text: "Agent report." }]);
    const r = await run(ws, p, ["--extension-dir", path, "Work."]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("agent");
    expect(r.stderr).toContain("bad");
    expect(system(p)).toContain("partial:good");
    expect(opened.read()).toHaveLength(1);
    expect(p.requests.some((r) => r.purpose === "subagent" && JSON.stringify(r.system).includes("EXTENSION AGENT INSTRUCTIONS"))).toBe(true);
  });
  test("SPEC-EXT-001/CA-01 — SPEC-EXT-012/CA-01 — a conforming extension with a skill and a hook: validation succeeds, lists both, exit code 0", async () => {
    const ws = workspace();
    const path = extension(ws, "outils", {
      "extension.json": manifest("outils"),
      "skills/revue/definition.md": skill("Reviews a change."),
      "event-hooks.json": { hooks: { session_opened: [{ actions: [{ type: "command", command: "echo hi" }] }] } },
    });
    const r = await validate(ws, path);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("compétences : outils:revue");
    expect(r.stdout).toContain("crochets : 1");
    expect(r.stdout).toContain("information : ");
    expect(r.stdout).toContain("Validation réussie.");
  });

  test("SPEC-EXT-001/CA-02 — a path ../x in components: the component is refused", async () => {
    const ws = workspace();
    const r = await validate(ws, extension(ws, "bad", { "extension.json": manifest("bad", { components: { skills: "../x" } }) }));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Chemin de composant non autorisé : ../x (skills).");
  });

  test("SPEC-EXT-001/CA-03 — an extension named project: validation fails (reserved name)", async () => {
    const ws = workspace();
    const r = await validate(ws, extension(ws, "p", { "extension.json": manifest("project") }));
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Le nom project est réservé au produit.");
  });

  test("SPEC-EXT-012/CA-02 — a manifest without version: an error is reported and the code is 1; --json gives the structured report", async () => {
    const ws = workspace();
    const { version: _v, ...noVersion } = manifest("nover");
    const path = extension(ws, "nover", { "extension.json": noVersion });
    const r = await validate(ws, path);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("champ obligatoire manquant `version`");
    const j = await validate(ws, path, true);
    const doc = JSON.parse(j.stdout);
    expect(doc.valid).toBe(false);
    expect(doc.problems[0]).toMatchObject({ level: "error", file: join(path, "extension.json") });
    expect((await validate(ws, join(ws.root, "nowhere"))).code).toBe(2);
  });
});

describe("SPEC-EXT-011 and SPEC-EXT-014 loading", () => {
  test("SPEC-EXT-011/CA-01 — SPEC-EXT-014/CA-01 — --extension-dir: skill outils:revue, hook and connector of the extension are available, variables substituted", async () => {
    const ws = workspace();
    const r = record(ws, "ext-hook");
    const path = extension(ws, "outils", {
      "extension.json": manifest("outils"),
      "skills/revue/definition.md": skill("Reviews with the extension checklist."),
      "event-hooks.json": { hooks: { session_opened: [{ actions: [{ type: "command", command: r.command }] }] } },
      "docs.json": { tools: [{ name: "search" }] },
      "connectors.json": { servers: { docs: { transport: "stdio", command: BUN, args: [SERVER, "${EXTENSION_ROOT}/docs.json"] } } },
    });
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p, ["--wait-for-mcp", "--extension-dir", path, "x"]);
    expect(res.stderr).toContain("Extension de développement active : outils@session (1.0.0) — 1 compétence(s), 0 commande(s), 1 crochet(s), 1 connecteur(s).");
    expect(system(p)).toContain("- outils:revue: Reviews with the extension checklist.");
    expect(r.read()).toHaveLength(1);
    expect((p.requests[0]?.tools ?? []).map((t) => t.name)).toContain("cnx_outils-docs_search");
  });

  test("SPEC-EXT-011/CA-02 — two extensions providing the command deploy: /a:deploy and /b:deploy exist, /deploy does not", async () => {
    const ws = workspace();
    const a = extension(ws, "a", { "extension.json": manifest("a"), "commands/deploy.md": "Deploy with A: ${ARGS}" });
    const b = extension(ws, "b", { "extension.json": manifest("b"), "commands/deploy.md": "Deploy with B: ${ARGS}" });
    const short = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, short, ["--extension-dir", a, "--extension-dir", b, "/deploy prod"]);
    expect(res.stderr).toContain("Plusieurs commandes portent le nom deploy : utilisez /a:deploy ou /b:deploy.");
    expect(short.requests).toHaveLength(0);
    const qualified = new ScriptedProvider([{ text: "done" }]);
    await run(ws, qualified, ["--extension-dir", b, "--extension-dir", a, "/b:deploy prod"]);
    expect(JSON.stringify(qualified.requests[0]?.history)).toContain("Deploy with B: prod");
  });

  test("TECH — SPEC-EXT-011/ERR-01, ERR-03, FA-03; SPEC-EXT-014/ERR-01, FA-01 — an invalid component is reported, the others load; two extensions of one name: neither; a missing folder or managedOnly stop the launch", async () => {
    const ws = workspace();
    const path = extension(ws, "mixed", { "extension.json": manifest("mixed"), "skills/ok/definition.md": skill("Works."), "skills/bad/definition.md": "---\nname: [x\n---\n", "event-hooks.json": "{ oops" });
    const p = new ScriptedProvider([{ text: "done" }]);
    const res = await run(ws, p, ["--extension-dir", path, "x"]);
    expect(system(p)).toContain("- mixed:ok: Works.");
    expect(res.stderr).toContain("Compétence bad ignorée : en-tête invalide");
    expect(res.stderr).toContain("composant");
    const twin = extension(ws, "twin", { "extension.json": manifest("mixed") });
    const both = await run(ws, new ScriptedProvider([{ text: "done" }]), ["--extension-dir", path, "--extension-dir", twin, "x"]);
    expect(both.stderr).toContain("Deux extensions actives portent le nom mixed");
    const missing = await run(ws, new ScriptedProvider([]), ["--extension-dir", join(ws.root, "none"), "x"]);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Dossier d'extension introuvable");
    ws.write("managed/policy.json", JSON.stringify({ extensions: { managedOnly: true } }));
    const managed = await run(ws, new ScriptedProvider([]), ["--extension-dir", path, "x"]);
    expect(managed.code).toBe(2);
    expect(managed.stderr).toContain("seules les extensions gérées sont admises");
  });
});

describe("SPEC-EXT-015 options", () => {
  test("SPEC-EXT-015/CA-02 — a required option not given: the dependent components are disabled with a notice; given, they run", async () => {
    const ws = workspace();
    const r = record(ws, "opt-hook");
    const path = extension(ws, "notify", {
      "extension.json": manifest("notify", { options: { type: "object", properties: { channel: { type: "string" } }, required: ["channel"] } }),
      "event-hooks.json": { hooks: { session_opened: [{ actions: [{ type: "command", command: `${r.command} \${OPTION:channel}` }] }] } },
    });
    const without = await run(ws, new ScriptedProvider([{ text: "done" }]), ["--extension-dir", path, "x"]);
    expect(without.stderr).toContain("Extension notify@session : crochet session_opened #1 désactivé : option requise channel non renseignée.");
    expect(r.read()).toHaveLength(0);
    await run(ws, new ScriptedProvider([{ text: "done" }]), ["--extension-dir", path, "x"], { extensions: { options: { notify: { channel: "team" } } } });
    expect(r.read()).toHaveLength(1);
    const invalid = await run(ws, new ScriptedProvider([{ text: "done" }]), ["--extension-dir", path, "x"], { extensions: { options: { notify: { channel: 42 } } } });
    expect(invalid.stderr).toContain("Valeur invalide pour channel");
  });
});
