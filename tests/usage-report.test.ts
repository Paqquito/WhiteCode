import { expect, test } from "bun:test";
import { join } from "node:path";
import { workspace } from "./helpers/env";
import { TranscriptWriter } from "../src/session/transcript";
import { allSessions } from "../src/session/discovery";
import { usageReport, temporaryReportPage } from "../src/session/usage-report";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { editExternally } from "../src/interactive/external-editor";
import type { CredentialVault } from "../src/platform/credential-vault";
import {
  readdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
} from "node:fs";
test("SPEC-CMD-034/CA-01 — fifty sessions with ten cached facets analyze only the forty new sessions", async () => {
  const ws = workspace(),
    sessionsDir = join(ws.configHome, "sessions");
  for (let i = 0; i < 50; i++) {
    const writer = new TranscriptWriter({
      sessionsDir,
      projectRealPath: ws.project,
    });
    writer.append("user", {
      content: [{ type: "text", text: "session " + i }],
    });
    writer.close();
  }
  const sessions = allSessions(sessionsDir);
  let count = 0;
  const options = {
    directory: join(ws.configHome, "session-analysis"),
    signal: new AbortController().signal,
    redact: (text: string) => text,
    sample: async (kind: "facet" | "synthesis", input: string) => {
      if (kind === "facet") count++;
      return kind === "facet"
        ? "Objective: tests. Outcome: observed. Friction: absent."
        : "Local report summary.";
    },
  };
  await usageReport({ ...options, sessions: sessions.slice(0, 10) });
  count = 0;
  const report = await usageReport({ ...options, sessions });
  expect(count).toBe(40);
  expect(report.analyzed).toBe(40);
  expect(report.cached).toBe(10);
  expect(report.summary).toContain("Local report");
});
test("SPEC-CMD-034/CA-02 — SPEC-SES-001/CA-14 — managed encryption keeps the report inline and refuses an external editor", async () => {
  const ws = workspace(),
    entries = new Map<string, string>(),
    vault: CredentialVault = {
      read: (service, account) => entries.get(service + account),
      write: (service, account, value) => {
        entries.set(service + account, value);
      },
      remove: () => {},
    };
  writeFileSync(
    join(ws.managed, "policy.json"),
    JSON.stringify({ storage: { encryption: { enabled: true } } }),
  );
  const writer = new TranscriptWriter({
    sessionsDir: join(ws.configHome, "sessions"),
    projectRealPath: ws.project,
  });
  writer.append("user", {
    content: [{ type: "text", text: "Past analysis session" }],
  });
  writer.close();
  const provider = new ScriptedProvider([
    { text: "Objective: testing. Outcome: observed." },
    { text: "Summary of observed session." },
  ]);
  const h = new Host(ws, { provider, extra: { credentialVault: vault } });
  try {
    const response = await h.request("invoke_command", {
      command: "/usage-report",
    });
    const text = JSON.stringify(response);
    expect(text).toContain("Summary of observed session");
    expect(text).toContain("chiffrement est imposé");
    expect(text).not.toContain(".html");
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
  const before = readdirSync(ws.root);
  let launched = false;
  const notices: string[] = [];
  expect(
    await editExternally("private draft", {
      command: "fixture",
      encryption: "managed",
      maxChars: 1000,
      temporaryRoot: ws.root,
      notify: (text) => notices.push(text),
      launch: async () => {
        launched = true;
        return 0;
      },
    }),
  ).toBeUndefined();
  expect(launched).toBe(false);
  expect(notices.join("\n")).toContain("imposé");
  expect(readdirSync(ws.root)).toEqual(before);
});
test("TECH — report pages escape model text and cleanup refuses a replaced file", () => {
  const ws = workspace(),
    report = temporaryReportPage(ws.root, "<script>untrusted</script>");
  expect(readFileSync(report.path, "utf8")).toContain("&lt;script&gt;");
  expect(readFileSync(report.path, "utf8")).not.toContain("<script>");
  report.close();
  expect(existsSync(report.path)).toBe(false);
  const changed = temporaryReportPage(ws.root, "text"),
    original = changed.path + ".original";
  renameSync(changed.path, original);
  writeFileSync(changed.path, "user replacement");
  expect(() => changed.close()).toThrow("remplac");
  expect(readFileSync(changed.path, "utf8")).toBe("user replacement");
  expect(existsSync(original)).toBe(true);
});
