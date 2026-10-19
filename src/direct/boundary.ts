// Supports: SPEC-MOD-019 (EF-02: an immutable server root is independent of human approvals and mode changes).
import { insideAllowed, realTargetPath } from "../permissions/paths";
import { statSync } from "node:fs";
import { comparablePath } from "../platform/system";
import type { PlatformName } from "../platform/system";
import { restrictedView, type ToolLookup } from "../tools/registry";
import { textOutcome, type Tool, type ToolContext } from "../tools/types";
import { DIRECT_TOOLS } from "./admin";

export const DIRECT_COMMANDS = new Set(["help", "exit", "quit", "spending", "context-usage", "context-files", "context-debug", "condense", "switch-model", "planning"]);

export function directPrivateFile(path: string, privateFiles: readonly string[], platform: PlatformName): boolean {
  return privateFiles.some(file => {
    if (comparablePath(realTargetPath(path), platform) === comparablePath(realTargetPath(file), platform)) return true;
    try { const a = statSync(path), b = statSync(file); return a.ino !== 0 && a.ino === b.ino && a.dev === b.dev; } catch { return false; }
  });
}

export function directToolView(registry: ToolLookup, root: string, platform: PlatformName, privateFiles: readonly string[] = []): ToolLookup {
  const replacements = new Map<string, Tool<never>>();
  const refusal = (tool: Tool<never>, input: never, context: ToolContext): string | undefined => {
    const subject = tool.ruleSubject(input, context);
    if (subject.kind !== "paths") return undefined;
    if (subject.paths.some(path => directPrivateFile(path, privateFiles, platform))) return "Direct server credentials cannot be accessed by session tools.";
    return subject.paths.some(path => !insideAllowed(realTargetPath(path), [root], platform)) ? "The direct server forbids access outside its served root. Approval cannot widen this boundary." : undefined;
  };
  for (const tool of registry.list()) if (DIRECT_TOOLS.has(tool.name)) replacements.set(tool.name, {
    ...tool,
    validate: (input, context) => refusal(tool, input, context) ?? tool.validate?.(input, context),
    ...(tool.preview ? { preview: async (input: never, context: ToolContext) => {
      const problem = refusal(tool, input, context); return problem ? { refusal: textOutcome(problem, true, "permission_denied") } : tool.preview!(input, context);
    } } : {}),
    execute: async (input, context) => { const problem = refusal(tool, input, context); return problem ? textOutcome(problem, true, "permission_denied") : tool.execute(input, context); },
  });
  return restrictedView(registry, name => DIRECT_TOOLS.has(name), replacements);
}
