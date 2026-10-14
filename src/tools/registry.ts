// Implements: SPEC-OUT-001 (§ 5.3 registry construction, EF-02, EF-07, FA-03, RG-03, ERR-01, ERR-06, CA-01, CA-02, CA-04, CA-05),
//             SPEC-OUT-030 (§ 5.1 deferred tools, FA-02, FA-03, EF-01, CA-01, CA-03), SPEC-MCP-009 (EF-02, EF-05)

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
  /** Product-owned file stores preserve the same schemas and refusal precedence through bounded adapters. */
  readonly decorateBuiltin?: (tool: Tool<never>) => Tool<never>;
  /** `--toolset`: undefined = all ("default"); empty list = no tool. */
  readonly toolset?: readonly string[];
  /** Tools denied as a whole by a `deny` rule without pattern (§ 5.3 step 3). */
  readonly deniedWholeTools?: ReadonlySet<string>;
  readonly extraTools?: readonly ExtraTool[];
}

/** What the executor needs of a registry: the registry of the session, or a view of it (sub-agents). */
export interface ToolLookup {
  get(name: string): Tool<never> | undefined;
  list(): Tool<never>[];
  validateInput(tool: Tool<never>, input: unknown): string[];
}

/**
 * A view of a registry limited to the tools `allowed` accepts, with some tools replaced (SPEC-AGT-001 § 5.1, EF-01): a
 * tool outside the view does not exist for its user (SPEC-MOT-001 CA-09). It follows the registry, connectors included.
 */
export function restrictedView(base: ToolLookup, allowed: (name: string) => boolean, replaced: ReadonlyMap<string, Tool<never>> = new Map()): ToolLookup {
  return {
    get: (name) => (allowed(name) ? (replaced.get(name) ?? base.get(name)) : undefined),
    list: () => base.list().filter((t) => allowed(t.name)).map((t) => replaced.get(t.name) ?? t),
    validateInput: (tool, input) => base.validateInput(tool, input),
  };
}

export class ToolRegistry implements ToolLookup {
  readonly #tools: Map<string, Tool<never>>;
  readonly #validators = new Map<string, ReturnType<typeof compileRaw>>();
  /** Connector tools, which come and go during the session (SPEC-MCP-009), by qualified name. */
  readonly #dynamic = new Map<string, Tool<never>>();
  /** Deferred tools: announced by name; their definition is sent once loaded (SPEC-OUT-030). */
  readonly #deferred = new Set<string>();
  readonly #loaded = new Set<string>();
  #deniedWholeTools: ReadonlySet<string> = new Set();

  private constructor(tools: Map<string, Tool<never>>) {
    this.#tools = tools;
  }

  static build(env: ToolEnvironment, options: RegistryOptions = {}): ToolRegistry {
    const all = new Map<string, Tool<never>>();
    for (const original of BUILTIN_TOOLS) { const t = options.decorateBuiltin?.(original) ?? original; if (t.isEnabled(env)) all.set(t.name, t); }
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
    const registry = new ToolRegistry(selected);
    registry.#deniedWholeTools = options.deniedWholeTools ?? new Set();
    return registry;
  }

  /** Adds a tool known from the start (`discover_tools`), unless it is denied as a whole. */
  addStatic(tool: Tool<never>): void {
    if (!this.#deniedWholeTools.has(tool.name) && !this.#tools.has(tool.name)) this.#tools.set(tool.name, tool);
  }

  /**
   * Replaces the connector tools (SPEC-MCP-009 FA-02). A connector tool never hides a built-in one (EF-02); a tool
   * denied as a whole, or whose connector is (`cnx_<server>`), is left out. `deferred` names those announced by name only.
   */
  setDynamic(tools: readonly Tool<never>[], deferred: ReadonlySet<string>): void {
    this.#dynamic.clear();
    this.#deferred.clear();
    for (const t of tools) {
      if (this.#tools.has(t.name)) continue;
      if ([...this.#deniedWholeTools].some((d) => d === t.name || (d.startsWith("cnx_") && t.name.startsWith(`${d}_`)))) continue;
      this.#dynamic.set(t.name, t);
      if (deferred.has(t.name)) this.#deferred.add(t.name);
      this.#validators.delete(t.name);
    }
  }

  /** Step 4 of SPEC-OUT-030: loaded tools join the requests and stay for the session (EF-01). */
  load(names: readonly string[]): void {
    for (const n of names) if (this.#deferred.has(n)) this.#loaded.add(n);
  }

  /** Deferred tools, loaded or not. */
  deferredTools(): Tool<never>[] {
    return [...this.#deferred].sort().map((n) => this.#dynamic.get(n)!);
  }

  /** Names announced to the model: the deferred tools not loaded yet (CA-01, FA-03). */
  deferredNames(): string[] {
    return [...this.#deferred].filter((n) => !this.#loaded.has(n)).sort();
  }

  /** A deferred tool not loaded answers with the invitation to load it (FA-02, CA-03). */
  get(name: string): Tool<never> | undefined {
    const fixed = this.#tools.get(name);
    if (fixed) return fixed;
    const tool = this.#dynamic.get(name);
    if (!tool || !this.#deferred.has(name) || this.#loaded.has(name)) return tool;
    return {
      ...tool,
      inputSchema: { type: "object" },
      validate: () => `The tool ${name} is deferred and not loaded: load it first with discover_tools (query "select:${name}"), then call it again.`,
    };
  }

  /** Tools presented to the model, in a deterministic order (decision D-12): deferred tools only once loaded. */
  list(): Tool<never>[] {
    const dynamic = [...this.#dynamic.values()].filter((t) => !this.#deferred.has(t.name) || this.#loaded.has(t.name));
    return [...this.#tools.values(), ...dynamic].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Optional session capabilities may disappear after a model or setting change. */
  removeStatic(name: string): void { this.#tools.delete(name); this.#validators.delete(name); }

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
