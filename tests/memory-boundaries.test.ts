// Supports: SPEC-MOT-036/037, SPEC-PER-001 (refusals and bounded private memory).
import { expect, test } from "bun:test";
import { existsSync, linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryStore } from "../src/memory/store";
import { MemoryRecall } from "../src/memory/recall";
import { memoryFileTool } from "../src/memory/file-tools";
import { readFileTool } from "../src/tools/read-file";
import { editFileTool } from "../src/tools/edit-file";
import { notesReadTool } from "../src/memory/notes-tool";
import { SessionNotes } from "../src/memory/session-notes";
import type { Tool } from "../src/tools/types";
import { bench } from "./helpers/engine";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";

const INDEX = loadIdentity().get("MEMORY_INDEX_FILE");
const fact = (name = "Project procedure") => `---\nname: ${name}\ndescription: Durable procedure\ntype: reference\n---\nMEMORY_BOUNDARY_WITNESS: validate before publishing.\n`;
function fixture() { const ws = workspace(), root = join(ws.root, "memory"); mkdirSync(root); return { ws, root, store: new MemoryStore(root, { indexFile: INDEX, maxLines: 150, maxBytes: 20480, redact: text => text }) }; }

test("TECH — decoded sensitive YAML metadata is refused before either memory or index is written", () => {
  const { root, store } = fixture();
  const content = fact('"\\x73k-' + "A".repeat(20) + '"');
  expect(store.validate("secret.md", content)).toContain("sensitive"); expect(() => store.put("secret.md", content)).toThrow();
  expect(existsSync(join(root, "secret.md"))).toBe(false); expect(existsSync(join(root, INDEX))).toBe(false);
});

test("TECH — an index publication failure rolls back a new memory and preserves an existing memory", () => {
  const { root, store } = fixture(), index = join(root, INDEX);
  expect(() => store.put("new.md", fact(), () => mkdirSync(index))).toThrow(); expect(existsSync(join(root, "new.md"))).toBe(false);
  renameSync(index, join(root, "invalid-index")); store.put("existing.md", fact());
  const before = readFileSync(join(root, "existing.md"), "utf8");
  expect(() => store.put("existing.md", fact("Changed"), () => { unlinkSync(index); mkdirSync(index); })).toThrow();
  expect(readFileSync(join(root, "existing.md"), "utf8")).toBe(before);
  expect(() => store.forget("existing.md")).toThrow(); expect(readFileSync(join(root, "existing.md"), "utf8")).toBe(before);
});

test("TECH — memory reads recheck physical ownership at execution and never reopen the ordinary tool", async () => {
  const { ws, root, store } = fixture(), path = join(root, "fact.md"), external = ws.write("project/external.md", "EXTERNAL_PRIVATE_WITNESS"); store.put("fact.md", fact());
  const ctx = bench([]).deps.executor.toolContext(new AbortController().signal);
  const wrapped = memoryFileTool(readFileTool as Tool<never>, store, () => {}), input = { path } as never;
  expect(wrapped.validate?.(input, ctx)).toBeUndefined(); unlinkSync(path); linkSync(external, path);
  expect(store.owns(path)).toBe(true); const result = await wrapped.execute(input, ctx);
  expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain("EXTERNAL_PRIVATE_WITNESS"); expect(ctx.readState.size).toBe(0);
});

test("TECH — read_file returns only the bounded verified index prefix", async () => {
  const { root, store } = fixture(); writeFileSync(join(root, INDEX), "# Project memory index\n" + "safe line\n".repeat(2500) + "PRIVATE_TAIL_WITNESS\n");
  const wrapped = memoryFileTool(readFileTool as Tool<never>, store, () => {}), ctx = bench([]).deps.executor.toolContext(new AbortController().signal);
  const result = await wrapped.execute({ path: join(root, INDEX), offset: 2400, limit: 10 } as never, ctx);
  expect(result.isError).not.toBe(true); expect(JSON.stringify(result)).not.toContain("PRIVATE_TAIL_WITNESS"); expect(ctx.readState.size).toBe(0);
});

test("TECH — memory edit previews use the verified bytes without calling the ordinary file preview", async () => {
  const { root, store } = fixture(), path = join(root, "fact.md"); store.put("fact.md", fact());
  const ctx = bench([]).deps.executor.toolContext(new AbortController().signal);
  await memoryFileTool(readFileTool as Tool<never>, store, () => {}).execute({ path } as never, ctx);
  let ordinary = 0;
  const tool = memoryFileTool({ ...editFileTool, preview: async () => { ordinary++; throw new Error("Unprotected preview called"); } } as Tool<never>, store, () => {});
  const input = { path, old_text: "validate before publishing", new_text: "validate and review before publishing" } as never;
  const preview = await tool.preview!(input, ctx); expect(ordinary).toBe(0); expect("refusal" in preview).toBe(false);
  if (!("refusal" in preview)) expect(preview.change?.after).toContain("validate and review before publishing");
  const result = await tool.execute(input, ctx); expect(result.isError).not.toBe(true); expect(ordinary).toBe(0); expect(store.read("fact.md").text).toContain("validate and review before publishing");
});

test("TECH — memory edit validation checks a read refusal before opening the memory", () => {
  const { root, store } = fixture(); store.put("fact.md", fact()); let opened = 0;
  store.readable = () => { opened++; return undefined; };
  const ctx = { ...bench([]).deps.executor.toolContext(new AbortController().signal), readDenied: () => true };
  const tool = memoryFileTool(editFileTool as Tool<never>, store, () => {});
  expect(tool.validate?.({ path: join(root, "fact.md"), old_text: "validate", new_text: "review" } as never, ctx)).toContain("denied"); expect(opened).toBe(0);
});

test("TECH — the notes worker refuses linked or sensitive notes without crediting a successful read", async () => {
  const ws = workspace(), notes = new SessionNotes(join(ws.root, "session"), text => text); notes.initialize();
  const tool = notesReadTool(readFileTool as Tool<never>, notes), ctx = bench([]).deps.executor.toolContext(new AbortController().signal);
  const external = ws.write("project/external-notes.md", "PRIVATE_NOTES_WITNESS"); unlinkSync(notes.path); linkSync(external, notes.path);
  const result = await tool.execute({ path: notes.path } as never, ctx); expect(result.isError).toBe(true); expect(JSON.stringify(result)).not.toContain("PRIVATE_NOTES_WITNESS"); expect(ctx.readState.size).toBe(0);
});

test("TECH — a refusal added during memory selection is respected and does not consume its session exclusion", async () => {
  const { store } = fixture(); store.put("fact.md", fact()); let denied = false, changeRule = true;
  const recall = new MemoryRecall({ store, maxItems: 4, staleAfterDays: 30, denied: () => denied, sample: async () => { if (changeRule) denied = true; return '["fact.md"]'; } });
  expect(await recall.recall("Deploy", new AbortController().signal)).toEqual([]);
  denied = false; changeRule = false;
  expect((await recall.recall("Deploy", new AbortController().signal)).join("\n")).toContain("MEMORY_BOUNDARY_WITNESS");
});

test("TECH — seen memories are excluded before the selection quota and candidates start with the most recent", () => {
  const { root, store } = fixture(), excluded = new Set<string>();
  for (let i = 0; i < 129; i++) { const file = `fact_${i.toString().padStart(3, "0")}.md`; writeFileSync(join(root, file), fact()); utimesSync(join(root, file), 1, i + 1); if (i < 128) excluded.add(file); }
  expect(store.entries({ maxFiles: 1 })[0]?.file).toBe("fact_128.md");
  expect(store.entries({ maxFiles: 128, excluded }).map(entry => entry.file)).toEqual(["fact_128.md"]);
});

test("TECH — memory commands obey read refusals without exposing or forgetting a denied file", async () => {
  const ws = workspace(), root = join(ws.root, "memory"); mkdirSync(root); const file = join(root, "fact.md"); writeFileSync(file, fact());
  const permissions = { denyRules: [`read_file(//${file.replace(/\\/g, "/").replace(/^\//, "")})`] };
  const config = { permissions, memory: { directory: root, automatic: { enabled: true }, recall: { enabled: false }, autoExtraction: { enabled: false }, session: { enabled: false } } };
  for (const command of ["/edit-memory-files list", "/edit-memory-files show fact.md", "/edit-memory-files forget fact.md"]) {
    const provider = new ScriptedProvider([]); const result = await cli(["--non-interactive", command], ws, { provider, userConfig: config });
    expect(JSON.stringify(result)).not.toContain("MEMORY_BOUNDARY_WITNESS"); expect(provider.requests).toHaveLength(0); expect(existsSync(file)).toBe(true);
  }
});
