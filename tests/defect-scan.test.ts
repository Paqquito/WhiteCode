// Supports: SPEC-EXT-036 (native Git worktrees and reproduction commands, actual control/interactive composition; model boundary scripted).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { productEnv } from "./helpers/hooks";
import { ScriptedProvider, type ScriptStep } from "./helpers/scripted-provider";
const candidate = {
  file: "calc.ts",
  start_line: 1,
  end_line: 1,
  severity: 1,
  category: "correctness",
  explanation:
    "The zero case must return zero; division currently produces Infinity.",
};
const verification = (script?: string) => ({
  text: JSON.stringify({
    confirmed: true,
    reason:
      "The implementation divides one by zero, violating the documented zero-result contract.",
    line: 1,
    quote: "return 1/x",
    ...(script ? { reproduction: script } : {}),
  }),
});
const reproduce =
  'import {reciprocal} from "./calc.ts"; if(reciprocal(0)!==Infinity)throw Error("Defect not reproduced"); console.log("DEFECT_REPRODUCED");';
function fixture() {
  const ws = workspace();
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(
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
      { cwd: ws.project, env: productEnv(ws) },
    );
    if (result.exitCode !== 0) throw Error(result.stderr.toString());
    return result.stdout.toString();
  };
  git("init", "-q", "-b", "main");
  ws.write(
    "project/calc.ts",
    "export function reciprocal(x:number){return x===0?0:1/x;}\n",
  );
  ws.write("project/README.md", "Contract: reciprocal(0) returns zero.\n");
  git("add", ".");
  git("commit", "-qm", "Initial");
  git("checkout", "-qb", "fixture-defect");
  ws.write(
    "project/calc.ts",
    "export function reciprocal(x:number){return 1/x;}\n",
  );
  git("add", "calc.ts");
  git("commit", "-qm", "Introduce zero defect");
  return { ws, git };
}
function host(
  f: ReturnType<typeof fixture>,
  agents: ScriptStep[],
  main: ScriptStep[] = [
    {
      toolCalls: [
        {
          name: "background_output",
          input: { task_id: "a1", block: true, timeout: 15000 },
        },
      ],
    },
    { text: "Report available." },
  ],
) {
  const p = new ScriptedProvider(main, agents),
    h = new Host(f.ws, {
      provider: p,
      env: productEnv(f.ws),
      argv: ["--approval-mode", "auto_edit"],
      init: { decisionAuthority: true },
      answers: { approval_request: () => ({ decision: "allow" }) },
      userConfig: {
        sessions: { autoTitle: false },
        skills: { defectScan: { fleetSize: 1 } },
      },
    });
  return { p, h };
}
async function start(h: Host, args = "") {
  const r = await h.request("invoke_command", {
    command: "/defect-scan" + (args ? " " + args : ""),
  });
  expect(JSON.stringify(r)).toContain("a1");
}
async function report(h: Host, p: ScriptedProvider) {
  h.user("Show the campaign report");
  await h.waitFor(
    (m) =>
      m.type === "turn_completed" &&
      JSON.stringify(m).includes("Report available."),
    20000,
  );
  return JSON.stringify(p.requests.at(-1)!.history);
}
const read = { toolCalls: [{ name: "read_file", input: { path: "calc.ts" } }] };
test("SPEC-EXT-036/CA-01 — a known branch defect reaches the review artifact only after a real reproduction in a disposable worktree", async () => {
  const f = fixture(),
    before = f.git("status", "--porcelain"),
    { p, h } = host(f, [
      read,
      { text: JSON.stringify([candidate]) },
      read,
      verification(reproduce),
    ]);
  try {
    await start(h);
    const text = await report(h, p);
    expect(text).toContain("Recherche de défauts");
    expect(text).toContain('\\"file\\":\\"calc.ts\\"');
    expect(text).toContain("divides one by zero");
    expect(p.requests.filter((r) => r.purpose === "subagent").length).toBe(4);
    expect(
      h
        .demands("approval_request")
        .some((d) => JSON.stringify(d).includes("bun review-reproduction.ts")),
    ).toBe(true);
    expect(f.git("status", "--porcelain")).toBe(before);
    expect(
      f.git("worktree", "list", "--porcelain").match(/^worktree /gm),
    ).toHaveLength(1);
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 30000);
test("SPEC-EXT-036/CA-02 — a reproduction which prints a marker but exits in failure cannot confirm a candidate", async () => {
  const f = fixture(),
    { p, h } = host(f, [
      read,
      { text: JSON.stringify([candidate]) },
      read,
      verification(
        'import "./calc.ts";console.log("DEFECT_REPRODUCED");process.exit(1);',
      ),
    ]);
  try {
    await start(h);
    const text = await report(h, p);
    expect(text).toContain("Unconfirmed candidate omitted");
    expect(text).toContain('\\"findings\\":[]');
    expect(
      f.git("worktree", "list", "--porcelain").match(/^worktree /gm),
    ).toHaveLength(1);
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 30000);
test("SPEC-EXT-036/CA-03 — another user turn completes while an explorer is still running", async () => {
  const f = fixture(),
    { h } = host(
      f,
      [{ ...read, delayMs: 3000 }, { text: "[]" }],
      [{ text: "Still available." }],
    );
  try {
    await start(h);
    h.user("Are you available?");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Still available."),
    );
    const state = await h.request("get_state");
    expect(JSON.stringify(state)).toContain('"status":"running"');
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 15000);
test("SPEC-EXT-036/CA-04 — analysis-only runs readers and reasoned verification without any test, copy or project modification", async () => {
  const f = fixture(),
    hash = () =>
      createHash("sha256")
        .update(readFileSync(join(f.ws.project, "calc.ts")))
        .digest("hex"),
    before = hash(),
    copies = f.git("worktree", "list", "--porcelain"),
    { p, h } = host(f, [
      read,
      { text: JSON.stringify([candidate]) },
      read,
      verification('throw Error("This must never run");'),
    ]);
  try {
    await start(h, "--analysis-only");
    const text = await report(h, p);
    expect(text).toContain("Analyse seule");
    expect(text).toContain("divides one by zero");
    expect(
      h
        .demands("approval_request")
        .some((d) =>
          /write_file|run_shell|run_powershell/.test(JSON.stringify(d)),
        ),
    ).toBe(false);
    expect(f.git("worktree", "list", "--porcelain")).toBe(copies);
    expect(f.git("status", "--porcelain")).toBe("");
    expect(hash()).toBe(before);
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 20000);
