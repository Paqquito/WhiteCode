// Implements: SPEC-AGT-005 (§ 5.1 fields, § 5.3 steps 1 to 3, EF-01 to EF-04, RG-01, CA-01, CA-02), SPEC-AGT-002 (§ 5.1, EF-01, EF-02, CA-02, agents.disabledBuiltIns)
// The agents a session can launch: the built-in ones, then those of the user, of the project and of the organisation,
// the most specific source winning a name. Definitions are read again at each launch, so that a change is used at the
// next one (EF-04, CA-02).
// Supports: SPEC-EXT-011 (CA-03: individually validated extension agents), gap E-132.
// Implements: SPEC-AGT-003 (CA-01, EF-01, RG-01), SPEC-AGT-004 (CA-01, EF-02/03), gap E-148.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PERMISSION_MODES, type PermissionMode } from "../config/settings-schema";
import { splitHeader } from "../skills/registry";
import generalInstructions from "../../prompts/agents/general.md" with { type: "text" };
import usageGuideInstructions from "../../prompts/agents/usage-guide.md" with { type: "text" };
import footerLineInstructions from "../../prompts/agents/footer-line-setup.md" with { type: "text" };
import explorerInstructions from "../../prompts/agents/explorer.md" with { type: "text" };
import plannerInstructions from "../../prompts/agents/planner.md" with { type: "text" };
import verifierInstructions from "../../prompts/agents/verifier.md" with { type: "text" };
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
import { buildSnapshot } from "../hooks/config";
// Supports: SPEC-HOK-008 (header validation and contextual hook data).

export type AgentSource = "built-in" | "user" | "project" | "managed" | "extension";

export interface AgentDefinition {
  readonly hooks?: unknown;
  readonly memory?: "user" | "project" | "local";
  readonly name: string;
  readonly description: string;
  readonly source: AgentSource;
  readonly file?: string;
  /** Instructions of the agent (the body of its file). */
  readonly instructions: string;
  /** Allowed tools; absent: those of the caller. */
  readonly tools?: readonly string[];
  readonly excludedTools: readonly string[];
  /** Model alias, or `inherit`. */
  readonly model?: string;
  readonly approvalMode?: PermissionMode;
  readonly maxIterations?: number;
  readonly startupInstruction?: string;
  readonly color?: string;
  readonly detached: boolean;
  /** Hosts its web reading is limited to (SPEC-AGT-002 EF-03: the official documentation only). */
  readonly webHosts?: readonly string[];
}

/** Fields of § 5.1; those this version does not use yet are accepted without effect (gap E-105). */
const KNOWN_FIELDS = new Set(["name", "description", "tools", "excludedTools", "model", "reasoningLevel", "approvalMode", "maxIterations", "color", "memory", "skills", "hooks", "connectors", "startupInstruction", "detached", "isolatedCopy"]);
const NAME = /^[a-z][a-z0-9-]*$/;
/** Tools that only read: the agents of a planning caller keep only these (SPEC-OUT-016 EF-06). */
export const READING_TOOLS: ReadonlySet<string> = new Set(["read_file", "find_files", "search_content", "discover_tools", "use_skill", "update_todo_list", "spawn_agent"]);

export const BUILT_IN_AGENTS: readonly AgentDefinition[] = [
  ...(buildFlag("agent_explorer_planner") ? [
    { name: "explorer", description: "Locates code and answers repository questions with paths and excerpts at the requested search depth.", source: "built-in" as const, instructions: explorerInstructions.trim(), tools: ["read_file", "find_files", "search_content"], excludedTools: [], model: "small", detached: false },
    { name: "planner", description: "Designs an implementation plan with critical files, tradeoffs, risks and verification steps.", source: "built-in" as const, instructions: plannerInstructions.trim(), tools: ["read_file", "find_files", "search_content"], excludedTools: [], model: "inherit", detached: false },
  ] : []),
  ...(buildFlag("agent_verifier") ? [
    { name: "verifier", description: "Exercises changed behavior and reports verified, failed or not verifiable results with observed evidence.", source: "built-in" as const, instructions: verifierInstructions.trim(), tools: ["read_file", "find_files", "search_content", "run_shell", "run_powershell"], excludedTools: [], detached: false },
  ] : []),
  {
    name: "general",
    description: "General-purpose agent for research, broad exploration and multi-step tasks; returns a concise report.",
    source: "built-in",
    instructions: generalInstructions.trim(),
    excludedTools: [],
    detached: false,
  },
  {
    name: "usage-guide",
    description: "Answers questions about the features, configuration, hooks, connectors and integration kit of this product.",
    source: "built-in",
    instructions: usageGuideInstructions.trim(),
    tools: ["read_file", "find_files", "search_content", "fetch_url"],
    excludedTools: [],
    webHosts: ["$SERVICE_DOCS"],
    model: "small",
    detached: false,
  },
  {
    name: "footer-line-setup",
    description: "Creates or adapts the command of the status line in the user settings.",
    source: "built-in",
    instructions: footerLineInstructions.trim(),
    tools: ["read_file", "find_files", "search_content", "edit_file", "write_file"],
    excludedTools: [],
    model: "medium",
    detached: false,
  },
];

export interface AgentLocation {
  readonly source: Exclude<AgentSource, "built-in">;
  readonly dir: string;
}

const list = (v: unknown): string[] | undefined | null => {
  if (v === undefined) return undefined;
  if (typeof v === "string") return v.split(",").map((s) => s.trim()).filter(Boolean);
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return v as string[];
  return null;
};

/** One definition file; `string`: why it is set aside (EF-01). */
export function parseAgent(text: string, file: string, source: AgentLocation["source"], warn: (message: string) => void): AgentDefinition | string {
  const { header, body, invalid } = splitHeader(text);
  if (!header) return `en-tête absent ou invalide${invalid ? ` (${invalid})` : ""}`;
  const name = header["name"];
  if (typeof name !== "string" || !NAME.test(name)) return "nom absent ou invalide (minuscules, chiffres et tirets)";
  const description = header["description"];
  if (typeof description !== "string" || description.trim() === "") return "description absente";
  for (const k of Object.keys(header)) if (!KNOWN_FIELDS.has(k)) warn(`agent ${name} (${file}) : champ inconnu ${k} ignoré.`); // EF-02
  const tools = list(header["tools"]);
  const excluded = list(header["excludedTools"]);
  if (tools === null || excluded === null) return "tools et excludedTools : liste de noms attendue";
  const mode = header["approvalMode"];
  if (mode !== undefined && !(PERMISSION_MODES as readonly string[]).includes(String(mode))) return `mode de permission inconnu : ${String(mode)}`;
  const iterations = header["maxIterations"];
  if (iterations !== undefined && (!Number.isInteger(iterations) || (iterations as number) < 1)) return "maxIterations : entier positif attendu";
  const model = header["model"];
  const memory = header["memory"];
  if(memory!==undefined&&!["user","project","local"].includes(String(memory)))return "memory : portée user, project ou local attendue";
  if (header["hooks"] !== undefined) {
    const snapshot = buildSnapshot([{ origin: source, value: header["hooks"], file, labelScope: `agent:${name}` }], { noHooks: false, managedOnly: false, maxTimeoutMs: 600000 });
    for (const warning of [...snapshot.warnings, ...snapshot.ignored.map(i => `${i.label} : ${i.reason}.`)]) warn(warning);
  }
  return {
    name,
    description: description.trim(),
    source,
    file,
    instructions: body.trim(),
    ...(memory!==undefined?{memory:memory as "user"|"project"|"local"}:{}),
    ...(tools ? { tools } : {}),
    excludedTools: excluded ?? [],
    ...(typeof model === "string" && model.trim() !== "" ? { model: model.trim() } : {}),
    ...(mode !== undefined ? { approvalMode: mode as PermissionMode } : {}),
    ...(iterations !== undefined ? { maxIterations: iterations as number } : {}),
    ...(typeof header["startupInstruction"] === "string" ? { startupInstruction: header["startupInstruction"] } : {}),
    ...(typeof header["color"] === "string" ? { color: header["color"] } : {}),
    detached: header["detached"] === true,
    hooks: header["hooks"],
  };
}

/**
 * § 5.3: built-in agents, then the user, the project and the organisation (the order of `locations`); a name is held by
 * the most specific source. A built-in agent replaced is announced (SPEC-AGT-002 EF-02, CA-02).
 */
export function loadAgents(locations: readonly AgentLocation[], disabledBuiltIns: readonly string[], warn: (message: string) => void): Map<string, AgentDefinition> {
  const out = new Map<string, AgentDefinition>();
  for (const a of BUILT_IN_AGENTS) if (!disabledBuiltIns.includes(a.name)) out.set(a.name, a);
  for (const loc of locations) {
    let files: string[];
    try {
      files = readdirSync(loc.dir).filter((f) => f.endsWith(".md")).sort();
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(loc.dir, f);
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      const def = parseAgent(text, path, loc.source, warn);
      if (typeof def === "string") {
        warn(`agent ignoré (${path}) : ${def}.`);
        continue;
      }
      const previous = out.get(def.name);
      if (previous?.source === "built-in") warn(`l'agent ${def.name} (${loc.source}) remplace l'agent intégré du même nom.`);
      out.set(def.name, def);
    }
  }
  return out;
}
