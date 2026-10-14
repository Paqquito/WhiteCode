// Implements: SPEC-MOT-036 (private file writes, generated index and normal refusal precedence).
// Supports: SPEC-OUT-002/003/004, SPEC-PER-001, gap E-163.
import type { Tool, ToolContext, ToolPreview } from "../tools/types";
import { textOutcome } from "../tools/types";
import { readPreconditionError, readStateKey, recordWrite, toLf } from "../tools/text-file";
import { existsSync } from "node:fs";
import type { MemoryStore } from "./store";
import { planBlockAnchor, planEdit } from "../tools/edit-match";
import { unifiedDiff } from "../shared/diff";

export function memoryFileTool(tool: Tool<never>, store: MemoryStore, changed: (context: ToolContext) => void): Tool<never> {
  if (!["read_file", "write_file", "edit_file"].includes(tool.name)) return tool;
  const pathOf = (input: never, ctx: ToolContext): string | undefined => { const subject = tool.ruleSubject(input, ctx); return subject.kind === "paths" && subject.paths.length === 1 && store.owns(subject.paths[0]!) ? subject.paths[0] : undefined; };
  const memoryPreview = (input: never, ctx: ToolContext, path: string): ToolPreview => {
    try {
      const file = store.filename(path), exists = existsSync(path);
      if (file === store.indexFile || ctx.readDenied(path)) return { refusal: textOutcome("The memory is protected by the product or denied.", true) };
      const before = exists ? toLf(store.read(file).text) : "";
      if (exists) { const problem = readPreconditionError(path, ctx, tool.name === "write_file", tool.name === "write_file" ? "rewrite" : "edit"); if (problem) return { refusal: textOutcome(problem, true) }; }
      let after: string, humanOnly = false;
      if (tool.name === "write_file") after = toLf((input as { content: string }).content);
      else {
        const edit = input as { old_text: string; new_text: string; all_occurrences?: boolean }, old = toLf(edit.old_text), replacement = toLf(edit.new_text);
        if (!old) { if (before) return { refusal: textOutcome("old_text can be empty only to create an empty memory.", true) }; after = replacement; }
        else {
          let plan = planEdit(before, old, replacement, edit.all_occurrences === true, ctx.settings.editLenientMatching);
          if (plan.kind === "not_found" && ctx.editAnchorAllowed && ctx.settings.editLenientMatching && !edit.all_occurrences) plan = planBlockAnchor(before, old, replacement, ctx.settings.editMinSimilarity ?? 0.8);
          if (plan.kind !== "planned") return { refusal: textOutcome("The memory passage does not match uniquely; read it and provide more precise context.", true) };
          after = plan.content; humanOnly = plan.step === 5;
        }
      }
      const problem = store.validate(file, after); if (problem) return { refusal: textOutcome(problem, true) };
      return { diff: unifiedDiff(before, after, path), change: { path, before, after }, ...(humanOnly ? { humanOnly: true } : {}) };
    } catch { return { refusal: textOutcome("A memory requires verified ordinary Markdown without secrets.", true) }; }
  };
  return { ...tool,
    validate: (input, ctx) => {
      const original = tool.validate?.(input, ctx); if (original) return original;
      const path = pathOf(input, ctx); if (!path) return undefined;
      if (ctx.readDenied(path)) return "Access to this memory is denied.";
      if (tool.name === "read_file") return ctx.readDenied(path) ? "Reading this memory is denied." : store.readable(path);
      try { const file = store.filename(path); if (tool.name === "write_file") return store.validate(file, (input as { content: string }).content); if (file === store.indexFile) return "The memory index is maintained by the product."; return existsSync(path) ? store.readable(path) : undefined; }
      catch { return "Memory writes require an ordinary project memory filename."; }
      return undefined;
    },
    permissionContribution: (input, ctx) => pathOf(input, ctx) ? "allow" : tool.permissionContribution?.(input, ctx),
    preview: tool.preview ? async (input, ctx) => {
      const path = pathOf(input, ctx);
      return path && tool.name !== "read_file" ? memoryPreview(input, ctx, path) : tool.preview!(input, ctx);
    } : undefined,
    execute: async (input, ctx) => {
      const path = pathOf(input, ctx); if (!path) return tool.execute(input, ctx);
      ctx.signal.throwIfAborted();
      if (tool.name === "read_file") {
        try {
          if (ctx.readDenied(path)) return textOutcome("Reading this memory is denied.", true);
          const file = store.filename(path), memory = file === store.indexFile ? { text: store.index(), modifiedMs: 0, size: 0 } : store.read(file);
          if (ctx.readDenied(path)) return textOutcome("Reading this memory is denied.", true);
          const range = input as { offset?: number; limit?: number }, lines = memory.text.split(/\r?\n/); if (lines.at(-1) === "") lines.pop();
          const start = (range.offset ?? 1) - 1, end = Math.min(lines.length, start + (range.limit ?? ctx.settings.readDefaultLines));
          let truncated = false;
          const shown = lines.slice(start, end).map((line, i) => { if (line.length > ctx.settings.readMaxLineLength) { truncated = true; line = line.slice(0, ctx.settings.readMaxLineLength) + " [line truncated]"; } return `${start + i + 1}\t${line}`; });
          if (file !== store.indexFile) ctx.readState.set(readStateKey(path, ctx.platform), { mtimeMs: memory.modifiedMs, size: memory.size, complete: start === 0 && end === lines.length && !truncated });
          return textOutcome(shown.join("\n") || "The memory has no lines in this range.");
        } catch { return textOutcome("Only valid ordinary project memories and their bounded index can be read.", true); }
      }
      const preview = memoryPreview(input, ctx, path); if ("refusal" in preview) return preview.refusal;
      const content = preview?.change?.after; if (content === undefined) return textOutcome("A memory must be a bounded Markdown text file.", true);
      try {
        store.put(store.filename(path), content, () => { ctx.signal.throwIfAborted(); if (existsSync(path)) { const problem = readPreconditionError(path, ctx, tool.name === "write_file", "rewrite"); if (problem) throw new Error(problem); } });
        recordWrite(path, ctx); changed(ctx); return textOutcome(`Updated project memory ${store.filename(path)} and its index.`);
      } catch (error) { return textOutcome(error instanceof Error ? error.message : "Memory could not be written.", true); }
    },
  };
}
