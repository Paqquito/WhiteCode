// Internal-profile native Git and interactive-banner probe; model response boundary scripted.
import { gitProject } from "../helpers/git-project";
import { interactive } from "../helpers/interactive";
import { ScriptedProvider } from "../helpers/scripted-provider";
const f = gitProject();
f.git(
  "remote",
  "add",
  "origin",
  "https://forge.example.test/public/project.git",
);
const controller = new AbortController(),
  provider = new ScriptedProvider([
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
              "git commit --only -m 'feat: update calculation' -- code.ts",
          },
        },
      ],
    },
    { text: "Discreet commit created." },
  ]);
const run = interactive(["--approval-mode", "auto_edit"], f.ws, {
  provider,
  env: f.env,
  signal: controller.signal,
  userConfig: {
    git: { commitAttribution: "Reviewed-with: Fixture" },
    permissions: { allowRules: ["run_shell"] },
    ui: { promptSuggestions: false },
    sessions: { autoTitle: false },
  },
});
try {
  await run.idle();
  await run.waitFor((t) => t.includes("Mode discret"));
  run.type("/git-commit\r");
  await run.waitFor(
    (t) => t.includes("Discreet commit created."),
    "internal commit",
    15000,
  );
  const message = f.git("log", "-1", "--format=%B");
  if (
    message !== "feat: update calculation" ||
    /co-authored-by|Reviewed-with/i.test(message)
  )
    throw Error("Discreet commit included an attribution.");
  if (!run.screen().join("\n").includes("Mode discret"))
    throw Error("Discreet banner was not kept visible.");
  console.log("GIT_DISCREET_PROBE_PASSED");
} finally {
  controller.abort();
  await run.done;
}
