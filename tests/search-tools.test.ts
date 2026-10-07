// find_files and search_content. search_content runs on the built-in engine, and on ripgrep too when the system has it.
import { describe, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";
import { currentPlatform, findExecutable } from "../src/platform/system";
import { parseIgnore } from "../src/tools/file-walk";
import { findFilesTool } from "../src/tools/find-files";
import { searchContentTool, type SearchContentInput } from "../src/tools/search-content";
import type { ToolContext, ToolOutcome } from "../src/tools/types";
import { testToolFields, workspace, type Workspace } from "./helpers/env";

const platform = currentPlatform();
const RG = findExecutable("rg");

function ctx(ws: Workspace, overrides: Partial<ToolContext> = {}): ToolContext {
  return { platform, home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal: new AbortController().signal, ...testToolFields(), ...overrides } as ToolContext;
}
const text = (o: ToolOutcome) => o.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
const paths = (o: ToolOutcome) => text(o).split("\n\n[")[0]!.split("\n").filter((l) => l !== "");

describe("SPEC-OUT-006 find_files", () => {
  test("SPEC-OUT-006/CA-01 — **/*.md in a repository: every non-ignored Markdown file, most recent first", async () => {
    const ws = workspace();
    const a = ws.write("project/a.md", "a");
    const b = ws.write("project/docs/b.md", "b");
    const c = ws.write("project/docs/deep/c.md", "c");
    ws.write("project/code.ts", "x");
    const t = Date.now() / 1000;
    utimesSync(a, t - 300, t - 300);
    utimesSync(b, t - 100, t - 100);
    utimesSync(c, t - 200, t - 200);
    const r = await findFilesTool.execute({ pattern: "**/*.md" }, ctx(ws));
    expect(paths(r)).toEqual([b, c, a]);
  });

  test("SPEC-OUT-006/CA-02 — a file listed in .gitignore is not returned; the version control folder never is", async () => {
    const ws = workspace();
    ws.write("project/.gitignore", "secret.md\nbuild/\n# comment\n!keep.log\n*.log\n");
    const kept = ws.write("project/visible.md", "v");
    ws.write("project/secret.md", "s");
    ws.write("project/build/out.md", "o");
    ws.write("project/.git/notes.md", "g");
    const r = await findFilesTool.execute({ pattern: "**/*.md" }, ctx(ws));
    expect(paths(r)).toEqual([kept]);
    const all = await findFilesTool.execute({ pattern: "**/*.md" }, ctx(ws, { settings: { ...testToolFields().settings, respectIgnoreFiles: false } }));
    expect(paths(all)).toHaveLength(3);
  });

  test("SPEC-OUT-006/CA-03 — 1,000 matches: 250 paths are returned with the total", async () => {
    const ws = workspace();
    for (let i = 0; i < 1000; i++) ws.write(`project/many/f${i}.txt`, "x");
    const r = await findFilesTool.execute({ pattern: "many/*.txt" }, ctx(ws));
    expect(paths(r)).toHaveLength(250);
    expect(text(r)).toContain("Showing 250 of 1000 files");
  }, 30_000);

  test("TECH — SPEC-OUT-006/ERR-01, ERR-02, FA-01, RG-01 — invalid pattern, missing folder, no result, denied paths", async () => {
    const ws = workspace();
    expect(findFilesTool.validate!({ pattern: "src/{a,b" }, ctx(ws))).toContain("Invalid pattern");
    expect(text(await findFilesTool.execute({ pattern: "*", path: join(ws.project, "nope") }, ctx(ws)))).toContain("Folder not found");
    expect(text(await findFilesTool.execute({ pattern: "*.zzz" }, ctx(ws)))).toBe(`No file matches *.zzz: the folder ${ws.project} holds no file.`);
    const hidden = ws.write("project/private/key.txt", "k");
    const r = await findFilesTool.execute({ pattern: "**/*.txt" }, ctx(ws, { readDenied: (p) => p === hidden }));
    // RG-01: a denied path is neither returned nor named in the guidance.
    expect(text(r)).not.toContain("key.txt");
  });

  test("D-20 — correction D-1: a pattern without / matches at any depth", async () => {
    const ws = workspace();
    const guide = ws.write("project/docs/guides/guide.md", "# Guide\n");
    expect(paths(await findFilesTool.execute({ pattern: "guide.md" }, ctx(ws)))).toEqual([guide]);
    expect(paths(await findFilesTool.execute({ pattern: "docs/guide.md" }, ctx(ws)))).toEqual([expect.stringContaining("No file matches docs/guide.md")]);
  });

  test("D-20 — correction D-2: an empty result names what the folder holds and how to widen the search", async () => {
    const ws = workspace();
    ws.write("project/config/server.env", "PORT=8080\n");
    ws.write("project/config/notes.txt", "n\n");
    const r = text(await findFilesTool.execute({ pattern: "**/*.yml", path: join(ws.project, "config") }, ctx(ws)));
    expect(r).toContain("which holds 2 files: notes.txt, server.env");
    expect(r).toContain("Use a broader pattern (such as * or **/*), or search file contents with search_content.");
  });

  test("E-047 — exclusion file syntax: anchoring, folders only, negation, nested files", () => {
    const rules = parseIgnore("/root.txt\ndir/\n*.tmp\n!keep.tmp\nsub/*.md\n", false);
    const ignored = (p: string, dir = false) => {
      let r = false;
      for (const rule of rules) if (!(rule.directoryOnly && !dir) && rule.test(p)) r = !rule.negated;
      return r;
    };
    expect(ignored("root.txt")).toBe(true);
    expect(ignored("a/root.txt")).toBe(false);
    expect(ignored("x/dir", true)).toBe(true);
    expect(ignored("x/dir", false)).toBe(false);
    expect(ignored("a/b/c.tmp")).toBe(true);
    expect(ignored("a/keep.tmp")).toBe(false);
    expect(ignored("sub/x.md")).toBe(true);
    expect(ignored("other/sub/x.md")).toBe(false);
  });
});

const engines: Array<[string, string | undefined]> = [["built-in engine", undefined]];
if (RG) engines.push(["ripgrep", RG]);

for (const [engine, rg] of engines) {
  describe(`SPEC-OUT-007 search_content (${engine})`, () => {
    const search = (ws: Workspace, input: SearchContentInput, overrides: Partial<ToolContext> = {}) => searchContentTool.execute(input, ctx(ws, { ripgrepPath: rg, ...overrides }));

    test("SPEC-OUT-007/CA-01 — TODO without mode: the list of files containing it", async () => {
      const ws = workspace();
      const a = ws.write("project/a.ts", "// TODO: a\n");
      const b = ws.write("project/sub/b.py", "x = 1  # TODO\n");
      ws.write("project/c.md", "nothing\n");
      ws.write("project/.gitignore", "ignored.txt\n");
      ws.write("project/ignored.txt", "TODO\n");
      ws.write("project/bin.dat", "TODO\u0000binary");
      const r = await search(ws, { pattern: "TODO" });
      expect(paths(r)).toEqual([a, b].sort());
    });

    test("SPEC-OUT-007/CA-02 — lines mode with around 2: each match with 2 numbered context lines", async () => {
      const ws = workspace();
      const f = ws.write("project/f.txt", ["l1", "l2", "l3", "MATCH", "l5", "l6", "l7"].join("\n") + "\n");
      const r = await search(ws, { pattern: "MATCH", mode: "lines", around: 2 });
      expect(paths(r)).toEqual([`${f}-2-l2`, `${f}-3-l3`, `${f}:4:MATCH`, `${f}-5-l5`, `${f}-6-l6`]);
    });

    test("SPEC-OUT-007/CA-03 — type py: only Python files are searched", async () => {
      const ws = workspace();
      const py = ws.write("project/a.py", "needle\n");
      ws.write("project/a.js", "needle\n");
      ws.write("project/a.pyc", "needle\n");
      const r = await search(ws, { pattern: "needle", type: "py" });
      expect(paths(r)).toEqual([py]);
      expect(searchContentTool.validate!({ pattern: "x", type: "pyy" }, ctx(ws))).toContain("Close types: py");
    });

    test("SPEC-OUT-007/CA-04 — multiline and an expression spanning two lines: the match is found", async () => {
      const ws = workspace();
      const f = ws.write("project/m.txt", "start here\nend there\n");
      expect(text(await search(ws, { pattern: "here\\nend" }))).toBe("No match found.");
      const r = await search(ws, { pattern: "here\\nend", multiline: true, mode: "lines" });
      expect(paths(r)).toEqual([`${f}:1:start here`, `${f}:2:end there`]);
    });

    test("SPEC-OUT-007/CA-05 — 1,000 matching files without limit: 200 entries with the total", async () => {
      const ws = workspace();
      for (let i = 0; i < 1000; i++) ws.write(`project/many/f${String(i).padStart(4, "0")}.txt`, "hit\n");
      const r = await search(ws, { pattern: "hit" });
      expect(paths(r)).toHaveLength(200);
      expect(text(r)).toContain("Showing entries 1 to 200 of 1000 files");
      const next = await search(ws, { pattern: "hit", offset: 200, limit: 10 });
      expect(paths(next)[0]).toContain("f0200.txt");
    }, 30_000);

    test("TECH — SPEC-OUT-007 — count mode, case-insensitive search, long lines truncated, denied files skipped", async () => {
      const ws = workspace();
      const f = ws.write("project/c.txt", "Foo foo\nFOO\n" + "foo".padEnd(1000, "x") + "\n");
      const secret = ws.write("project/secret.txt", "foo\n");
      const count = await search(ws, { pattern: "foo", mode: "count", ignore_case: true }, { readDenied: (p) => p === secret });
      expect(paths(count)).toEqual([`${f}:4`]);
      const lines = await search(ws, { pattern: "^foox", mode: "lines" });
      // The text after `path:line:` is cut (the path itself, long on some systems, is not).
      expect(paths(lines)[0]!.length - `${f}:3:`.length).toBeLessThan(500);
      expect(paths(lines)[0]).toContain("[… 1000 characters]");
    });
  });
}

describe("D-21 — correction D-8 (E-071) search_content filters", () => {
  test("D-21 — the configuration file types exist: env finds server.env and .env", async () => {
    const ws = workspace();
    const a = ws.write("project/config/server.env", "PORT=8080\n");
    const b = ws.write("project/.env", "PORT=9090\n");
    ws.write("project/src/server.js", "const port = process.env.PORT;\n");
    const r = await searchContentTool.execute({ pattern: "PORT=", type: "env" }, ctx(ws));
    expect(paths(r)).toEqual([b, a].sort());
  });

  test("D-21 — only really close types are proposed", () => {
    const ws = workspace();
    expect(searchContentTool.validate!({ pattern: "x", type: "yml" }, ctx(ws))).toContain("Close types: xml, yaml.");
    expect(searchContentTool.validate!({ pattern: "x", type: "cfgg" }, ctx(ws))).not.toContain("Close types");
  });

  test("D-21 — a filtered search without match says which files the filter left out, never a denied one", async () => {
    const ws = workspace();
    ws.write("project/config/server.env", "PORT=8080\n");
    const secret = ws.write("project/config/secret.ini", "PORT=1\n");
    ws.write("project/config/notes.txt", "nothing\n");
    const r = text(await searchContentTool.execute({ pattern: "port", type: "txt", path: join(ws.project, "config") }, ctx(ws, { readDenied: (p) => p === secret })));
    expect(r).toContain("No match found. The filter (type txt) left out 1 of the 2 files of");
    expect(r).toContain("such as server.env. Search again without it to include them.");
    expect(r).not.toContain("secret.ini");
    expect(text(await searchContentTool.execute({ pattern: "absent" }, ctx(ws)))).toBe("No match found.");
  });
});

test("TECH — SPEC-OUT-007/ERR-01 — an invalid expression is refused", () => {
  const ws = workspace();
  expect(searchContentTool.validate!({ pattern: "func(" }, ctx(ws))).toContain("Invalid regular expression");
});
