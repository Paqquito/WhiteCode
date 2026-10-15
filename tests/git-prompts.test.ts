// Supports: SPEC-CMD-085/086 (actual commits and a real push to a local bare remote; forge boundary native fixture).
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join, delimiter } from "node:path";
import { gitProject } from "./helpers/git-project";
import { cli, loadIdentity } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Host } from "./helpers/control";
import { literalCommand, gitPrompt } from "../src/commands/git-prompt";
const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'",
  prefix = "git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=",
  attribution = "Reviewed-with: Fixture";
test("SPEC-CMD-085/CA-01 — selected changes are committed in the observed repository style with the configured attribution while another staged file stays untouched", async () => {
  const f = gitProject();
  f.ws.write("project/unrelated.txt", "separately staged\n");
  f.git("add", "unrelated.txt");
  let message = "";
  const p = new ScriptedProvider([
    {
      toolCalls: [
        {
          name: "run_shell",
          input: { command: prefix + " log -5 --format=%s" },
        },
        {
          name: "run_shell",
          input: {
            command: prefix + " diff --no-ext-diff --no-textconv HEAD --",
          },
        },
      ],
    },
    (request) => {
      const text = JSON.stringify(request.history);
      expect(text).toContain("feat: initial fixture");
      message = "feat: update calculation\n\n" + attribution;
      return {
        toolCalls: [
          { name: "run_shell", input: { command: "git add -- code.ts" } },
        ],
      };
    },
    () => ({
      toolCalls: [
        {
          name: "run_shell",
          input: {
            command: "git commit --only -m " + quote(message) + " -- code.ts",
          },
        },
      ],
    }),
    { text: "Commit created." },
  ]);
  const result = await cli(["--non-interactive", "/git-commit"], f.ws, {
    provider: p,
    env: f.env,
    userConfig: {
      git: { commitAttribution: attribution },
      permissions: { allowRules: ["run_shell"] },
    },
  });
  expect(result.code).toBe(0);
  expect(f.git("log", "-1", "--format=%B")).toBe(message);
  expect(f.git("show", "HEAD:unrelated.txt")).toBe("original");
  expect(f.git("diff", "--cached", "--name-only")).toBe("unrelated.txt");
  expect(p.requests[0]!.tools.map((tool) => tool.name)).toEqual(["run_shell"]);
}, 20000);
test("SPEC-CMD-086/CA-01 — pending main-branch changes move to a new branch, are committed and really pushed before the forge request is created", async () => {
  const f = gitProject(),
    remote = join(f.ws.root, "remote.git");
  f.git("init", "--bare", remote);
  f.git("remote", "add", "origin", remote);
  const bin = join(f.ws.root, "bin"),
    published = join(f.ws.root, "published.json");
  mkdirSync(bin);
  const script = f.ws.write(
      "forge.ts",
      `import{writeFileSync}from"node:fs";const args=process.argv.slice(2);if(args[0]!=="pr"||args[1]!=="create")process.exit(2);writeFileSync(${JSON.stringify(published)},JSON.stringify(args));console.log("https://github.com/example/project/pull/11");`,
    ),
    binary = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  const built = Bun.spawn(
    [process.execPath, "build", script, "--compile", "--outfile", binary],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(await built.exited).toBe(0);
  {
    const key =
      Object.keys(f.env).find((key) => key.toLowerCase() === "path") ?? "PATH";
    f.env[key] = bin + delimiter + (f.env[key] ?? "");
  }
  const branch = loadIdentity().get("BRANCH_PREFIX") + "fixture-publish",
    message = "feat: publish selected calculation\n\n" + attribution,
    body = "Selected calculation change.\n\n" + loadIdentity().get("PR_FOOTER"),
    commands = [
      "git switch -c " + quote(branch),
      "git add -- code.ts",
      "git commit --only -m " + quote(message) + " -- code.ts",
      "git push --set-upstream origin " + quote(branch),
      "gh pr create --title 'feat: publish selected calculation' --body " +
        quote(body),
    ];
  const p = new ScriptedProvider([
    ...commands.map((command) => ({
      toolCalls: [{ name: "run_shell", input: { command } }],
    })),
    { text: "Published: https://github.com/example/project/pull/11" },
  ]);
  const result = await cli(["--non-interactive", "/publish-changes"], f.ws, {
    provider: p,
    env: f.env,
    userConfig: {
      git: { commitAttribution: attribution },
      permissions: { allowRules: ["run_shell"] },
    },
  });
  expect(result.code).toBe(0);
  expect(f.git("branch", "--show-current")).toBe(branch);
  expect(f.git("rev-parse", "refs/heads/main")).not.toBe(
    f.git("rev-parse", "HEAD"),
  );
  expect(f.git("--git-dir", remote, "rev-parse", "refs/heads/" + branch)).toBe(
    f.git("rev-parse", "HEAD"),
  );
  const args = JSON.parse(readFileSync(published, "utf8"));
  expect(args.at(-1)).toBe(body);
  expect(result.stdout).toContain("pull/11");
}, 40000);
test("TECH — literal Git scope rejects expansions, compound commands, amend, force and secret paths", async () => {
  const f = gitProject(),
    plan = gitPrompt({
      publish: true,
      attribution: "",
      footer: "",
      branchPrefix: "change/",
      discreet: false,
      privateNames: [],
      redact: (t) => t,
      git: "git",
      cwd: f.ws.project,
      environment: f.env,
    });
  for (const command of [
    "git add .",
    "git commit --amend -m 'x'",
    "git push --force origin main",
    "git add -- code.ts; echo bypass",
    "git add -- $(echo code.ts)",
    "gh pr merge 11",
  ])
    expect(plan.accepts(command)).toBe(false);
  expect(
    literalCommand("git commit --only -m 'line one\n\nline two' -- code.ts"),
  ).toEqual([
    "git",
    "commit",
    "--only",
    "-m",
    "line one\n\nline two",
    "--",
    "code.ts",
  ]);
  f.ws.write("project/.env", "PASSWORD=fictional-test-value\n");
  const p = new ScriptedProvider([
    {
      toolCalls: [{ name: "run_shell", input: { command: "git add -- .env" } }],
    },
    { text: "Secret file excluded." },
  ]);
  await cli(["--non-interactive", "/git-commit"], f.ws, {
    provider: p,
    env: f.env,
    userConfig: {
      git: { commitAttribution: "" },
      permissions: { allowRules: ["run_shell"] },
    },
  });
  expect(f.git("diff", "--cached", "--name-only")).toBe("");
  expect(JSON.stringify(p.requests[1]!.history)).toContain(
    "secret locations are excluded",
  );
}, 15000);
test("TECH — file changes during a pending Git approval invalidate its proposed action", async () => {
  const f = gitProject(),
    p = new ScriptedProvider([
      {
        toolCalls: [
          { name: "run_shell", input: { command: "git add -- code.ts" } },
        ],
      },
      { text: "Updated action refused." },
    ]),
    h = new Host(f.ws, {
      provider: p,
      env: f.env,
      init: { decisionAuthority: true },
      answers: {
        approval_request: () => {
          f.ws.write("project/code.ts", "export const value=3;\n");
          return { decision: "allow" };
        },
      },
      userConfig: { git: { commitAttribution: "" } },
    });
  try {
    h.user("/git-commit");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Updated action refused."),
    );
    expect(h.demands("approval_request").length).toBeGreaterThan(0);
    expect(f.git("diff", "--cached", "--name-only")).toBe("");
    expect(JSON.stringify(p.requests[1]!.history)).toContain(
      "files changed after this action",
    );
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 15000);
