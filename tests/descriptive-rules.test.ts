// Supports: SPEC-PER-006 (real executor and CLI command effects; model classification boundary scripted).
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { DescriptiveRules } from "../src/permissions/descriptive";
import {
  decide,
  type PermissionContext,
  type PermissionQuery,
} from "../src/permissions/engine";
import { parseRule, isRule, type Rule } from "../src/permissions/rules";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { productEnv } from "./helpers/hooks";
function rule(raw: string, decision: "allow" | "deny" | "ask" = "allow"): Rule {
  const r = parseRule(raw, decision, "user", "/project");
  if (!isRule(r)) throw Error(r.message);
  return r;
}
test("SPEC-PER-006/CA-01 — the CLI classifies a test command once and runs the real project suite twice", async () => {
  const ws = workspace();
  ws.write(
    "project/project-check.ts",
    "await Bun.write('suite-count.txt',String(Number(await Bun.file('suite-count.txt').text().catch(()=>0))+1));",
  );
  let classifiers = 0;
  const p = new ScriptedProvider([
    {
      toolCalls: [
        { name: "run_shell", input: { command: "bun project-check.ts" } },
      ],
    },
    (request) => {
      expect(request.purpose).toBe("side");
      expect(request.tools).toEqual([]);
      expect(JSON.stringify(request.history)).toContain(
        "commandes de test du projet",
      );
      classifiers++;
      return { text: '{"match":true,"confidence":"high"}' };
    },
    {
      toolCalls: [
        { name: "run_shell", input: { command: "bun project-check.ts" } },
      ],
    },
    { text: "Suite complete" },
  ]);
  const r = await cli(["--non-interactive", "run project tests twice"], ws, {
    provider: p,
    env: productEnv(ws),
    userConfig: {
      permissions: {
        allowRules: ["run_shell(prompt: commandes de test du projet)"],
      },
    },
  });
  expect(
    r.code,
    JSON.stringify({
      out: r.stdout,
      err: r.stderr,
      requests: p.requests.map((r) => ({
        purpose: r.purpose,
        history: r.history,
      })),
    }),
  ).toBe(0);
  expect(readFileSync(ws.project + "/suite-count.txt", "utf8")).toBe("2");
  expect(classifiers).toBe(1);
  expect(p.requests.length).toBe(4);
}, 15000);
test("SPEC-PER-006/CA-02 — a deletion does not match the test-only rule and the real project file survives", async () => {
  const ws = workspace(),
    file = ws.write("project/keep.txt", "keep");
  const p = new ScriptedProvider([
    {
      toolCalls: [
        {
          name: "run_shell",
          input: {
            command: "bun -e \"require('node:fs').unlinkSync('keep.txt')\"",
          },
        },
      ],
    },
    { text: '{"match":false,"confidence":"high"}' },
    { text: "Permission was not granted" },
  ]);
  await cli(["--non-interactive", "evaluate command"], ws, {
    provider: p,
    env: productEnv(ws),
    userConfig: {
      permissions: {
        allowRules: ["run_shell(prompt: commandes de test du projet)"],
      },
    },
  });
  expect(p.requests.length).toBe(3);
  expect(p.requests[1]!.purpose).toBe("side");
  expect(existsSync(file)).toBe(true);
  expect(readFileSync(file, "utf8")).toBe("keep");
  expect(JSON.stringify(p.requests.at(-1)!.history)).toContain("isError");
}, 15000);
function setup(
  rules: Rule[],
  sample: (text: string, signal: AbortSignal) => Promise<string | undefined>,
) {
  const classifier = new DescriptiveRules({ sample });
  const context: PermissionContext = {
    mode: "ask",
    rules,
    sessionAllows: [],
    managedRulesOnly: false,
    cwd: "/project",
    home: "/home",
    platform: "linux",
    descriptiveRuleVerdict: (r, c, w) => classifier.verdict(r, c, w),
  };
  const query: PermissionQuery = {
    toolName: "run_shell",
    subject: { kind: "command", command: "bun project-check.ts" },
    flags: {
      readOnly: false,
      concurrencySafe: false,
      destructive: false,
      requiresPermission: true,
      openWorld: false,
    },
    available: true,
  };
  return { classifier, context, query };
}
test("TECH — descriptive denies dominate a matching ordinary allow, and uncertainty still requires a human", async () => {
  for (const text of [
    '{"match":true,"confidence":"high"}',
    undefined,
    '{"match":true,"confidence":"uncertain"}',
  ]) {
    const f = setup(
      [
        rule("run_shell(bun project-check.ts)"),
        rule("run_shell(prompt: tests)", "deny"),
      ],
      async () => text,
    );
    await f.classifier.prepare(
      f.query,
      f.context,
      new AbortController().signal,
    );
    expect(decide(f.query, f.context).kind).toBe(
      text?.includes('"high"') ? "deny" : "ask",
    );
  }
});
test("TECH — a classifier failure or malformed/tool-like answer never grants a descriptive allow", async () => {
  for (const text of [
    undefined,
    '{"match":true,"confidence":"uncertain"}',
    '{"match":true,"confidence":"high","command":"delete"}',
    "true",
  ]) {
    const f = setup([rule("run_shell(prompt: tests)")], async () => text);
    await f.classifier.prepare(
      f.query,
      f.context,
      new AbortController().signal,
    );
    expect(decide(f.query, f.context).kind).toBe("ask");
  }
});
test("TECH — pattern deny avoids the classifier, and changing the directory invalidates the classification cache", async () => {
  let calls = 0;
  const f = setup([rule("run_shell(prompt: tests)")], async () => {
      calls++;
      return '{"match":true,"confidence":"high"}';
    }),
    signal = new AbortController().signal;
  await f.classifier.prepare(f.query, f.context, signal);
  await f.classifier.prepare(f.query, f.context, signal);
  expect(calls).toBe(1);
  await f.classifier.prepare(f.query, { ...f.context, cwd: "/other" }, signal);
  expect(calls).toBe(2);
  await f.classifier.prepare(
    f.query,
    {
      ...f.context,
      rules: [
        ...f.context.rules,
        rule("run_shell(bun project-check.ts)", "deny"),
      ],
    },
    signal,
  );
  expect(calls).toBe(2);
  expect(
    isRule(parseRule("read_file(prompt: all files)", "allow", "user", "/")),
  ).toBe(false);
});
