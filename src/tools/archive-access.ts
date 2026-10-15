// Supports: SPEC-SES-001 (§ 5.7 opaque store references), SPEC-MCP-020, SPEC-MOT-036/040, gap E-181.
import type { Tool } from "./types";
import {
  encryptedStore,
  resolveStoreReference,
} from "../session/private-storage";
import { privateContext } from "../session/private-context";
/** Translate before validation, permissions and previews so ordinary rules still see the actual logical path. */
export function archiveAccessTool(tool: Tool<never>): Tool<never> {
  if (
    !privateContext.getStore() ||
    ![
      "read_file",
      "write_file",
      "edit_file",
      "search_content",
      "find_files",
    ].includes(tool.name)
  )
    return tool;
  const resolved = new WeakSet<object>();
  const translated = (input: never): never => {
    const row = input as Record<string, unknown>;
    if (typeof row["path"] !== "string" || !row["path"].startsWith("archive"))
      return input;
    const path = resolveStoreReference(row["path"]);
    if (!path) return input;
    const value = { ...row, path };
    resolved.add(value);
    return value as never;
  };
  return {
    ...tool,
    validate(input, ctx) {
      const row = input as { path?: unknown },
        mapped = translated(input);
      if (
        typeof row.path === "string" &&
        ((row.path.startsWith("archive") && mapped === input) ||
          (!row.path.startsWith("archive") &&
            encryptedStore(row.path) &&
            !resolved.has(row)))
      )
        return "Use the designated opaque archive reference; raw store paths are not accessible.";
      return tool.validate?.(mapped, ctx);
    },
    flags: (input) => tool.flags(translated(input)),
    ruleSubject: (input, ctx) => tool.ruleSubject(translated(input), ctx),
    permissionContribution: tool.permissionContribution
      ? (input, ctx) => tool.permissionContribution!(translated(input), ctx)
      : undefined,
    preview: tool.preview
      ? (input, ctx) => tool.preview!(translated(input), ctx)
      : undefined,
    summary: (input) => tool.summary(translated(input)),
    execute: (input, ctx) => tool.execute(translated(input), ctx),
  };
}
