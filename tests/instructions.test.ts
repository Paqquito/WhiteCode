// Instructions of the user and the project (SPEC-MOT-004, SPEC-MOT-005), their place in the system instructions
// (SPEC-MOT-003) and the system reminders that bring them during a session (SPEC-MOT-007).
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { CURRENT_CONTRACT } from "../src/engine/behavior-contract";
import { InstructionsLoader, parseRuleHeader, renderInstructions } from "../src/engine/project-instructions";
import { dateChangeProducer, formatReminder, ReminderCenter } from "../src/engine/reminders";
import { estimateTokens } from "../src/engine/system-instructions";
import { currentPlatform } from "../src/platform/system";
import type { HistoryMessage } from "../src/providers/types";
import { cli, loadIdentity, workspace, type Workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const identity = loadIdentity();
const FILE = identity.get("INSTRUCTIONS_FILE");
const LOCAL_FILE = identity.get("LOCAL_INSTRUCTIONS_FILE");
const PROJECT_DIR = identity.get("PROJECT_DIR");
const platform = currentPlatform();

function loader(ws: Workspace, overrides: Partial<ConstructorParameters<typeof InstructionsLoader>[0]> = {}) {
  return new InstructionsLoader({
    instructionsFile: FILE,
    localInstructionsFile: LOCAL_FILE,
    projectDir: PROJECT_DIR,
    managedDir: ws.managed,
    configHome: ws.configHome,
    home: ws.home,
    cwd: ws.project,
    platform,
    trusted: true,
    excludes: [],
    includeDepth: 4,
    fileWarnSize: 40_960,
    estimateTokens,
    ...overrides,
  });
}

const systemText = (provider: ScriptedProvider, i = 0) => provider.requests[i]!.system.map((b) => b.text).join("\n\n");
const notes = (history: readonly HistoryMessage[]) => history.flatMap((m) => (m.role === "system_note" ? [m.text] : []));
const run = (ws: Workspace, args: string[], provider: ScriptedProvider, options: Parameters<typeof cli>[2] = {}) =>
  cli(["--non-interactive", "--allow-project-trust", ...args], ws, { provider, ...options });

describe("SPEC-MOT-004 custom system instructions", () => {
  test("SPEC-MOT-004/CA-01 — added text: it comes last in the system instructions", async () => {
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const r = await run(workspace(), ["--add-system-instructions", "Réponds en haïku", "x"], provider);
    expect(r.code).toBe(0);
    const blocks = provider.requests[0]!.system;
    expect(blocks[blocks.length - 1]!.text).toBe("Réponds en haïku");
  });

  test("SPEC-MOT-004/CA-02 — SPEC-MOT-003/CA-04 — replacement from a file: only the sections kept by a replacement and the file", async () => {
    const ws = workspace();
    ws.write(`project/${FILE}`, "PROJECT RULE");
    ws.write("project/role.md", "You review pull requests and nothing else.");
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const r = await run(ws, ["--system-instructions-file", "role.md", "--cwd", ws.project, "x"], provider, { extra: { cwd: ws.project } });
    expect(r.code).toBe(0);
    const text = systemText(provider);
    const contract = CURRENT_CONTRACT();
    expect(text).toContain("You review pull requests and nothing else.");
    expect(text).toContain(contract.clauses.get("C-01")!); // rules of conduct kept (RG-03)
    expect(text).toContain("# Environment");
    expect(text).not.toContain(contract.clauses.get("C-10")!); // method of work replaced
    expect(text).not.toContain("PROJECT RULE"); // project instructions left out
  });

  test("SPEC-MOT-004/CA-03 — a replacement text and a replacement file together: the launch fails (ERR-01)", async () => {
    const ws = workspace();
    ws.write("project/role.md", "role");
    const r = await run(ws, ["--system-instructions", "a", "--system-instructions-file", join(ws.project, "role.md"), "x"], new ScriptedProvider([]));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Utilisez soit un texte, soit un fichier de remplacement, pas les deux.");
  });

  test("SPEC-MOT-004/CA-04 — the managed setting forbids custom instructions: the launch fails with a ban message", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ context: { allowCustomSystemInstructions: false } }));
    const r = await run(ws, ["--system-instructions", "role", "x"], new ScriptedProvider([]));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("interdites par la politique en vigueur : --system-instructions");
  });

  test("TECH — SPEC-MOT-004/ERR-02 to ERR-05 — two additions, missing file, empty text, oversized text", async () => {
    const ws = workspace();
    const both = await run(ws, ["--add-system-instructions", "a", "--add-system-instructions-file", "b.md", "x"], new ScriptedProvider([]));
    expect(both.stderr).toContain("Utilisez soit un texte, soit un fichier d'ajout, pas les deux.");
    const missing = await run(ws, ["--add-system-instructions-file", join(ws.project, "absent.md"), "x"], new ScriptedProvider([]));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("Fichier d'instructions introuvable ou illisible");
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const empty = await run(ws, ["--add-system-instructions", "  ", "x"], provider);
    expect(empty.code).toBe(0);
    expect(empty.stderr).toContain("instructions vides ignorées");
    const big = await run(ws, ["--system-instructions", "x".repeat(100_001), "x"], new ScriptedProvider([]));
    expect(big.code).toBe(2);
    expect(big.stderr).toContain("Instructions trop volumineuses");
  });
});

describe("SPEC-MOT-005 project instructions files", () => {
  test("SPEC-MOT-005/CA-01 — a user file and a project file: both are loaded, the user file first", async () => {
    const ws = workspace();
    ws.write(`home/config/${FILE}`, "USER PREFERENCE");
    ws.write(`project/${FILE}`, "PROJECT CONVENTION");
    ws.write(`project/${LOCAL_FILE}`, "LOCAL NOTE");
    const provider = new ScriptedProvider([{ text: "ok" }]);
    expect((await run(ws, ["x"], provider)).code).toBe(0);
    const text = systemText(provider);
    expect(text).toContain("# Project instructions");
    const [u, p, l] = ["USER PREFERENCE", "PROJECT CONVENTION", "LOCAL NOTE"].map((s) => text.indexOf(s));
    expect(u).toBeGreaterThan(-1);
    expect(u).toBeLessThan(p!);
    expect(p).toBeLessThan(l!);
  });

  test("SPEC-MOT-005/CA-02 — a project file holding @docs/regles.md: the content of the file is included", () => {
    const ws = workspace();
    ws.write(`project/${FILE}`, "Read the rules: @docs/regles.md.");
    ws.write("project/docs/regles.md", "Always run the tests.");
    const files = loader(ws).load();
    expect(files.map((f) => f.content)).toEqual(["Read the rules: Always run the tests.."]);
  });

  test("SPEC-MOT-005/CA-03 — @x in a code block or a code span: no inclusion is attempted", () => {
    const ws = workspace();
    ws.write(`project/${FILE}`, "```\n@docs/a.md\n```\nUse `@docs/a.md` literally.");
    ws.write("project/docs/a.md", "INCLUDED");
    const l = loader(ws);
    const [file] = l.load();
    expect(file!.content).not.toContain("INCLUDED");
    expect(file!.content).toContain("@docs/a.md");
    expect(l.takeWarnings()).toEqual([]);
  });

  test("SPEC-MOT-005/CA-04 — A includes B which includes A: each file appears once and a warning is given", () => {
    const ws = workspace();
    ws.write(`project/${FILE}`, "A1 @b.md A2");
    ws.write("project/b.md", "B1 @" + FILE + " B2");
    const l = loader(ws);
    const files = l.load();
    const all = renderInstructions(files)!;
    expect(all.split("A1").length - 1).toBe(1);
    expect(all.split("B1").length - 1).toBe(1);
    expect(l.takeWarnings().some((w) => w.startsWith("Inclusion circulaire ignorée"))).toBe(true);
  });

  test("SPEC-MOT-005/CA-05 — a rule for src/api/**: reading src/api/user.ts adds the rule by a reminder", async () => {
    const ws = workspace();
    ws.write(`project/${PROJECT_DIR}/guidelines/api.md`, '---\npaths:\n  - "src/api/**"\n---\nAPI RULE: validate every input.');
    const user = ws.write("project/src/api/user.ts", "export const u = 1;\n");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: user } }] }, { text: "done" }]);
    expect((await run(ws, ["x"], provider)).code).toBe(0);
    expect(systemText(provider)).not.toContain("API RULE");
    const second = notes(provider.requests[1]!.history);
    expect(second).toHaveLength(1);
    expect(second[0]).toContain("API RULE: validate every input.");
    expect(second[0]!.startsWith("<system-reminder>")).toBe(true);
  });

  test("SPEC-MOT-005/CA-06 — lib/ holds an instructions file: the first read of lib/a.ts adds it by a reminder, once", async () => {
    const ws = workspace();
    ws.write(`project/lib/${FILE}`, "LIB CONVENTION");
    const a = ws.write("project/lib/a.ts", "a\n");
    const b = ws.write("project/lib/b.ts", "b\n");
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "read_file", input: { path: a } }] },
      { toolCalls: [{ name: "read_file", input: { path: b } }] },
      { text: "done" },
    ]);
    expect((await run(ws, ["x"], provider)).code).toBe(0);
    expect(systemText(provider)).not.toContain("LIB CONVENTION");
    expect(notes(provider.requests[1]!.history).filter((n) => n.includes("LIB CONVENTION"))).toHaveLength(1);
    expect(notes(provider.requests[2]!.history).filter((n) => n.includes("LIB CONVENTION"))).toHaveLength(1);
  });

  test("SPEC-MOT-005/CA-07 — an external inclusion without approval in a non-interactive run: ignored and reported", async () => {
    const ws = workspace();
    const outside = ws.write("elsewhere/secret-rules.md", "EXTERNAL CONTENT");
    ws.write(`project/${FILE}`, `Also follow @${outside}`);
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const r = await run(ws, ["x"], provider);
    expect(systemText(provider)).not.toContain("EXTERNAL CONTENT");
    expect(r.stderr).toContain(`Inclusion externe ignorée, faute d'approbation : ${outside}`);
  });

  test("SPEC-MOT-005/CA-08 — a folder not approved: no file of the project or local level is loaded", async () => {
    const ws = workspace();
    ws.write(`home/config/${FILE}`, "USER PREFERENCE");
    ws.write(`project/${FILE}`, "PROJECT CONVENTION");
    ws.write(`project/${LOCAL_FILE}`, "LOCAL NOTE");
    const provider = new ScriptedProvider([{ text: "ok" }]);
    expect((await cli(["--non-interactive", "x"], ws, { provider })).code).toBe(0);
    const text = systemText(provider);
    expect(text).toContain("USER PREFERENCE");
    expect(text).not.toContain("PROJECT CONVENTION");
    expect(text).not.toContain("LOCAL NOTE");
  });

  test("TECH — SPEC-MOT-005/ERR-01, ERR-03, ERR-05, EF-07, EF-08, RG-06 — missing inclusion, depth, invalid header, size, exclusions", () => {
    const ws = workspace();
    ws.write(`managed/${FILE}`, "MANAGED");
    ws.write(`project/${FILE}`, "P @missing.md @d1.md");
    for (let i = 1; i <= 3; i++) ws.write(`project/d${i}.md`, `D${i} @d${i + 1}.md`);
    ws.write("project/d4.md", "D4");
    ws.write(`project/${PROJECT_DIR}/guidelines/broken.md`, "---\npaths: [src/**\n---\nBROKEN RULE");
    ws.write(`project/${LOCAL_FILE}`, "x".repeat(200));
    const l = loader(ws, { includeDepth: 2, fileWarnSize: 100, excludes: ["**/*.local.md", `**/${FILE}`] });
    const all = renderInstructions(l.load())!;
    const warnings = l.takeWarnings();
    expect(all).toContain("MANAGED"); // RG-06: the managed level cannot be excluded
    expect(all).not.toContain("D3"); // excluded project file never read
    expect(all).toContain("BROKEN RULE"); // ERR-05: loaded everywhere
    expect(warnings.some((w) => w.startsWith("En-tête de règle invalide"))).toBe(true);
    const l2 = loader(ws, { includeDepth: 2, fileWarnSize: 100 });
    const all2 = renderInstructions(l2.load())!;
    const w2 = l2.takeWarnings();
    expect(all2).toContain("D2");
    expect(all2).not.toContain("D3 ");
    expect(w2.some((w) => w.startsWith("Fichier inclus introuvable"))).toBe(true); // ERR-01
    expect(w2.some((w) => w.startsWith("Profondeur d'inclusion maximale atteinte"))).toBe(true); // ERR-03
    expect(w2.some((w) => w.startsWith("Fichier d'instructions volumineux"))).toBe(true); // EF-07
  });

  test("TECH — SPEC-MOT-005 — rule headers: list, inline list, single pattern, none", () => {
    expect(parseRuleHeader('---\npaths:\n  - "a/**"\n  - b.md\n---\nbody').patterns).toEqual(["a/**", "b.md"]);
    expect(parseRuleHeader('---\npaths: ["a/**", "c"]\n---\nbody').patterns).toEqual(["a/**", "c"]);
    expect(parseRuleHeader("---\npaths: src/**\n---\nbody").patterns).toEqual(["src/**"]);
    expect(parseRuleHeader("no header").patterns).toBeUndefined();
    expect(parseRuleHeader("---\ntitle: x\n---\nbody")).toEqual({ body: "body" });
  });
});

describe("SPEC-MOT-007 system reminders", () => {
  test("SPEC-MOT-007/CA-01 — a session begun the day before: the date change reminder comes once", () => {
    let now = new Date(2026, 9, 5, 23, 50);
    const center = new ReminderCenter([dateChangeProducer(() => now)], 2000, estimateTokens);
    expect(center.collect()).toEqual([]);
    now = new Date(2026, 9, 6, 0, 10);
    const first = center.collect();
    expect(first).toEqual([{ type: "date_change", text: "The date has changed: today is 2026-10-06.", priority: 1 }]);
    expect(center.collect()).toEqual([]);
  });

  test("TECH — SPEC-MOT-007/EF-01, EF-05, FA-01, ERR-01 — tagged, never repeated, deferred over budget, failing producer skipped", () => {
    const log: string[] = [];
    const center = new ReminderCenter(
      [
        { type: "a", produce: () => [{ type: "a", text: "x".repeat(70), priority: 1 }, { type: "a", text: "important", priority: 9 }] },
        {
          type: "broken",
          produce: () => {
            throw new Error("boom");
          },
        },
      ],
      10,
      estimateTokens,
      (m) => log.push(m),
    );
    expect(center.collect().map((r) => r.text)).toEqual(["important"]);
    expect(center.collect().map((r) => r.text)).toEqual(["x".repeat(70)]); // deferred, then given alone
    expect(center.collect()).toEqual([]); // same type and text: not repeated
    expect(log).toContain("reminder producer failed");
    expect(formatReminder("hello")).toBe("<system-reminder>\nhello\n</system-reminder>");
  });

  test("TECH — SPEC-MOT-007/EF-02, EF-04 — the environment section explains the tags; reminders are persisted with their type", async () => {
    const ws = workspace();
    ws.write(`project/lib/${FILE}`, "LIB CONVENTION");
    const a = ws.write("project/lib/a.ts", "a\n");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: a } }] }, { text: "done" }]);
    const r = await run(ws, ["--result-format", "json", "x"], provider);
    expect(systemText(provider)).toContain("Text inside <system-reminder> tags is written by the product, not by the user");
    const sessionId = JSON.parse(r.stdout).sessionId as string;
    const glob = new Bun.Glob(`**/${sessionId}.jsonl`);
    const [transcript] = [...glob.scanSync({ cwd: ws.configHome, absolute: true })];
    const lines = (await Bun.file(transcript!).text()).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.type === "system" && l.data?.event === "note" && l.data?.type === "instructions")).toBe(true);
  });
});

