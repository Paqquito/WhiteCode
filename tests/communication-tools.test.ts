import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("TECH — addressed attachments respect read denials and workspace boundaries", async () => {
  const ws = workspace(), allowed = ws.write("project/public.txt", "PUBLIC_ATTACHMENT"), denied = ws.write("project/private.txt", "PRIVATE_ATTACHMENT"), outside = ws.write("home/outside.txt", "OUTSIDE_ATTACHMENT");
  const events: unknown[] = [], provider = new ScriptedProvider([{ toolCalls: [{ name: "message_user", input: { message: "ATTACHED", status: "normal", attachments: [allowed, denied, outside] } }] }, { text: "" }]);
  const result = await cli(["--non-interactive", "Work."], ws, { provider, userConfig: { modes: { brief: true }, permissions: { denyRules: ["read_file(private.txt)"] } }, extra: { onEvent: event => events.push(event) } });
  expect(result.code).toBe(0); const emitted = JSON.stringify(events.filter(event => (event as { type: string }).type === "addressed_message"));
  expect(emitted).toContain("PUBLIC_ATTACHMENT"); expect(emitted).not.toContain("PRIVATE_ATTACHMENT"); expect(emitted).not.toContain("OUTSIDE_ATTACHMENT"); expect(toolResults(provider)).toContain("Attachments omitted");
});

const toolResults = (provider: ScriptedProvider): string => JSON.stringify(provider.requests.at(-1)?.history.flatMap(message => message.role === "user" ? message.parts.filter(part => part.type === "tool_result") : []));

test("TECH — manually loading a skill excludes it from the initial automatic suggestions", async () => {
  const ws = workspace(); ws.write("home/config/skills/publication/definition.md", '---\ndescription: "Publish the release."\n---\nMANUALLY_LOADED_BODY\n');
  const provider = new ScriptedProvider([{ text: "done" }]);
  const result = await cli(["--non-interactive", "/publication"], ws, { provider });
  expect(result.code).toBe(0); const history = JSON.stringify(provider.requests[0]!.history);
  expect(history).toContain("MANUALLY_LOADED_BODY"); expect(history).not.toContain("Relevant local skills (metadata only");
});

test("SPEC-OUT-038/CA-01 — automatic skill suggestions exclude the same skill from a subsequent discovery", async () => {
  const ws = workspace(); ws.write("home/config/skills/publication/definition.md", '---\ndescription: "Publish the project release."\n---\nPRIVATE_SKILL_CONTENT\n');
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "discover_skills", input: { description: "Publish the project release." } }] }, { text: "done" }]);
  const result = await cli(["--non-interactive", "Publish the project release."], ws, { provider });
  expect(result.code).toBe(0); expect(JSON.stringify(provider.requests[0]!.history)).toContain("publication");
  expect(toolResults(provider)).not.toContain("publication"); expect(JSON.stringify(provider.requests)).not.toContain("PRIVATE_SKILL_CONTENT");
});

test("SPEC-OUT-038/CA-02 — a publication pivot discovers a local publication skill without loading its body", async () => {
  const ws = workspace(); ws.write("home/config/skills/publication/definition.md", '---\ndescription: "Publish the project release."\n---\nPRIVATE_SKILL_CONTENT\n');
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "discover_skills", input: { description: "Publish the project release." } }] }, { text: "done" }]);
  expect((await cli(["--non-interactive", "Parse the input."], ws, { provider })).code).toBe(0);
  expect(toolResults(provider)).toContain("publication"); expect(JSON.stringify(provider.requests)).not.toContain("PRIVATE_SKILL_CONTENT");
});

test("SPEC-MOD-029/CA-01 — SPEC-OUT-034/CA-01 — three real file reads stay in detail while the addressed message is displayed", async () => {
  const ws = workspace(), controller = new AbortController();
  const files = [1, 2, 3].map(number => ws.write(`project/file${number}.txt`, `HIDDEN_FILE_${number}`));
  const provider = new ScriptedProvider([{ text: "HIDDEN_INTERMEDIATE", toolCalls: files.map(path => ({ name: "read_file", input: { path } })) }, { toolCalls: [{ name: "message_user", input: { message: "VISIBLE_ADDRESS", status: "normal" } }] }, { text: "" }]);
  const run = interactive([], ws, { provider, signal: controller.signal, userConfig: { modes: { brief: true } } });
  try {
    await run.idle(); run.type("Read the files."); run.type(KEY.enter); await run.waitFor(text => text.includes("VISIBLE_ADDRESS")); await run.idle();
    const main = run.all().join("\n"); expect(main).not.toContain("HIDDEN_INTERMEDIATE"); expect(main).not.toContain("HIDDEN_FILE_"); expect(main).not.toContain("read_file");
    run.type("\u001bt"); await run.waitFor(text => text.includes("Transcription")); expect(run.screen().join("\n")).toContain("Appel");
    expect(toolResults(provider)).toContain("HIDDEN_FILE_1"); expect(provider.requests).toHaveLength(3);
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-MOD-029/CA-02 — a final response without message_user is promoted in brief mode", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ text: "FINAL_FALLBACK" }]);
  const run = interactive([], ws, { provider, signal: controller.signal, userConfig: { modes: { brief: true } } });
  try { await run.idle(); run.type("Answer."); run.type(KEY.enter); await run.waitFor(text => text.includes("FINAL_FALLBACK")); expect(provider.requests).toHaveLength(1); }
  finally { controller.abort(); await run.done; }
});

test("SPEC-CMD-007/CA-01 — concise-replies makes the next model request advertise and require addressed messages", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([{ toolCalls: [{ name: "message_user", input: { message: "TOGGLED_ADDRESS", status: "normal" } }] }, { text: "" }]);
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("/concise-replies"); run.type(KEY.enter); await run.waitFor(text => text.includes("Messages courts activés")); await run.idle();
    run.type("Answer."); run.type(KEY.enter); await run.waitFor(text => text.includes("TOGGLED_ADDRESS"));
    expect(provider.requests[0]!.tools.map(tool => tool.name)).toContain("message_user"); expect(JSON.stringify(provider.requests[0])).toContain("address substantive replies");
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-OUT-034/CA-02 — a proactive addressed message in an unattended run emits a notification", async () => {
  const ws = workspace(), events: unknown[] = [], provider = new ScriptedProvider([{ toolCalls: [{ name: "message_user", input: { message: "PROACTIVE_ADDRESS", status: "proactive" } }] }, { text: "" }]);
  const result = await cli(["--non-interactive", "Work."], ws, { provider, userConfig: { modes: { brief: true } }, extra: { onEvent: event => events.push(event) } });
  expect(result.code).toBe(0); expect(events).toContainEqual(expect.objectContaining({ type: "notification", message: "PROACTIVE_ADDRESS" })); expect(result.stdout).toContain("PROACTIVE_ADDRESS");
});

test("SPEC-OUT-045/CA-01 — five findings return three accepted and two rejected decisions without changing code", async () => {
  const ws = workspace(), controller = new AbortController(), path = ws.write("project/code.ts", "const value = 1;\n");
  const findings = [1, 2, 3, 4, 5].map(number => ({ id: `finding${number}`, file: path, start_line: 1, end_line: 1, severity: 1, category: "correctness", explanation: `Finding ${number}`, proposed_diff: "-const value = 1;\n+const value = 2;" }));
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "review_artifact", input: { title: "Review", summary: "Five findings", findings } }] }, { text: "REVIEW_DONE" }]);
  const run = interactive([], ws, { provider, signal: controller.signal });
  try {
    await run.idle(); run.type("Review."); run.type(KEY.enter);
    for (const number of [1, 2, 3, 4, 5]) { await run.waitFor(text => text.includes(`Constat finding${number}`)); await sleep(380); run.type(number <= 3 ? "1" : "2"); run.type(KEY.enter); }
    await run.waitFor(text => text.includes("REVIEW_DONE")); const result = toolResults(provider);
    expect((result.match(/accepted/g) ?? [])).toHaveLength(3); expect((result.match(/rejected/g) ?? [])).toHaveLength(2); expect(readFileSync(path, "utf8")).toBe("const value = 1;\n");
  } finally { controller.abort(); await run.done; }
}, 15_000);

test("SPEC-OUT-045/CA-02 — an unattended run excludes the review artifact tool", async () => {
  const provider = new ScriptedProvider([{ text: "done" }]); await cli(["--non-interactive", "Work."], workspace(), { provider });
  expect(provider.requests[0]!.tools.map(tool => tool.name)).not.toContain("review_artifact");
});
