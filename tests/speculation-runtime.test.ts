import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { interactive, sleep } from "./helpers/interactive";
import { workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { Host } from "./helpers/control";

const config = { ui: { promptSuggestions: true }, engine: { speculation: { enabled: true } } };
async function until(check: () => boolean): Promise<void> { for (let n = 0; n < 200; n++) { if (check()) return; await sleep(10); } throw Error("Speculative request was not reached"); }

test("SPEC-MOT-029/CA-01 — the actual terminal discards staged file bytes as soon as the user types a different request", async () => {
  const ws = workspace(), file = ws.write("project/source.txt", "ORIGINAL\n"), stop = new AbortController();
  const provider = new ScriptedProvider([{ text: "Initial work done" }, { text: "Improve the source" }, { toolCalls: [{ name: "read_file", input: { path: file } }] }, { toolCalls: [{ name: "write_file", input: { path: file, content: "SPECULATIVE\n" } }] }, { text: "SPECULATIVE_RESULT" }]);
  const run = interactive(["--approval-mode=auto_edit"], ws, { provider, signal: stop.signal, userConfig: config });
  try {
    await run.idle(); run.type("Inspect\r"); await run.waitFor(text => text.includes("Improve the source"));
    await until(() => provider.requests.length >= 5); await sleep(30);
    expect(readFileSync(file, "utf8")).toBe("ORIGINAL\n"); expect(run.all().join("\n")).not.toContain("SPECULATIVE_RESULT");
    run.type("A different question"); await sleep(40);
    expect(readFileSync(file, "utf8")).toBe("ORIGINAL\n"); expect(provider.requests).toHaveLength(5);
    expect(run.all().join("\n")).toContain("consomment du modèle");
  } finally { stop.abort(); await run.done; }
});

test("SPEC-MOT-029/CA-02 — the actual control driver presents a suspended permission only when the identical suggestion is sent", async () => {
  const ws = workspace(), file = join(ws.project, "created.txt"); let asks = 0;
  const provider = new ScriptedProvider([{ text: "Initial answer" }, { text: "Create the sample file" }, { toolCalls: [{ name: "write_file", input: { path: file, content: "APPROVED_SAMPLE" } }] }, { text: "Sample ready" }, { text: "" }]);
  const host = new Host(ws, { provider, userConfig: config, init: { decisionAuthority: true }, answers: { approval_request: () => { asks++; return { decision: "allow" }; } } });
  try {
    host.user("Inspect"); await host.waitFor(message => message.type === "input_suggestion"); await until(() => provider.requests.length >= 3); await sleep(30);
    expect(asks).toBe(0); expect(existsSync(file)).toBe(false);
    host.user("Create the sample file"); await host.waitFor(message => message.type === "turn_completed" && !!message["result"] && JSON.stringify(message).includes("Sample ready"));
    expect(asks).toBe(1); expect(readFileSync(file, "utf8")).toBe("APPROVED_SAMPLE");
    expect(provider.requests.filter(request => request.history.some(message => message.role === "user" && JSON.stringify(message.parts).includes("Create the sample file")) && request.purpose !== "side")).toHaveLength(2);
  } finally { host.feed.end(); expect((await host.finish()).code).toBe(0); }
});

test("TECH — Tab then Enter promotes the real terminal draft without a second main-model turn", async () => {
  const ws = workspace(), file = ws.write("project/source.txt", "ORIGINAL\n"), stop = new AbortController();
  const provider = new ScriptedProvider([{ text: "Initial work done" }, { text: "Improve the source" }, { toolCalls: [{ name: "read_file", input: { path: file } }] }, { toolCalls: [{ name: "write_file", input: { path: file, content: "PROMOTED\n" } }] }, { text: "PROMOTED_TERMINAL_RESULT" }, { text: "" }]);
  const run = interactive(["--approval-mode=auto_edit"], ws, { provider, signal: stop.signal, userConfig: config });
  try {
    await run.idle(); run.type("Inspect\r"); await run.waitFor(text => text.includes("Improve the source")); await until(() => provider.requests.length >= 5); await sleep(20);
    expect(readFileSync(file, "utf8")).toBe("ORIGINAL\n"); run.type("\t\r"); await run.waitFor(text => text.includes("PROMOTED_TERMINAL_RESULT"));
    expect(readFileSync(file, "utf8")).toBe("PROMOTED\n"); expect(provider.requests.filter(request => request.purpose !== "side")).toHaveLength(4);
  } finally { stop.abort(); await run.done; }
});
