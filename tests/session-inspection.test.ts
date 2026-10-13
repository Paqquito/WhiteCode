import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { interactive, KEY } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { projectSessions, readTranscript, sessionTitle } from "../src/session/sessions";

test("SPEC-SES-008/CA-02 — a user title remains unchanged after six later turns", async () => {
  const ws = workspace(), provider = new ScriptedProvider(Array.from({ length: 6 }, (_, n) => ({ text: `reply-${n}` })));
  const host = new Host(ws, { provider });
  try {
    await host.request("invoke_command", { command: "/retitle Migration BDD" });
    for (let n = 0; n < 6; n++) { host.user(`message-${n}`); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === n + 1); }
  } finally { host.feed.end(); await host.finish(); }
  const sessions = projectSessions(join(ws.configHome, "sessions"), ws.project);
  expect(sessionTitle(readTranscript(sessions[0]!.path).records)).toBe("Migration BDD");
});

test("SPEC-SES-008/CA-03 — name at launch is persisted before the first user exchange", async () => {
  const ws = workspace(), host = new Host(ws, { provider: new ScriptedProvider([]), argv: ["--name", "revue"] });
  try { await host.request("invoke_command", { command: "/status" }); const sessions = projectSessions(join(ws.configHome, "sessions"), ws.project); expect(sessionTitle(readTranscript(sessions[0]!.path).records)).toBe("revue"); }
  finally { host.feed.end(); await host.finish(); }
});

test("SPEC-CMD-015/CA-01 — copying position two selects the penultimate textual response in its source form", async () => {
  const ws = workspace(), copied: string[] = [], provider = new ScriptedProvider([{ text: "first" }, { text: "**second**\n```ts\nconst n = 2;\n```" }, { text: "third" }]);
  const host = new Host(ws, { provider, extra: { copyText: async text => { copied.push(text); return true; } } });
  try {
    for (let n = 0; n < 3; n++) { host.user(`message-${n}`); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === n + 1); }
    await host.request("invoke_command", { command: "/copy-reply 2" }); expect(copied).toEqual(["**second**\n```ts\nconst n = 2;\n```"]); expect(provider.requests).toHaveLength(3);
  } finally { host.feed.end(); await host.finish(); }
});

test("SPEC-CMD-088/CA-01 — a denied call displays the matching rule and decision step without calling the model again", async () => {
  const ws = workspace(), target = join(ws.project, "denied.txt"), provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "no" } }] }, { text: "refused" }]);
  const host = new Host(ws, { provider, userConfig: { permissions: { denyRules: ["write_file(**)"] } } });
  try {
    host.user("Write."); await host.waitFor(m => m.type === "turn_completed");
    const result = await host.request("invoke_command", { command: "/inspect-tool-call" });
    const report = JSON.stringify(result); expect(report).toContain("write_file(**)"); expect(report).toContain("deny"); expect(report).toContain("Étape"); expect(provider.requests).toHaveLength(2);
  } finally { host.feed.end(); await host.finish(); }
});

test("SPEC-CMD-106/CA-01 — a side summary is shown while the next main request preserves the original conversation", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "Original answer witness." }, { text: "Side summary witness." }, { text: "Follow-up answer." }]);
  const host = new Host(ws, { provider });
  try {
    host.user("Original user witness."); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === 1);
    const result = await host.request("invoke_command", { command: "/session-summary" }); expect(JSON.stringify(result)).toContain("Side summary witness");
    host.user("Continue."); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === 2);
    expect(provider.requests[1]!.purpose).toBe("side"); expect(provider.requests[1]!.tools).toHaveLength(0);
    const history = JSON.stringify(provider.requests[2]!.history); expect(history).toContain("Original user witness"); expect(history).toContain("Original answer witness"); expect(history).not.toContain("Side summary witness"); expect(history).not.toContain("/session-summary");
  } finally { host.feed.end(); await host.finish(); }
});

test("SPEC-CMD-097/CA-01 — two other active sessions of the user are listed", async () => {
  const ws = workspace(), provider = new ScriptedProvider([]), controllers = [new AbortController(), new AbortController()];
  const runs = controllers.map(controller => interactive([], ws, { provider, signal: controller.signal }));
  try {
    await Promise.all(runs.map(run => run.idle()));
    const sessions = projectSessions(join(ws.configHome, "sessions"), ws.project);
    const result = await cli(["--non-interactive", "/peers"], ws, { provider });
    for (const session of sessions) expect(result.stdout).toContain(session.id);
    expect(sessions).toHaveLength(2); expect(provider.requests).toHaveLength(0);
  } finally { controllers.forEach(controller => controller.abort()); await Promise.all(runs.map(run => run.done)); }
});

test("TECH — cancelling a side summary leaves the main history usable and produces no late summary", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "original" }, { hang: true }, { text: "continued" }]);
  const controller = new AbortController(), run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("original input"); run.type(KEY.enter); await run.waitFor(t => t.includes("original")); await run.idle();
    run.type("/session-summary"); run.type(KEY.enter);
    const deadline = Date.now() + 3000; while (provider.requests.length < 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(provider.requests[1]!.purpose).toBe("side"); run.type(KEY.ctrlC); await run.idle();
    run.type("continue"); run.type(KEY.enter); await run.waitFor(t => t.includes("continued"));
    expect(JSON.stringify(provider.requests[2]!.history)).not.toContain("/session-summary");
  } finally { controller.abort(); await run.done; }
});
