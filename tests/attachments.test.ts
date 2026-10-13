// Attachments and automatic context of a message (SPEC-MOT-006): the references `@` resolved before the sending, the
// limits, the permissions of reading, the files changed outside the agent.
import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelRequest } from "../src/providers/types";
import { cli, workspace, type Workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";

const sent = (p: ScriptedProvider, i = 0) => JSON.stringify(p.requests[i]?.history ?? []);
const lines = (n: number, prefix = "ligne") => Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";
const ask = async (ws: Workspace, prompt: string, args: string[] = [], userConfig?: Record<string, unknown>) => {
  const p = new ScriptedProvider([{ text: "vu" }]);
  const r = await cli(["--non-interactive", ...args, prompt], ws, { provider: p, ...(userConfig ? { userConfig } : {}) });
  return { p, r, history: sent(p) };
};

test("SPEC-IHM-007/CA-10 — an agent and a file named revue: ampersand selects the agent and at-sign attaches the file without starting an agent", async () => {
  const ws = workspace();
  ws.write("home/config/agents/revue.md", '---\nname: revue\ndescription: Review the requested code.\n---\nRead and review only.\n');
  ws.write("project/revue", "FILE_REVIEW_641");
  const agent = await ask(ws, "&revue examine ceci");
  expect(agent.r.code).toBe(0);
  expect(agent.history).toContain('<requested-agent name=\\"revue\\">');
  expect(agent.history).not.toContain("FILE_REVIEW_641");
  expect(agent.p.requests.filter(r => r.purpose === "subagent")).toHaveLength(0);
  const file = await ask(ws, "@revue examine ceci");
  expect(file.history).toContain("FILE_REVIEW_641");
  expect(file.history).not.toContain("<requested-agent");
  const literal = await ask(ws, "&&revue `&revue` \\&revue");
  expect(literal.history).not.toContain("<requested-agent");
});

describe("SPEC-MOT-006 references", () => {
  test("SPEC-MOT-006/CA-01 — « explique @src/a.ts »: the content of src/a.ts is attached, numbered", async () => {
    const ws = workspace();
    ws.write("project/src/a.ts", "const a = 1;\nexport default a;\n");
    const { history } = await ask(ws, "explique @src/a.ts");
    expect(history).toContain('<attached-file path=\\"src/a.ts\\">');
    expect(history).toContain("1\\tconst a = 1;\\n2\\texport default a;");
    expect(history).toContain("explique @src/a.ts"); // the reference stays in the text
  });

  test("SPEC-MOT-006/CA-02 — @src/a.ts#L5-9: only the lines 5 to 9 are attached", async () => {
    const ws = workspace();
    ws.write("project/src/a.ts", lines(20));
    const { history } = await ask(ws, "regarde @src/a.ts#L5-9");
    expect(history).toContain('lines=\\"5-9\\"');
    expect(history).toContain("5\\tligne 5");
    expect(history).toContain("9\\tligne 9");
    expect(history).not.toContain("4\\tligne 4");
    expect(history).not.toContain("10\\tligne 10");
  });

  test("SPEC-MOT-006/CA-05 — a refusal rule on secrets/**: @secrets/k.env is not attached", async () => {
    const ws = workspace();
    ws.write("project/secrets/k.env", "CLE=tres-secrete\n");
    const { history, r } = await ask(ws, "lis @secrets/k.env", ["--deny-rule", "read_file(secrets/**)"]);
    expect(history).not.toContain("tres-secrete");
    expect(r.stderr).toContain("Ce fichier n'est pas accessible : secrets/k.env.");
  });

  test("SPEC-MOT-006/CA-06 — an absolute path with its drive, such as @C:\\projet\\notes.md: the file is attached, no connector is asked", async () => {
    const ws = workspace();
    const notes = ws.write("project/notes.md", "note absolue\n");
    const { history } = await ask(ws, `résume @${notes}`); // under Windows, C:\…\project\notes.md
    expect(history).toContain("1\\tnote absolue");
  });

  test("SPEC-MOT-006/CA-07 — a reference of a messaging connector, @equipe:dev: nothing is attached, the reference stays", async () => {
    const ws = workspace();
    const { history } = await ask(ws, "préviens @equipe:dev du déploiement");
    expect(history).toContain("préviens @equipe:dev du déploiement");
    expect(history).not.toContain("attached-");
  });

  test("SPEC-MOT-006/CA-04 — a file read, then changed in an external editor: the next message brings a notice of the change", async () => {
    const ws = workspace();
    const file = ws.write("project/conf.txt", "valeur=1\n");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: file } }] }, { text: "lu" }, { text: "noté" }]);
    const h = new Host(ws, { provider: p, init: {} });
    h.user("lis conf.txt");
    await h.waitFor((m) => m.type === "turn_completed" && m["turn"] === 1);
    writeFileSync(file, "valeur=2, modifiée ailleurs\n");
    h.user("et maintenant ?");
    await h.waitFor((m) => m.type === "turn_completed" && m["turn"] === 2);
    h.feed.end();
    await h.finish();
    const last = sent(p, 2);
    expect(last).toContain("was changed outside this conversation since you last read it");
    expect(last.split("was changed outside").length - 1).toBe(1); // once
  });
});

describe("SPEC-MOT-006 limits and forms", () => {
  test("TECH — a folder is listed, a quoted path with spaces is attached, a reference in code is not, the same file once (EF-01, EF-02)", async () => {
    const ws = workspace();
    ws.write("project/docs/guide.md", "g\n");
    ws.write("project/docs/annexe/x.md", "x\n");
    ws.write("project/mes notes.txt", "avec espaces\n");
    ws.write("project/a.txt", "contenu A\n");
    const { history } = await ask(ws, 'compare @docs/ et @"mes notes.txt" avec `@a.txt` puis @a.txt et @a.txt');
    expect(history).toContain('<attached-folder path=\\"docs\\">\\nannexe/\\nguide.md');
    expect(history).toContain("1\\tavec espaces");
    expect(history.split("1\\tcontenu A").length - 1).toBe(1);
  });

  test("TECH — a file beyond the limit of an attachment: its start only, with the truncation and the number of lines (FA-03, EF-04)", async () => {
    const ws = workspace();
    ws.write("project/gros.txt", lines(500, "une ligne assez longue de texte numéro"));
    const { history } = await ask(ws, "lis @gros.txt", [], { context: { attachments: { maxTokens: 200 } } });
    expect(history).toContain("1\\tune ligne assez longue de texte numéro 1");
    expect(history).toMatch(/\[Truncated: lines 1–\d+ of 500; read the rest with read_file\.\]/);
    expect(history).not.toContain("numéro 400");
  });

  test("TECH — a file attached whole counts as read: it can be edited at once (step 6)", async () => {
    const ws = workspace();
    const file = ws.write("project/a.txt", "avant\n");
    const p = new ScriptedProvider([{ toolCalls: [{ name: "edit_file", input: { path: file, old_text: "avant", new_text: "après" } }] }, { text: "fait" }]);
    await cli(["--non-interactive", "--approval-mode", "auto_edit", "corrige @a.txt"], ws, { provider: p });
    expect(JSON.stringify(p.requests[1]!.history.at(-1))).not.toContain("Read the file before");
    expect(readFileSync(file, "utf8")).toBe("après\n");
  });
});
