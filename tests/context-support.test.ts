import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Conversation } from "../src/engine/conversation";
import { microCompact } from "../src/engine/micro-compaction";
import { contextFiles } from "../src/commands/context-files";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { CommandCatalog } from "../src/commands/catalog";
import { INTERNAL_COMMANDS } from "../src/commands/internal";
test("SPEC-CMD-028/CA-01 — after real micro-compaction only the retained read remains complete", () => {
  const conversation = new Conversation([], []);
  for (const path of ["first.ts", "second.ts"]) { conversation.appendAssistant({ role: "assistant", text: "", native: { provider: "test", content: [] }, toolCalls: [{ callId: path, name: "read_file", input: { path } }] }); conversation.appendToolResults([{ type: "tool_result", callId: path, isError: false, content: [{ type: "text", text: "1\tconst answer = 42;" }] }]); }
  expect(microCompact(conversation, 1)).toBe(1); const rows = contextFiles(conversation.messages); expect(rows.find(row => row.path === "first.ts")?.state).toBe("retiré"); expect(rows.filter(row => row.state === "complet").map(row => row.path)).toEqual(["second.ts"]);
});
test("TECH — context file inspection tracks partial attachments, restored files and actual command dispatch", async () => {
  const conversation = new Conversation([], []); conversation.appendUser([{ type: "text", text: '<attached-file path="partial.ts" truncated="true">\nfirst line\n</attached-file>' }, { type: "text", text: 'Restored after the compaction, current content of restored.ts:\nconst restored = true;' }]); expect(contextFiles(conversation.messages).find(row => row.path === "partial.ts")?.state).toBe("partiel"); expect(contextFiles(conversation.messages).find(row => row.path === "restored.ts")?.state).toBe("complet");
  const controller = new AbortController(), provider = new ScriptedProvider([]), run = interactive([], workspace(), { provider, signal: controller.signal }); try { await run.idle(); run.type("/context-files"); run.type(KEY.enter); await run.waitFor(text => text.includes("Aucun fichier dans le contexte")); expect(provider.requests).toHaveLength(0); } finally { controller.abort(); await run.done; }
});
test("TECH — refusal of a heap snapshot produces no memory file", async () => {
  const ws = workspace(), controller = new AbortController(), run = interactive([], ws, { provider: new ScriptedProvider([]), signal: controller.signal }); try { await run.idle(); run.type("/heap-dump"); run.type(KEY.enter); await run.waitFor(text => text.includes("données sensibles")); await sleep(380); run.type("n"); await run.idle(); expect(readdirSync(ws.home).filter(name => name.endsWith(".heapsnapshot"))).toHaveLength(0); } finally { controller.abort(); await run.done; }
});
test("SPEC-CMD-046/CA-01 — the hidden deprecated command shows its notice and opens preferences without a model", async () => {
  const controller = new AbortController(), provider = new ScriptedProvider([]), run = interactive([], workspace(), { provider, signal: controller.signal });
  try { await run.idle(); run.type("/response-style"); run.type(KEY.enter); await run.waitFor(text => text.includes("dépréciée")); await run.waitFor(text => text.includes("models.selected")); expect(provider.requests).toHaveLength(0); }
  finally { controller.abort(); await run.done; }
  const empty = { skills: new Map(), qualified: new Map(), aliases: new Map(), ambiguous: new Map(), warnings: [] }; const names = new CommandCatalog({ internal: INTERNAL_COMMANDS, skills: empty, connectors: [], disabled: [] }).entries().map(row => row.name); expect(names).not.toContain("response-style"); expect(names).not.toContain("heap-dump");
});
test("SPEC-CMD-029/CA-01 — after a sensitive-content warning and confirmation the actual heap file and path are produced", async () => {
  const ws = workspace(), controller = new AbortController(), provider = new ScriptedProvider([]), run = interactive([], ws, { provider, signal: controller.signal });
  try { await run.idle(); run.type("/heap-dump"); run.type(KEY.enter); await run.waitFor(text => text.includes("données sensibles")); expect(readdirSync(ws.home).filter(name => name.endsWith(".heapsnapshot"))).toHaveLength(0); await sleep(380); run.type("y"); await run.waitFor(text => text.includes("Instantané enregistré"), "heap snapshot", 20_000);
    const files = readdirSync(ws.home).filter(name => name.endsWith(".heapsnapshot")); expect(files).toHaveLength(1); const data = JSON.parse(readFileSync(join(ws.home, files[0]!), "utf8")); expect(data.snapshot.meta.node_fields).toContain("type"); expect(data.nodes.length).toBeGreaterThan(0); expect(data.strings.length).toBeGreaterThan(0); expect(provider.requests).toHaveLength(0);
  } finally { controller.abort(); await run.done; }
}, 30_000);
