// Supports: SPEC-INT-005.
import { expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { workspace } from "./helpers/env";
import {
  prepareEditor,
  welcomeEditor,
} from "../src/integrations/editor-install";
test("SPEC-INT-005/CA-01 — an integrated terminal installs its missing configured extension through the editor CLI", async () => {
  const ws = workspace(),
    mark = join(ws.root, "installed"),
    script = ws.write(
      "editor.ts",
      `import{existsSync,writeFileSync}from"node:fs";const args=process.argv.slice(2);if(args.includes("--list-extensions")) console.log(existsSync(${JSON.stringify(mark)})?"distribution.bridge":"");else if(args.includes("--install-extension")&&args.at(-1)==="distribution.bridge")writeFileSync(${JSON.stringify(mark)},"installed");else process.exit(2);`,
    );
  const notes: string[] = [];
  await prepareEditor({
    kind: "vscode",
    extension: "distribution.bridge",
    enabled: true,
    disabled: false,
    cwd: ws.project,
    environment: { ...process.env } as Record<string, string>,
    signal: new AbortController().signal,
    report: (n) => notes.push(n),
    program: { file: process.execPath, args: [script] },
  });
  expect(existsSync(mark)).toBe(true);
  expect(notes).toContain("Extension IDE installée : distribution.bridge.");
});
test("SPEC-INT-005/CA-02 — a persisted first-connection welcome is not displayed again", async () => {
  const ws = workspace(),
    path = join(ws.configHome, "state.json"),
    notes: string[] = [];
  await welcomeEditor("vscode", path, (n) => notes.push(n));
  await welcomeEditor("vscode", path, (n) => notes.push(n));
  expect(notes).toHaveLength(1);
  expect(JSON.parse(readFileSync(path, "utf8")).ideWelcomes).toEqual([
    "vscode",
  ]);
});
