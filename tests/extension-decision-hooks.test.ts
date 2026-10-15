// Supports: SPEC-PER-001 (extension updates revoke decision authority).
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { Host } from "./helpers/control";
import { commitInstall } from "../src/extensions/store";
import { describeExtension } from "../src/extensions/extension";
import { validateExtension } from "../src/extensions/validate";
import { fingerprintOf } from "../src/hooks/config";
import { cli, workspace } from "./helpers/env";
import { record, productEnv } from "./helpers/hooks";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-PER-001/CA-32 — reinstalling a version and upgrading a live extension both revoke previously qualified decision hooks", async () => {
  const ws = workspace(),
    recording = record(ws, "extension-approval", { decision: "allow" }),
    declaration = {
      id: "decider",
      actions: [{ type: "command", command: recording.command }],
    };
  const install = (version = "1.0.0") => {
    const root = ws.write(
      "stage/extension.json",
      JSON.stringify({
        name: "approval-helper",
        version,
        description: "Fixture approval policy.",
      }),
    );
    ws.write(
      "stage/event-hooks.json",
      JSON.stringify({ approval_needed: [declaration] }),
    );
    const temp = join(root, "..");
    return commitInstall(ws.configHome, "team", {
      temp,
      extension: describeExtension(temp, false),
      report: validateExtension(temp)!,
    });
  };
  const root = install(),
    installation = readFileSync(join(root, ".installation-id"), "utf8"),
    entry = {
      scope: "extension",
      file: join(root, "event-hooks.json"),
      id: "decider",
      fingerprint: fingerprintOf("approval_needed", declaration, installation),
    };
  const run = async () => {
    const p = new ScriptedProvider([
      {
        toolCalls: [
          {
            name: "run_shell",
            input: {
              command: "printf qualified-extension-witness > approved.txt",
            },
          },
        ],
      },
      { text: "done" },
    ]);
    const result = await cli(
      ["--non-interactive", "--approval-mode", "ask", "task"],
      ws,
      {
        provider: p,
        env: productEnv(ws),
        userConfig: {
          extensions: { enabled: { "approval-helper@team": true } },
          permissions: { decisionHooks: [entry] },
        },
      },
    );
    return { result, history: JSON.stringify(p.requests[1]!.history) };
  };
  const first = await run();
  expect(first.result.code).toBe(0);
  expect(recording.read()).toHaveLength(1);
  expect(first.history).toContain("qualified-extension-witness");
  expect(first.history).not.toContain("Not allowed");
  expect(readFileSync(join(ws.project, "approved.txt"), "utf8")).toBe(
    "qualified-extension-witness",
  );
  unlinkSync(join(ws.project, "approved.txt"));
  install();
  expect(readFileSync(join(root, ".installation-id"), "utf8")).not.toBe(
    installation,
  );
  const second = await run();
  expect(second.history).toContain("Not allowed in this run");
  expect(existsSync(join(ws.project, "approved.txt"))).toBe(false);
  expect(recording.read()).toHaveLength(2);
  expect(second.result.stderr).toContain("modifié depuis son habilitation");
  const current = readFileSync(join(root, ".installation-id"), "utf8"),
    liveEntry = {
      ...entry,
      fingerprint: fingerprintOf("approval_needed", declaration, current),
    },
    steps = [
      {
        toolCalls: [
          {
            name: "run_shell",
            input: { command: "printf live-generation > approved.txt" },
          },
        ],
      },
      { text: "first complete" },
      {
        toolCalls: [
          {
            name: "run_shell",
            input: { command: "printf live-generation > approved.txt" },
          },
        ],
      },
      { text: "second complete" },
    ],
    p = new ScriptedProvider(steps),
    h = new Host(ws, {
      provider: p,
      init: {},
      argv: ["--approval-mode", "ask"],
      env: productEnv(ws),
      userConfig: {
        extensions: { enabled: { "approval-helper@team": true } },
        permissions: { decisionHooks: [liveEntry] },
      },
    });
  try {
    h.user("first");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("first complete"),
    );
    expect(existsSync(join(ws.project, "approved.txt"))).toBe(true);
    unlinkSync(join(ws.project, "approved.txt"));
    install("1.1.0");
    expect(readFileSync(join(root, ".installation-id"), "utf8")).toBe(current);
    h.user("second");
    await h.waitFor(
      (m) =>
        m.type === "turn_completed" &&
        JSON.stringify(m).includes("second complete"),
    );
    expect(existsSync(join(ws.project, "approved.txt"))).toBe(false);
    expect(JSON.stringify(p.requests[3]!.history)).toContain(
      "Not allowed in this run",
    );
  } finally {
    h.feed.end();
    await h.finish();
  }
}, 20000);
