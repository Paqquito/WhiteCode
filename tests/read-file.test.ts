import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { currentPlatform } from "../src/platform/system";
import { readFileTool } from "../src/tools/read-file";
import type { ToolContext } from "../src/tools/types";
import { cli, workspace, testToolFields } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const ws = workspace();
const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
const big = ws.write("project/big.txt", lines(3000));

function ctx(): ToolContext {
  return {
    platform: currentPlatform(),
    home: ws.home,
    cwd: ws.project,
    allowedDirectories: [ws.project],
    signal: new AbortController().signal,
    ...testToolFields(),
  };
}
const text = (o: { content: readonly { type: string }[] }) => (o.content[0] as unknown as { text: string }).text;

describe("SPEC-OUT-002 read_file", () => {
  test("SPEC-OUT-002/CA-01 — 3,000 lines read without range: the first 1,500 lines and the truncation notice", async () => {
    const out = text(await readFileTool.execute({ path: big }, ctx()));
    const body = out.split("\n\n[")[0]!.split("\n");
    expect(body).toHaveLength(1500);
    expect(body[0]).toBe("1\tline 1");
    expect(body[1499]).toBe("1500\tline 1500");
    expect(out).toContain("Showing lines 1 to 1500 of 3000");
  });

  test("SPEC-OUT-002/CA-02 — offset 2000 and limit 10 return lines 2000 to 2009 with their real numbers", async () => {
    const out = text(await readFileTool.execute({ path: big, offset: 2000, limit: 10 }, ctx()));
    const body = out.split("\n\n[")[0]!.split("\n");
    expect(body).toHaveLength(10);
    expect(body[0]).toBe("2000\tline 2000");
    expect(body[9]).toBe("2009\tline 2009");
  });

  test("SPEC-OUT-002/CA-05 — a relative path is refused (ERR-01)", () => {
    expect(readFileTool.validate!({ path: "big.txt" }, ctx())).toBe("The path must be absolute.");
  });

  test("SPEC-OUT-002/CA-06 — a file covered by a deny rule: permission refused, no content returned", async () => {
    ws.write("project/secret.txt", "TOP-SECRET-CONTENT");
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: join(ws.project, "secret.txt") } }] }, { text: "done" }]);
    const r = await cli(["--non-interactive", "--deny-rule", "read_file(secret.txt)", "read it"], ws, { provider });
    expect(r.code).toBe(0);
    const results = JSON.stringify(provider.requests[1]!.history);
    expect(results).toContain("Action denied");
    expect(results).not.toContain("TOP-SECRET-CONTENT");
  });

  test("TECH — CRLF, UTF-8 BOM, empty and missing files", async () => {
    const crlf = ws.write("project/crlf.txt", "﻿a\r\nb\r\n");
    expect(text(await readFileTool.execute({ path: crlf }, ctx()))).toBe("1\ta\n2\tb");
    const empty = ws.write("project/empty.txt", "");
    expect(text(await readFileTool.execute({ path: empty }, ctx()))).toBe("The file is empty.");
    const missing = await readFileTool.execute({ path: join(ws.project, "bigg.txt") }, ctx());
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain("big.txt");
  });

  test("D-06 — since lot 2, a PDF is read as a document: a truncated one is reported unreadable, never as text", async () => {
    const pdf = ws.write("project/doc.pdf", "%PDF-1.4");
    expect(text(await readFileTool.execute({ path: pdf }, ctx()))).toBe("Unreadable PDF: it is protected by a password or damaged.");
  });
});
