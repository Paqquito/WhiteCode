// Supports: SPEC-MOT-038/CA-01/02 and SPEC-MOT-040/CA-01/02.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { projectKey } from "../src/session/transcript";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, KEY, sleep } from "./helpers/interactive";

const body = "---\nname: Integration tests\ndescription: Prefer integration tests for behavior changes\ntype: feedback\n---\nThe user prefers integration tests for observable behavior.\n";
test("SPEC-MOT-038/CA-01 — an unrecorded preference is persisted by an isolated background file worker before automated exit", async () => {
  const ws = workspace(), file = join(ws.configHome, "memory", projectKey(realpathSync(ws.project)), "tests.md");
  const provider = new ScriptedProvider([{ text: "I will prefer integration tests." }, request => {
    expect(request.purpose).toBe("subagent"); expect(request.system).toEqual(provider.requests[0]!.system); expect(request.tools.map(tool => tool.name)).toEqual(["read_file", "write_file"]);
    expect(JSON.stringify(request.history)).toContain("I prefer integration tests");
    return { toolCalls: [{ name: "write_file", input: { path: file, content: body } }] };
  }, { text: "Preference saved." }]);
  const result = await cli(["--non-interactive", "--approval-mode", "auto_edit", "I prefer integration tests."], ws, { provider, userConfig: { memory: { automatic: { enabled: true }, recall: { enabled: false }, autoExtraction: { enabled: true }, session: { enabled: false } } } });
  if (!existsSync(file)) throw new Error(JSON.stringify({ stderr: result.stderr, requests: provider.requests.map(request => ({ purpose: request.purpose, toolCalling: request.model.capabilities.toolCalling, results: request.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result") : []).map(part => JSON.stringify(part).slice(0, 400)) })) }));
  expect(result.code).toBe(0); expect(existsSync(file)).toBe(true); expect(readFileSync(file, "utf8")).toContain("type: feedback"); expect(provider.requests).toHaveLength(3);
});

test("SPEC-MOT-038/CA-02 — minimal mode never creates an extraction request even when extraction is enabled", async () => {
  const ws = workspace(), provider = new ScriptedProvider([{ text: "Done." }]);
  const result = await cli(["--non-interactive", "--minimal", "I prefer integration tests."], ws, { provider, userConfig: { memory: { automatic: { enabled: true }, autoExtraction: { enabled: true }, session: { enabled: true } } } });
  expect(result.code).toBe(0); expect(provider.requests).toHaveLength(1); expect(existsSync(join(ws.configHome, "memory"))).toBe(false);
});

test("SPEC-MOT-040/CA-02 — a private custom notes template is materialized on session startup", async () => {
  const ws = workspace(); ws.write("home/config/memory/session-notes-template.md", "# Custom notes\n\n## Evidence\n\n## Remaining work\n");
  const provider = new ScriptedProvider([{ text: "Done." }]);
  const result = await cli(["--non-interactive", "Work."], ws, { provider, userConfig: { memory: { session: { enabled: true } } } });
  expect(result.code).toBe(0); const directory = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project)));
  const id = readdirSync(directory).find(file => file.endsWith(".jsonl"))!.replace(/\.jsonl$/, "");
  expect(readFileSync(join(directory, id, "notes.md"), "utf8")).toBe("# Custom notes\n\n## Evidence\n\n## Remaining work\n"); expect(provider.requests).toHaveLength(1);
});

test("SPEC-MOT-040/CA-01 — notes update after the volume and tool thresholds while the interactive input remains available", async () => {
  const ws = workspace(), controller = new AbortController(); const source = ws.write("project/evidence.txt", "Evidence read.\n");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path: source } }] }, { text: "The evidence was checked." }, request => {
    const directive = request.history.filter(message => message.role === "user").at(-1); const file = directive?.role === "user" ? directive.parts.flatMap(part => part.type === "text" ? part.text.split("\n") : []).find(line => line.startsWith("Notes file: "))?.slice("Notes file: ".length) : undefined;
    if (!file) throw new Error("notes path missing from worker directive");
    return { delayMs: 150, toolCalls: [{ name: "read_file", input: { path: file } }] };
  }, request => {
    const prior = request.history.filter(message => message.role === "assistant").at(-1); if (!prior || prior.role !== "assistant") throw new Error("notes read missing");
    const path = (prior.toolCalls[0]!.input as { path: string }).path;
    return { toolCalls: [{ name: "write_file", input: { path, content: "# Session notes\n\n## Goal\nCheck the evidence.\n\n## Completed work\nEvidence verified.\n\n## Decisions\nUse integration tests.\n\n## Next steps\nReport the result.\n" } }] };
  }, { text: "Notes updated." }]);
  const run = interactive([], ws, { provider, signal: controller.signal, userConfig: { memory: { session: { enabled: true, updateEveryTokens: 1, updateEveryToolCalls: 1 } } } });
  try {
    await run.idle(); run.type("Check the evidence."); run.type(KEY.enter); await run.waitFor(text => text.includes("The evidence was checked."));
    await run.waitFor(() => provider.requests.length >= 3); run.type("Editable draft."); await run.waitFor(() => run.screen().join("\n").includes("Editable draft."));
    const directory = join(ws.configHome, "sessions", projectKey(realpathSync(ws.project))), id = readdirSync(directory).find(file => file.endsWith(".jsonl"))!.replace(/\.jsonl$/, "");
    await run.waitFor(() => readFileSync(join(directory, id, "notes.md"), "utf8").includes("Evidence verified."), "private notes update: " + JSON.stringify(provider.requests.map(request => ({ purpose: request.purpose, results: request.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result") : []).map(part => JSON.stringify(part).slice(0, 400)) }))));
    expect(provider.requests).toHaveLength(5); expect(provider.requests[2]!.tools.map(tool => tool.name)).toEqual(["read_file", "write_file"]); expect(run.finished()).toBe(false);
    await sleep(20);
  } finally { controller.abort(); await run.done; }
}, 15_000);
