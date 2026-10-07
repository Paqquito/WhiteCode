// Implements: SPEC-OUT-001 (§ 5.3 registry construction, EF-02, EF-07, FA-03, RG-03, ERR-01, ERR-06, CA-01, CA-02, CA-04, CA-05)

import { compileRaw, describeErrors } from "../shared/schema";
import { editFileTool } from "./edit-file";
import { findFilesTool } from "./find-files";
import { readFileTool } from "./read-file";
import { runPowerShellTool, runShellTool } from "./run-shell";
import { searchContentTool } from "./search-content";
import type { Tool, ToolEnvironment } from "./types";
import { updateNotebookCellTool } from "./update-notebook-cell";
import { updateTodoListTool } from "./update-todo-list";
import { writeFileTool } from "./write-file";

/** Built-in tools delivered in this version. */
export const BUILTIN_TOOLS: readonly Tool<never>[] = [
  readFileTool as Tool<never>,
  writeFileTool as Tool<never>,
  editFileTool as Tool<never>,
  updateNotebookCellTool as Tool<never>,
  findFilesTool as Tool<never>,
  searchContentTool as Tool<never>,
  runShellTool as Tool<never>,
  runPowerShellTool as Tool<never>,
  updateTodoListTool as Tool<never>,
];

/** Tool from another source (connector); `connector` is the name that qualifies it on a conflict (FA-03). */
export interface ExtraTool {
  readonly tool: Tool<never>;
  readonly connector?: string;
}

export class UnknownToolsetEntryError extends Error {}

export interface RegistryOptions {
  /** `--toolset`: undefined = all ("default"); empty list = no tool. */
  readonly toolset?: readonly string[];
  /** Tools denied as a whole by a `deny` rule without pattern (§ 5.3 step 3). */
  readonly deniedWholeTools?: ReadonlySet<string>;
  readonly extraTools?: readonly ExtraTool[];
}

export class ToolRegistry {
  readonly #tools: Map<string, Tool<never>>;
  readonly #validators = new Map<string, ReturnType<typeof compileRaw>>();

  private constructor(tools: Map<string, Tool<never>>) {
    this.#tools = tools;
  }

  static build(env: ToolEnvironment, options: RegistryOptions = {}): ToolRegistry {
    const all = new Map<string, Tool<never>>();
    for (const t of BUILTIN_TOOLS) if (t.isEnabled(env)) all.set(t.name, t);
    for (const { tool, connector } of options.extraTools ?? []) {
      if (!tool.isEnabled(env)) continue;
      // FA-03: a connector tool never hides a built-in one; it takes the qualified name `cnx_<connector>_<tool>`.
      if (!all.has(tool.name)) all.set(tool.name, tool);
      else if (connector !== undefined) {
        const qualified = `cnx_${connector}_${tool.name}`;
        if (!all.has(qualified)) all.set(qualified, { ...tool, name: qualified });
      }
    }
    let selected = all;
    const toolset = options.toolset;
    if (toolset !== undefined && !(toolset.length === 1 && toolset[0] === "default")) {
      selected = new Map();
      for (const name of toolset) {
        const tool = all.get(name);
        if (!tool) throw new UnknownToolsetEntryError(`Outil inconnu : ${name}.`);
        selected.set(name, tool);
      }
    }
    for (const denied of options.deniedWholeTools ?? []) selected.delete(denied);
    return new ToolRegistry(selected);
  }

  get(name: string): Tool<never> | undefined {
    return this.#tools.get(name);
  }

  /** Tools presented to the model, in a deterministic order (decision D-12). */
  list(): Tool<never>[] {
    return [...this.#tools.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Schema validation before any execution (EF-02): the list of deviations, or an empty list. */
  validateInput(tool: Tool<never>, input: unknown): string[] {
    let v = this.#validators.get(tool.name);
    if (!v) {
      v = compileRaw(tool.inputSchema);
      this.#validators.set(tool.name, v);
    }
    return v(input) ? [] : describeErrors(v.errors, "en");
  }
}
