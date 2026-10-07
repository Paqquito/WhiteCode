// Writing tools: write_file, edit_file (cascade, steps 1 to 4), update_notebook_cell, and read_file on notebooks and images.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { currentPlatform } from "../src/platform/system";
import { unifiedDiff } from "../src/shared/diff";
import { editFileTool } from "../src/tools/edit-file";
import { planEdit } from "../src/tools/edit-match";
import { readFileTool } from "../src/tools/read-file";
import type { ToolContext, ToolOutcome } from "../src/tools/types";
import { updateNotebookCellTool } from "../src/tools/update-notebook-cell";
import { writeFileTool } from "../src/tools/write-file";
import { ROOT, testToolFields, workspace, type Workspace } from "./helpers/env";

const platform = currentPlatform();

function ctx(ws: Workspace, overrides: Partial<ToolContext> = {}): ToolContext {
  return { platform, home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal: new AbortController().signal, ...testToolFields(), ...overrides } as ToolContext;
}
const text = (o: ToolOutcome) => o.content.map((c) => (c.type === "text" ? c.text : `[${c.mediaType}]`)).join("\n");

/** Reads the file with read_file so that the read precondition holds, as the model would. */
async function read(path: string, c: ToolContext): Promise<void> {
  const r = await readFileTool.execute({ path }, c);
  if (r.isError) throw new Error(text(r));
}

describe("SPEC-OUT-003 write_file", () => {
  test("SPEC-OUT-003/CA-01 — a path in missing folders: the folders and the file are created", async () => {
    const ws = workspace();
    const path = join(ws.project, "a", "b", "c", "new.txt");
    const r = await writeFileTool.execute({ path, content: "hello\n" }, ctx(ws));
    expect(r.isError).toBe(false);
    expect(text(r)).toContain("Created");
    expect(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).toBe("hello\n");
  });

  test("SPEC-OUT-003/CA-02 — an existing file never read: ERR-01, file unchanged", async () => {
    const ws = workspace();
    const path = ws.write("project/x.txt", "original\n");
    const r = await writeFileTool.execute({ path, content: "new\n" }, ctx(ws));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Read the file before you rewrite it");
    expect(readFileSync(path, "utf8")).toBe("original\n");
  });

  test("SPEC-OUT-003/CA-03 — a file read then modified by hand: ERR-02", async () => {
    const ws = workspace();
    const path = ws.write("project/x.txt", "original\n");
    const c = ctx(ws);
    await read(path, c);
    writeFileSync(path, "changed by someone else\n");
    utimesSync(path, new Date(), new Date(Date.now() + 5000));
    const r = await writeFileTool.execute({ path, content: "new\n" }, c);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("changed since you read it");
  });

  test("TECH — SPEC-OUT-003/RG-02 — a partial read does not allow a rewrite", async () => {
    const ws = workspace();
    const path = ws.write("project/x.txt", "a\nb\nc\n");
    const c = ctx(ws);
    await readFileTool.execute({ path, offset: 2, limit: 1 }, c);
    const r = await writeFileTool.execute({ path, content: "new\n" }, c);
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Read the whole file");
  });

  test("SPEC-OUT-003/CA-04 — a CRLF file rewritten with LF keeps CRLF; a UTF-8 mark is kept", async () => {
    const ws = workspace();
    const path = ws.write("project/crlf.txt", "\ufeffone\r\ntwo\r\n");
    const c = ctx(ws);
    await read(path, c);
    const r = await writeFileTool.execute({ path, content: "uno\ndos\ntres\n" }, c);
    expect(r.isError).toBe(false);
    const bytes = readFileSync(path);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(bytes.subarray(3).toString("utf8")).toBe("uno\r\ndos\r\ntres\r\n");
  });

  test("SPEC-OUT-003/CA-05 — a brutal stop during the write leaves the file either intact or completely rewritten", async () => {
    const ws = workspace();
    const path = ws.write("project/big.txt", "OLD".repeat(1000));
    const next = "N".repeat(40 * 1024 * 1024);
    const script = ws.write(
      "writer.ts",
      `import { writeAtomic } from ${JSON.stringify(join(ROOT, "src/tools/text-file.ts"))};\nwriteAtomic(${JSON.stringify(path)}, Buffer.from(${JSON.stringify("N")}.repeat(${next.length})), ${JSON.stringify(platform)});\n`,
    );
    for (const delay of [5, 30, 80, 200]) {
      writeFileSync(path, "OLD".repeat(1000));
      const child = Bun.spawn([process.execPath, script], { stdout: "ignore", stderr: "ignore" });
      await Bun.sleep(delay);
      child.kill(9);
      await child.exited;
      const content = readFileSync(path, "utf8");
      expect(content === "OLD".repeat(1000) || content === next).toBe(true);
    }
    expect(readdirSync(ws.project).filter((n) => n.endsWith(".tmp")).length).toBeLessThanOrEqual(4); // leftovers of killed writers only, never the target
  }, 60_000);

  test("TECH — SPEC-OUT-003/ERR-03 and ERR-06 — a folder and a notebook are refused", async () => {
    const ws = workspace();
    const dir = await writeFileTool.execute({ path: ws.project, content: "x" }, ctx(ws));
    expect(text(dir)).toContain("directory");
    expect(writeFileTool.validate!({ path: join(ws.project, "n.ipynb"), content: "{}" }, ctx(ws))).toContain("update_notebook_cell");
  });

  test("TECH — SPEC-OUT-003/RG-03 — a failed write is reported and leaves no temporary file", async () => {
    const ws = workspace();
    // A regular file used as a folder: the parent folder cannot be created.
    const notAFolder = ws.write("project/plain.txt", "x");
    const r = await writeFileTool.execute({ path: join(notAFolder, "child.txt"), content: "y" }, ctx(ws));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Write failed");
    expect(readFileSync(notAFolder, "utf8")).toBe("x");
    expect(readdirSync(ws.project).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });
});

describe("SPEC-OUT-004 edit_file", () => {
  async function edit(ws: Workspace, content: string, input: { old_text: string; new_text: string; all_occurrences?: boolean }, name = "f.ts") {
    const path = ws.write(`project/${name}`, content);
    const c = ctx(ws);
    await read(path, c);
    const r = await editFileTool.execute({ path, ...input }, c);
    return { r, after: readFileSync(path, "utf8"), path };
  }

  test("SPEC-OUT-004/CA-01 — a unique passage: only this passage changes; a numbered excerpt is returned", async () => {
    const { r, after } = await edit(workspace(), "alpha\nbeta\ngamma\n", { old_text: "beta", new_text: "BETA" });
    expect(r.isError).toBe(false);
    expect(after).toBe("alpha\nBETA\ngamma\n");
    expect(text(r)).toContain("2\tBETA");
  });

  test("SPEC-OUT-004/CA-02 — a passage present 3 times without all_occurrences: ERR-02 gives 3", async () => {
    const { r, after } = await edit(workspace(), "x = 1\nx = 1\nx = 1\n", { old_text: "x = 1", new_text: "x = 2" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("occurs 3 times");
    expect(after).toBe("x = 1\nx = 1\nx = 1\n");
  });

  test("SPEC-OUT-004/CA-03 — with all_occurrences, the 3 occurrences change and the result says so", async () => {
    const { r, after } = await edit(workspace(), "x = 1\nx = 1\nx = 1\n", { old_text: "x = 1", new_text: "x = 2", all_occurrences: true });
    expect(after).toBe("x = 2\nx = 2\nx = 2\n");
    expect(text(r)).toContain("Replaced 3 occurrences");
  });

  test("SPEC-OUT-004/CA-04 — typographic quotes in the file, straight quotes in old_text: found, file style kept", async () => {
    const { r, after } = await edit(workspace(), "say(\u201chello\u201d)\n", { old_text: 'say("hello")', new_text: 'say("goodbye")' });
    expect(r.isError).toBe(false);
    expect(after).toBe("say(\u201cgoodbye\u201d)\n");
    expect(text(r)).toContain("step 2");
  });

  test("SPEC-OUT-004/CA-05 — a missing file and an empty old_text: the file is created", async () => {
    const ws = workspace();
    const path = join(ws.project, "created.txt");
    const r = await editFileTool.execute({ path, old_text: "", new_text: "fresh\n" }, ctx(ws));
    expect(r.isError).toBe(false);
    expect(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).toBe("fresh\n");
  });

  test("SPEC-OUT-004/CA-06 — a file never read: ERR-04", async () => {
    const ws = workspace();
    const path = ws.write("project/unread.txt", "content\n");
    const r = await editFileTool.execute({ path, old_text: "content", new_text: "other" }, ctx(ws));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Read the file before you edit it");
  });

  test("SPEC-OUT-004/CA-07 — a block indented by four spaces and an old_text without indentation: replaced, new_text re-indented, step reported", async () => {
    const file = "function f() {\n    if (a) {\n        b();\n    }\n}\n";
    const { r, after } = await edit(workspace(), file, { old_text: "if (a) {\n    b();\n}", new_text: "if (a) {\n    c();\n    d();\n}" });
    expect(r.isError).toBe(false);
    expect(after).toBe("function f() {\n    if (a) {\n        c();\n        d();\n    }\n}\n");
    expect(text(r)).toContain("step 3 (shifted indentation)");
    expect(text(r)).toContain("Replaced text:\n    if (a) {\n        b();\n    }");
  });

  test("SPEC-OUT-004/CA-08 — two passages answering step 4: refused with the approximate passages message", async () => {
    const file = "  a\n    b\nzz\n    a\n  b\n";
    const { r } = await edit(workspace(), file, { old_text: "a\nb", new_text: "a\nc" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Several approximate passages");
  });

  test("SPEC-OUT-004/CA-09 — all_occurrences and no exact passage: no tolerant step is tried", async () => {
    // Without all_occurrences, step 3 would find this passage.
    expect(planEdit("    one();\n    two();\n", "one();\ntwo();", "x();\ny();", false, true)).toMatchObject({ kind: "planned", step: 3 });
    const { r, after } = await edit(workspace(), "    one();\n    two();\n", { old_text: "one();\ntwo();", new_text: "x();\ny();", all_occurrences: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Passage not found");
    expect(after).toBe("    one();\n    two();\n");
  });

  test("SPEC-OUT-004/CA-11 — two exact passages and a third approximate: refused, no tolerant step", () => {
    const result = planEdit("foo()\nfoo()\n  foo( )\n", "foo()", "bar()", false, true);
    expect(result).toEqual({ kind: "not_unique", count: 2 });
  });

  test("SPEC-OUT-004/CA-12 — a passage only a block anchor would find: refused as not found, no line modified (D-04)", async () => {
    const file = "start\n  alpha one\n  beta two\n  gamma three\nend\n";
    const { r, after } = await edit(workspace(), file, { old_text: "start\n  alpha 1\n  beta 2\n  gamma 3\nend", new_text: "start\nend" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Passage not found");
    expect(after).toBe(file);
  });

  test("SPEC-OUT-004/CA-14 — a tab-indented file and a space-indented old_text: steps 3 and 4 refused, not found", async () => {
    const file = "if x:\n\tdo()\n\tdone()\n";
    const { r, after } = await edit(workspace(), file, { old_text: "    do()\n    done()", new_text: "    redo()\n    done()" }, "t.py");
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Passage not found");
    expect(after).toBe(file);
  });

  test("SPEC-OUT-004/CA-15 — first line of the passage empty, shifted by four spaces: the first non-empty line is the reference", async () => {
    const file = "class A:\n\n    def f(self):\n        return 1\n";
    const { r, after } = await edit(workspace(), file, { old_text: "\ndef f(self):\n    return 1", new_text: "\ndef f(self):\n    return 2" }, "a.py");
    expect(r.isError).toBe(false);
    expect(after).toBe("class A:\n\n    def f(self):\n        return 2\n");
  });

  test("SPEC-OUT-004/CA-16 — a new_text mixing tabs and spaces when step 3 or 4 is needed: refused as not found", async () => {
    const file = "{\n    a();\n    b();\n}\n";
    const { r, after } = await edit(workspace(), file, { old_text: "a();\nb();", new_text: "a();\n\t  c();" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("Passage not found");
    expect(after).toBe(file);
  });

  test("TECH — SPEC-OUT-004/ERR-03 and ERR-06 — identical texts and notebooks are refused before anything", () => {
    const ws = workspace();
    expect(editFileTool.validate!({ path: join(ws.project, "a.txt"), old_text: "a", new_text: "a" }, ctx(ws))).toContain("No change requested");
    expect(editFileTool.validate!({ path: join(ws.project, "a.ipynb"), old_text: "a", new_text: "b" }, ctx(ws))).toContain("update_notebook_cell");
  });

  test("D-20 — correction D-4: an old_text with the characters \\n instead of line breaks gets a precise explanation", async () => {
    const { r, after } = await edit(workspace(), "a();\nb();\n", { old_text: "a();\\nb();", new_text: "a();\\nc();" });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("old_text contains the two characters \\n instead of real line breaks");
    expect(after).toBe("a();\nb();\n");
  });

  test("D-20 — correction D-3: a missing file suggests the file of the same name in a nearby folder, as a full path", async () => {
    const ws = workspace();
    const real = ws.write("project/docs/guides/guide.md", "# Guide\n");
    const r = await readFileTool.execute({ path: join(ws.project, "docs", "guide.md") }, ctx(ws));
    expect(r.isError).toBe(true);
    expect(text(r)).toContain(`Did you mean: ${real}`);
  });

  test("TECH — SPEC-OUT-004 — line numbers copied from read_file: explicit refusal with advice", async () => {
    const { r } = await edit(workspace(), "one\ntwo\n", { old_text: "1\tone\n2\ttwo", new_text: "x" });
    expect(text(r)).toContain("line numbers copied from read_file");
  });

  test("TECH — SPEC-OUT-004/EF-04 — a partial read is enough to edit; CRLF endings are kept", async () => {
    const ws = workspace();
    const path = ws.write("project/w.txt", "a\r\nb\r\nc\r\n");
    const c = ctx(ws);
    await readFileTool.execute({ path, offset: 2, limit: 1 }, c);
    const r = await editFileTool.execute({ path, old_text: "b", new_text: "B" }, c);
    expect(r.isError).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("a\r\nB\r\nc\r\n");
  });

  test("TECH — SPEC-OUT-003/EF-06 — the difference shown before confirmation", async () => {
    const ws = workspace();
    const path = ws.write("project/d.txt", "one\ntwo\nthree\n");
    const c = ctx(ws);
    await read(path, c);
    const preview = await editFileTool.preview!({ path, old_text: "two", new_text: "deux" }, c);
    expect("diff" in preview && preview.diff).toContain("-two\n+deux");
    expect(unifiedDiff("a\nb\n", "a\nc\n", "f")).toBe("--- f\n+++ f\n@@ -1,2 +1,2 @@\n a\n-b\n+c");
  });
});

describe("SPEC-OUT-005 update_notebook_cell", () => {
  const cell = (id: string, type: "code" | "markdown", source: string) =>
    type === "code" ? { cell_type: type, id, metadata: {}, source: [source], execution_count: 1, outputs: [{ output_type: "stream", name: "stdout", text: ["out\n"] }] } : { cell_type: type, id, metadata: {}, source: [source] };

  function notebook(ws: Workspace, count = 10) {
    const nb = { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: "k" } }, cells: Array.from({ length: count }, (_, i) => cell(`c${i + 1}`, i % 2 === 0 ? "code" : "markdown", `source ${i + 1}`)) };
    return ws.write("project/nb.ipynb", `${JSON.stringify(nb, null, 1)}\n`);
  }
  const load = (path: string) => JSON.parse(readFileSync(path, "utf8"));

  test("SPEC-OUT-005/CA-01 — replacing cell 3 of 10: only cell 3 changes and its outputs are cleared", async () => {
    const ws = workspace();
    const path = notebook(ws);
    const before = load(path);
    const c = ctx(ws);
    await read(path, c);
    const r = await updateNotebookCellTool.execute({ path, cell_id: "3", source: "print(3)" }, c);
    expect(r.isError).toBe(false);
    const after = load(path);
    expect(after.cells[2]).toMatchObject({ id: "c3", cell_type: "code", source: ["print(3)"], outputs: [], execution_count: null });
    for (const i of [0, 1, 3, 4, 5, 6, 7, 8, 9]) expect(after.cells[i]).toEqual(before.cells[i]);
    expect(after.metadata).toEqual(before.metadata);
    expect(readFileSync(path, "utf8").startsWith('{\n "nbformat"')).toBe(true); // original JSON indentation
  });

  test("SPEC-OUT-005/CA-02 — insert after cell 5: the new cell is in 6th position", async () => {
    const ws = workspace();
    const path = notebook(ws);
    const c = ctx(ws);
    await read(path, c);
    const r = await updateNotebookCellTool.execute({ path, cell_id: "c5", mode: "insert", cell_type: "markdown", source: "# New" }, c);
    expect(r.isError).toBe(false);
    const after = load(path);
    expect(after.cells).toHaveLength(11);
    expect(after.cells[5]).toMatchObject({ cell_type: "markdown", source: ["# New"] });
    expect(typeof after.cells[5].id).toBe("string");
    expect(after.cells[6].id).toBe("c6");
  });

  test("SPEC-OUT-005/CA-03 — delete: the notebook stays valid", async () => {
    const ws = workspace();
    const path = notebook(ws, 3);
    const c = ctx(ws);
    await read(path, c);
    const r = await updateNotebookCellTool.execute({ path, cell_id: "c2", mode: "delete" }, c);
    expect(r.isError).toBe(false);
    const after = load(path);
    expect(after.cells.map((x: { id: string }) => x.id)).toEqual(["c1", "c3"]);
    expect(after.nbformat).toBe(4);
  });

  test("TECH — SPEC-OUT-005/ERR-02 and ERR-03 — unknown cell lists the available ids; insert without type is refused", async () => {
    const ws = workspace();
    const path = notebook(ws, 2);
    const c = ctx(ws);
    await read(path, c);
    expect(text(await updateNotebookCellTool.execute({ path, cell_id: "zz", source: "x" }, c))).toContain("Available cells: c1, c2");
    expect(text(await updateNotebookCellTool.execute({ path, mode: "insert", source: "x" }, c))).toContain("cell_type");
  });

  test("TECH — SPEC-OUT-002 — read_file renders a notebook with cells, types, sources and outputs", async () => {
    const ws = workspace();
    const path = notebook(ws, 2);
    const out = text(await readFileTool.execute({ path }, ctx(ws)));
    expect(out).toContain("<cell 1 (id c1), code>\nsource 1\n[output]\nout");
    expect(out).toContain("<cell 2 (id c2), markdown>");
  });
});

describe("SPEC-OUT-002 read_file images (gap E-027)", () => {
  function png(width: number, height: number): Buffer {
    const b = Buffer.alloc(33);
    b.writeUInt32BE(0x89504e47, 0);
    b.writeUInt32BE(0x0d0a1a0a, 4);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "ascii");
    b.writeUInt32BE(width, 16);
    b.writeUInt32BE(height, 20);
    return b;
  }

  test("E-027 — a PNG within the limits is attached to the result", async () => {
    const ws = workspace();
    const path = join(ws.project, "pic.png");
    writeFileSync(path, png(64, 32));
    const r = await readFileTool.execute({ path }, ctx(ws));
    expect(r.isError).toBe(false);
    expect(r.content[1]).toMatchObject({ type: "image", mediaType: "image/png" });
    expect(text(r)).toContain("64 × 32");
  });

  test("E-027 — an image beyond the dimensions is refused with an invitation to reduce it; a model without images refuses", async () => {
    const ws = workspace();
    const path = join(ws.project, "huge.png");
    writeFileSync(path, png(9000, 4000));
    const big = await readFileTool.execute({ path }, ctx(ws));
    expect(big.isError).toBe(true);
    expect(text(big)).toContain("reduce it");
    const noImages = await readFileTool.execute({ path }, ctx(ws, { modelImages: false }));
    expect(text(noImages)).toContain("does not accept images");
    expect(existsSync(path)).toBe(true);
  });
});
