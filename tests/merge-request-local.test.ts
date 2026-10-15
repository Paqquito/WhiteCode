// Supports: SPEC-INT-008, SPEC-INT-009.
import { expect, test } from "bun:test";
import { workspace, cli } from "./helpers/env";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { join, delimiter } from "node:path";
import { mkdirSync } from "node:fs";
import { productEnv } from "./helpers/hooks";
import { createdMergeRequests } from "../src/integrations/merge-request";
test("TECH — merge request extraction rejects URL prefixes and text merely quoting a forge command", () => {
  const call = {
      callId: "one",
      name: "run_shell",
      input: { command: "gh pr create" },
    },
    result = {
      type: "tool_result" as const,
      callId: "one",
      isError: false,
      content: [
        {
          type: "text" as const,
          text: "https://github.com/example/project/pull/42evil\nhttps://github.com/example/project/pull/43.extra\n(https://github.com/example/project/pull/44).",
        },
      ],
    };
  expect(createdMergeRequests([call], [result])).toEqual([
    "https://github.com/example/project/pull/44",
  ]);
  expect(
    createdMergeRequests(
      [{ ...call, input: { command: "echo 'gh pr create'" } }],
      [result],
    ),
  ).toEqual([]);
});
test("SPEC-INT-008/CA-01 — a real forge subprocess populates the terminal footer with an approved request", async () => {
  const ws = workspace(),
    script = ws.write(
      "forge.ts",
      'console.log(JSON.stringify({number:42,url:"https://github.com/example/project/pull/42",state:"OPEN",reviewDecision:"APPROVED"}));',
    );
  const run = interactive([], ws, {
    provider: new ScriptedProvider([]),
    extra: { forgeProgram: { file: process.execPath, args: [script] } },
  });
  try {
    await run.waitFor(
      (t) => t.includes("#42") && t.includes("approuvée"),
      "forge footer",
    );
  } finally {
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  }
}, 15000);
test("SPEC-INT-009/CA-01 — creation records the merge link and the CLI resumes that session", async () => {
  const ws = workspace(),
    script = ws.write(
      "forge.ts",
      'console.log("https://github.com/example/project/pull/42");',
    ),
    bin = join(ws.root, "bin");
  mkdirSync(bin);
  const binary = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  const build = Bun.spawn(
    [process.execPath, "build", script, "--compile", "--outfile", binary],
    { stdout: "pipe", stderr: "pipe" },
  );
  expect(await build.exited).toBe(0);
  const environment = productEnv(ws);
  {
    const key =
      Object.keys(environment).find((key) => key.toLowerCase() === "path") ??
      "PATH";
    environment[key] = bin + delimiter + (environment[key] ?? "");
  }
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "run_shell", input: { command: "gh pr create" } }] },
    { text: "created" },
  ]);
  const first = await cli(["--non-interactive", "question"], ws, {
    provider,
    env: environment,
    userConfig: { permissions: { allowRules: ["run_shell(gh pr create)"] } },
  });
  expect(first.code).toBe(0);
  const next = new ScriptedProvider([{ text: "resumed" }]);
  const result = await cli(
    ["--non-interactive", "--from-merge-request", "42", "continue"],
    ws,
    { provider: next, env: environment },
  );
  expect(result.code).toBe(0);
  expect(JSON.stringify(next.requests[0]!.history)).toContain("created");
  expect(JSON.stringify(next.requests[0]!.history)).toContain("continue");
}, 30000);
