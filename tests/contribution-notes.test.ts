import { expect, test } from "bun:test";
import { join } from "node:path";
import { gitProject } from "./helpers/git-project";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { loadIdentity } from "./helpers/env";
import { ContributionNotes } from "../src/integrations/contribution-notes";
test("SPEC-INT-010/CA-01 — a file actually written by the model’s file tool and committed receives a 100 percent local contribution note", async () => {
  const f = gitProject(),
    file = join(f.ws.project, "new-feature.ts"),
    identity = loadIdentity(),
    p = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: "write_file",
            input: { path: file, content: "export const feature = 42;\n" },
          },
        ],
      },
      { text: "File prepared." },
      {
        toolCalls: [
          {
            name: "run_shell",
            input: { command: "git add -- new-feature.ts" },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "run_shell",
            input: {
              command:
                "git commit --only -m 'feat: add feature\n\nReviewed-with: Fixture' -- new-feature.ts",
            },
          },
        ],
      },
      { text: "Commit saved." },
    ]);
  const h = new Host(f.ws, {
    provider: p,
    env: f.env,
    userConfig: {
      attribution: { notes: true, commitTrailer: "Reviewed-with: Fixture" },
      permissions: { allowRules: ["write_file", "run_shell"] },
    },
  });
  try {
    h.user("Create the feature file.");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("File prepared."),
    );
    h.user("/git-commit");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Commit saved."),
    );
    const note = JSON.parse(
      f.git(
        "notes",
        "--ref=" + identity.get("PRODUCT_SLUG") + "-contributions",
        "show",
        "HEAD",
      ),
    );
    expect(note.files["new-feature.ts"]).toEqual({
      agent: 1,
      total: 1,
      percent: 100,
    });
    expect(note.percent).toBe(100);
    expect(note.modelTier).toBe(identity.tierLabel("MODEL_MEDIUM", "fr"));
    expect(JSON.stringify(note)).not.toContain("test-medium");
    expect(note.surface).toBe("control");
    expect(f.git("log", "-1", "--format=%B")).toContain(
      "Reviewed-with: Fixture",
    );
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 20000);
test("SPEC-INT-010/CA-02 — notes disabled still keep the configured contribution trailer on the real Git commit", async () => {
  const f = gitProject(),
    identity = loadIdentity(),
    p = new ScriptedProvider([
      {
        toolCalls: [
          { name: "run_shell", input: { command: "git add -- code.ts" } },
        ],
      },
      {
        toolCalls: [
          {
            name: "run_shell",
            input: {
              command:
                "git commit --only -m 'fix: update code\n\nReviewed-with: Fixture' -- code.ts",
            },
          },
        ],
      },
      { text: "Saved without notes." },
    ]);
  const h = new Host(f.ws, {
    provider: p,
    env: f.env,
    userConfig: {
      attribution: { notes: false, commitTrailer: "Reviewed-with: Fixture" },
      permissions: { allowRules: ["run_shell"] },
    },
  });
  try {
    h.user("/git-commit");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("Saved without notes."),
    );
    expect(f.git("log", "-1", "--format=%B")).toContain(
      "Reviewed-with: Fixture",
    );
    expect(
      f.git(
        "for-each-ref",
        "--format=%(refname)",
        "refs/notes/" + identity.get("PRODUCT_SLUG") + "-contributions",
      ),
    ).toBe("");
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 20000);
test("TECH — human edits, generated files and restored contribution metadata stay distinct", () => {
  const f = gitProject(),
    saved: unknown[] = [],
    warnings: string[] = [],
    o = {
      git: "git",
      cwd: f.ws.project,
      environment: f.env,
      ref: "fixture-contributions",
      enabled: () => true,
      tier: () => "Configured tier",
      surface: "terminal",
      save: (s: unknown) => saved.push(s),
      warn: (m: string) => warnings.push(m),
    },
    tracker = new ContributionNotes(o),
    file = join(f.ws.project, "code.ts");
  // First line changed by a human before the agent appends the second line.
  tracker.record({
    path: file,
    before: "export const value=20;\n",
    after: "export const value=20;\nexport const generatedByAgent=1;\n",
  });
  f.ws.write(
    "project/code.ts",
    "export const value=20;\nexport const generatedByAgent=1;\n",
  );
  f.git("add", "code.ts");
  f.git("commit", "-qm", "Mixed ownership");
  tracker.observeCommit();
  const note = JSON.parse(
    f.git("notes", "--ref=fixture-contributions", "show", "HEAD"),
  );
  expect(note.files["code.ts"].percent).toBeGreaterThan(0);
  expect(note.files["code.ts"].percent).toBeLessThan(100);
  expect(warnings).toEqual([]);
  expect(saved.length).toBeGreaterThan(0);
  expect(JSON.stringify(saved)).not.toContain("export const");
  const restored = new ContributionNotes({ ...o, restored: saved.at(-1) });
  restored.observeCommit();
  expect(warnings).toEqual([]);
});
