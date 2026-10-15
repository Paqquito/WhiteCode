// Implements: SPEC-AGT-007 (scoped ordinary memory, local exclusion and explicit cross-agent access).
// Supports: SPEC-MOT-036, gap E-174.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { MemoryStore } from "../memory/store";
import { currentPlatform, isWithin, realPathOrSelf } from "../platform/system";
import { writeAtomic } from "../tools/text-file";
import type { Tool } from "../tools/types";
import { memoryFileTool } from "../memory/file-tools";

export type AgentMemoryScope = "user" | "project" | "local";
export function agentMemoryName(name: string): string {
  const slug = name.normalize("NFKC").toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").slice(0, 40) || "agent";
  return slug + "-" + createHash("sha256").update(name).digest("hex").slice(0, 12);
}
function ordinaryDirectory(path: string): void {
  let at = resolve(path);
  for (;;) { if (existsSync(at)) { const stat = lstatSync(at); if (!stat.isDirectory() || stat.isSymbolicLink() || realPathOrSelf(at) !== at) throw new Error("Agent memory directories must be ordinary directories."); } const parent = dirname(at); if (at === parent) break; at = parent; }
}
export class AgentMemory {
  readonly roots: readonly string[];
  constructor(readonly options: { configDir: string; projectDir: string; indexFile: string; redact: (text: string) => string }) {
    this.roots = [join(options.configDir, "agent-memory"), join(options.projectDir, "agent-memory"), join(options.projectDir, "agent-memory-local")];
  }
  open(name: string, scope: AgentMemoryScope): MemoryStore {
    const base = this.roots[scope === "user" ? 0 : scope === "project" ? 1 : 2]!, root = join(base, agentMemoryName(name)); ordinaryDirectory(root);
    if (scope === "local") {
      ordinaryDirectory(this.options.projectDir); mkdirSync(this.options.projectDir, { recursive: true, mode: 0o700 });
      const file = join(this.options.projectDir, ".gitignore");
      if (existsSync(file)) { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error("Agent memory exclusion file must be ordinary and bounded."); }
      const previous = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (!previous.split(/\r?\n/).includes("/agent-memory-local/")) writeAtomic(file, Buffer.from(previous + (previous && !previous.endsWith("\n") ? "\n" : "") + "/agent-memory-local/\n"), currentPlatform(), true);
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    return new MemoryStore(root, { indexFile: this.options.indexFile, maxLines: 200, maxBytes: 24000, redact: this.options.redact });
  }
  tool(tool: Tool<never>, own: MemoryStore): Tool<never> {
    const decorated = memoryFileTool(tool, own, () => {});
    return { ...decorated, permissionContribution: (input, context) => {
      const subject = tool.ruleSubject(input, context);
      if (subject.kind === "paths" && subject.paths.some(path => !own.owns(path) && this.roots.some(root => isWithin(resolve(path), root, context.platform)))) return "ask";
      return decorated.permissionContribution?.(input, context);
    } };
  }
}
