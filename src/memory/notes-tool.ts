// Supports: SPEC-MOT-040 (only the private designated notes file can be changed), gap E-163.
import type { Tool } from "../tools/types";
import { textOutcome } from "../tools/types";
import { readPreconditionError, readStateKey, recordWrite, writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";
import type { SessionNotes } from "./session-notes";
export function notesReadTool(base: Tool<never>, notes: SessionNotes): Tool<never> {
  return { ...base, async execute(input, ctx) {
    ctx.signal.throwIfAborted();
    try {
      if (ctx.readDenied(notes.path)) return textOutcome("Reading session notes is denied.", true);
      const value = notes.read(), lines = value.text.split(/\r?\n/); if (lines.at(-1) === "") lines.pop();
      const range = input as { offset?: number; limit?: number }, start = (range.offset ?? 1) - 1, end = Math.min(lines.length, start + (range.limit ?? ctx.settings.readDefaultLines));
      let truncated = false;
      const shown = lines.slice(start, end).map((line, i) => { if (line.length > ctx.settings.readMaxLineLength) { truncated = true; line = line.slice(0, ctx.settings.readMaxLineLength) + " [line truncated]"; } return `${start + i + 1}\t${line}`; });
      ctx.readState.set(readStateKey(notes.path, ctx.platform), { mtimeMs: value.modifiedMs, size: value.size, complete: start === 0 && end === lines.length && !truncated });
      return textOutcome(shown.join("\n") || "The notes have no lines in this range.");
    } catch { return textOutcome("Session notes require bounded ordinary private text without secrets.", true); }
  } };
}
export function notesWriteTool(base: Tool<never>, notes: SessionNotes): Tool<never> {
  return { ...base, permissionContribution: () => "allow", validate: (input, ctx) => base.validate?.(input, ctx) ?? notes.validate((input as { content: string }).content),
    async execute(input, ctx) {
      ctx.signal.throwIfAborted(); const content = (input as { content: string }).content, problem = notes.validate(content) ?? readPreconditionError(notes.path, ctx, true, "rewrite");
      if (problem) return textOutcome(problem, true);
      writeAtomic(notes.path, Buffer.from(content), currentPlatform(), true); recordWrite(notes.path, ctx); return textOutcome("Updated private session notes.");
    },
  };
}
