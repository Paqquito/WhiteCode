// Implements: SPEC-OUT-030 (§ 5.3 query forms, § 5.4 steps 1 to 4, FA-01, EF-03, EF-04, ERR-01, CA-02)
// Loads the definition of deferred tools: exact selection, keywords, or a required term in the name.

import description from "../../prompts/tools/discover_tools.md" with { type: "text" };
import { textOutcome, type Tool } from "./types";

export interface DiscoverToolsInput {
  readonly query: string;
  readonly max_results?: number;
}

/** What `discover_tools` needs from the registry. */
export interface DeferredCatalog {
  /** Deferred tools, loaded or not: name, description and input schema. */
  deferred(): ReadonlyArray<{ readonly name: string; readonly description: string; readonly inputSchema: Record<string, unknown> }>;
  /** Marks the tools loaded: they join the next requests (step 4). */
  load(names: readonly string[]): void;
}

const words = (text: string) => text.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);

/** Score of a tool for keywords: a word in the name weighs more than in the description; deterministic (EF-03). */
function score(tool: { name: string; description: string }, keywords: readonly string[]): number {
  const name = tool.name.toLowerCase();
  const nameParts = new Set(words(tool.name));
  const desc = new Set(words(tool.description));
  let s = 0;
  for (const k of keywords) {
    if (nameParts.has(k)) s += 5;
    else if (name.includes(k)) s += 3;
    if (desc.has(k)) s += 1;
  }
  return s;
}

/** Steps 1 and 2: the tools the query designates, and the names of `select:` that exist nowhere (ERR-01). */
export function searchDeferred(
  tools: ReadonlyArray<{ readonly name: string; readonly description: string }>,
  query: string,
  max: number,
): { readonly names: string[]; readonly unknown: string[] } {
  const q = query.trim();
  if (q.toLowerCase().startsWith("select:")) {
    const wanted = q.slice(7).split(",").map((n) => n.trim()).filter((n) => n !== "");
    const known = new Set(tools.map((t) => t.name));
    return { names: wanted.filter((n) => known.has(n)), unknown: wanted.filter((n) => !known.has(n)) };
  }
  let candidates = [...tools];
  let rest = q;
  const required = /^\+(\S+)\s*(.*)$/.exec(q);
  if (required) {
    const term = required[1]!.toLowerCase();
    candidates = candidates.filter((t) => t.name.toLowerCase().includes(term));
    rest = required[2] ?? "";
  }
  const keywords = words(rest);
  const ranked = candidates
    .map((t) => ({ t, s: keywords.length === 0 ? 1 : score(t, keywords) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.t.name < b.t.name ? -1 : 1));
  return { names: ranked.slice(0, max).map((x) => x.t.name), unknown: [] };
}

export function createDiscoverToolsTool(catalog: DeferredCatalog): Tool<DiscoverToolsInput> {
  return {
    name: "discover_tools",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "select:<name>[,<name>…], keywords, or +<word in the name> keywords." },
        max_results: { type: "integer", minimum: 1, maximum: 20, description: "Most results for a keyword search (default 5)." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    description: () => description.trim(),
    // EF-04: read-only and safe in parallel; it changes nothing outside the session.
    flags: () => ({ readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: () => true,
    validate: (input) => (input.query.trim() === "" ? "The query is empty." : undefined),
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: (input) => `Discover tools: ${input.query}`,

    async execute(input) {
      const tools = catalog.deferred();
      const found = searchDeferred(tools, input.query, input.max_results ?? 5);
      const notes = found.unknown.map((n) => `Unknown tool: ${n}.`);
      if (found.names.length === 0) return textOutcome([...notes, "No deferred tool matches this query. Rephrase it with other words."].join("\n")); // FA-01
      catalog.load(found.names);
      const byName = new Map(tools.map((t) => [t.name, t]));
      const blocks = found.names.map((n) => {
        const t = byName.get(n)!;
        return `<tool name="${t.name}">\n${t.description}\nInput schema: ${JSON.stringify(t.inputSchema)}\n</tool>`;
      });
      return textOutcome([...notes, `Loaded ${found.names.length} tool(s); you can call them now.`, "<tool_definitions>", ...blocks, "</tool_definitions>"].join("\n"));
    },
  };
}
