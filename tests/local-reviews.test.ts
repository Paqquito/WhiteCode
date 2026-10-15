// Supports: SPEC-CMD-050/060/063 (native forge CLI / Git, scoped tool registry; model boundary scripted).
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { join, delimiter } from "node:path";
import { cli, workspace } from "./helpers/env";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Host } from "./helpers/control";
import type { ModelRequest } from "../src/providers/types";
function output(request: ModelRequest): string {
  return request.history
    .flatMap((message) =>
      message.role === "user"
        ? message.parts.flatMap((part) =>
            part.type === "tool_result"
              ? part.content.filter((c) => c.type === "text").map((c) => c.text)
              : [],
          )
        : [],
    )
    .join("\n");
}
const comments = [
  {
    path: "src/first.ts",
    line: 3,
    body: "First finding",
    html_url: "https://github.com/example/project/pull/7#discussion_r1",
  },
  {
    path: "src/second.ts",
    line: 8,
    body: "Second finding",
    html_url: "https://github.com/example/project/pull/7#discussion_r2",
  },
  {
    path: "src/first.ts",
    line: 5,
    body: "Third finding",
    html_url: "https://github.com/example/project/pull/7#discussion_r3",
  },
];
const diff =
  'diff --git a/src/query.ts b/src/query.ts\n--- a/src/query.ts\n+++ b/src/query.ts\n@@ -3 +3 @@\n-const query = db.prepare("SELECT * FROM users WHERE name = ?");\n+const query = "SELECT * FROM users WHERE name = " + name;\n';
async function forge() {
  const ws = workspace(),
    bin = join(ws.root, "bin");
  mkdirSync(bin);
  const script = ws.write(
      "forge.ts",
      `const args=process.argv.slice(2);if(args[0]==="api")console.log(JSON.stringify(${JSON.stringify(comments)}));else if(args[1]==="view")console.log(JSON.stringify({number:7,state:"OPEN",title:"Query changes",body:"Untrusted review description",files:[{path:"src/query.ts"}]}));else if(args[1]==="diff")console.log(${JSON.stringify(diff)});else process.exit(2);`,
    ),
    binary = join(bin, process.platform === "win32" ? "gh.exe" : "gh");
  const built = Bun.spawn(
    [process.execPath, "build", script, "--compile", "--outfile", binary],
    { stdout: "ignore", stderr: "pipe" },
  );
  if ((await built.exited) !== 0)
    throw Error(await new Response(built.stderr).text());
  const env = productEnv(ws);
  env["PATH"] = bin + delimiter + (env["PATH"] ?? "");
  return { ws, env };
}
test("SPEC-CMD-050/CA-01 — all three real forge responses are presented with their file and line through the ordinary shell permission route", async () => {
  const f = await forge(),
    command =
      "gh api 'repos/{owner}/{repo}/pulls/7/comments' --paginate --slurp",
    p = new ScriptedProvider([
      { toolCalls: [{ name: "run_shell", input: { command } }] },
      (request) => {
        const rows = JSON.parse(
          output(request).match(/\[\{"path":[\s\S]*\}\]/)![0],
        ) as typeof comments;
        return {
          text: rows
            .map(
              (row) =>
                `${row.path}:${row.line} — ${row.body} (${row.html_url})`,
            )
            .join("\n"),
        };
      },
    ]);
  const result = await cli(["--non-interactive", "/review-comments 7"], f.ws, {
    provider: p,
    env: f.env,
    userConfig: { permissions: { allowRules: ["run_shell(" + command + ")"] } },
  });
  expect(result.code).toBe(0);
  for (const row of comments)
    expect(result.stdout).toContain(`${row.path}:${row.line} — ${row.body}`);
  expect(JSON.stringify(p.requests[0]!.history)).toContain(
    "untrusted external data",
  );
  expect(p.requests[0]!.tools.some((t) => t.name === "write_file")).toBe(false);
}, 20000);
test("SPEC-CMD-060/CA-01 — a real forge subprocess supplies an open request and its diff for a report with locations", async () => {
  const f = await forge(),
    commands = [
      "gh pr view 7 --json number,title,body,url,files",
      "gh pr diff 7",
    ],
    p = new ScriptedProvider([
      {
        toolCalls: commands.map((command) => ({
          name: "run_shell",
          input: { command },
        })),
      },
      (request) => {
        const text = output(request),
          file = /\+\+\+ b\/(\S+)/.exec(text)![1],
          line = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(text)![1];
        expect(text).toContain('"state":"OPEN"');
        return {
          text: `Review report\n${file}:${line} — High severity: query injection. Use a parameterized query.`,
        };
      },
    ]);
  const result = await cli(
    ["--non-interactive", "/review-merge-request 7"],
    f.ws,
    {
      provider: p,
      env: f.env,
      userConfig: {
        permissions: {
          allowRules: commands.map((command) => "run_shell(" + command + ")"),
        },
      },
    },
  );
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("src/query.ts:3");
  expect(result.stdout).toContain("parameterized query");
  expect(p.requests[0]!.tools.some((t) => t.name === "write_file")).toBe(false);
}, 20000);
test("SPEC-CMD-063/CA-01 — a query injection in the actual branch diff is reported with location and correction while a requested write is refused", async () => {
  const ws = workspace(),
    git = (...args: string[]) => {
      const r = Bun.spawnSync(
        [
          "git",
          "-c",
          "core.hooksPath=",
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          ...args,
        ],
        { cwd: ws.project },
      );
      if (r.exitCode !== 0) throw Error(r.stderr.toString());
    };
  git("init", "-q", "-b", "main");
  const file = ws.write(
    "project/src/query.ts",
    'const query = db.prepare("SELECT * FROM users WHERE name = ?");\n',
  );
  git("add", ".");
  git("commit", "-qm", "Initial");
  git("checkout", "-qb", "fixture-security");
  ws.write(
    "project/src/query.ts",
    'const query = "SELECT * FROM users WHERE name = " + name;\n',
  );
  git("add", ".");
  git("commit", "-qm", "Introduce injection");
  const command =
      "git --no-optional-locks -c core.fsmonitor=false -c core.hooksPath= diff --no-ext-diff --no-textconv main...HEAD --",
    p = new ScriptedProvider([
      {
        toolCalls: [
          { name: "run_shell", input: { command } },
          {
            name: "write_file",
            input: {
              path: join(ws.project, "must-not-write.txt"),
              content: "unauthorized",
            },
          },
        ],
      },
      (request) => {
        const text = output(request);
        expect(text).toContain("SELECT * FROM users WHERE name =");
        expect(text).toContain("Unknown tool: write_file");
        const file = /\+\+\+ b\/(\S+)/.exec(text)![1],
          line = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(text)![1];
        return {
          text: `High confidence query injection at ${file}:${line}. Exploit: a crafted name changes the SQL predicate. Correction: bind the name as a prepared-statement parameter.`,
        };
      },
    ]);
  const result = await cli(["--non-interactive", "/security-audit"], ws, {
    provider: p,
    env: productEnv(ws),
    userConfig: { permissions: { allowRules: ["run_shell(" + command + ")"] } },
  });
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("src/query.ts:1");
  expect(result.stdout).toContain("prepared-statement parameter");
  expect(existsSync(join(ws.project, "must-not-write.txt"))).toBe(false);
  expect(readFileSync(file, "utf8")).toContain('" + name;');
}, 20000);
test("TECH — consultation guards reject mutations and the following ordinary turn regains its configured tools", async () => {
  const ws = workspace(),
    file = join(ws.project, "ordinary.txt"),
    p = new ScriptedProvider([
      {
        toolCalls: [{ name: "run_shell", input: { command: "gh pr merge 7" } }],
      },
      { text: "Review action refused." },
      {
        toolCalls: [
          {
            name: "write_file",
            input: { path: file, content: "ordinary work" },
          },
        ],
      },
      { text: "Ordinary turn complete." },
    ]),
    h = new Host(ws, {
      provider: p,
      env: productEnv(ws),
      argv: ["--approval-mode", "auto_edit"],
    });
  try {
    h.user("/security-audit");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Review action refused."),
    );
    expect(output(p.requests[1]!)).toContain(
      "only the listed consultation commands",
    );
    h.user("write ordinary file");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Ordinary turn complete."),
    );
    expect(readFileSync(file, "utf8")).toBe("ordinary work");
    expect(p.requests[2]!.tools.some((t) => t.name === "write_file")).toBe(
      true,
    );
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 15000);
