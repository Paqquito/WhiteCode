// Implements: SPEC-MOT-045 (§ 5.1 clauses, variants, family adaptation, EF-01, EF-03, EF-06, ERR-01, RG-01)
// Supports: decision D-06 and gap E-014 (texts not evaluated yet), gap E-001 (texts written from scratch)

import contractV4 from "../../prompts/contract/v4/contract.md" with { type: "text" };
import contractFallback from "../../prompts/contract/fallback/contract.md" with { type: "text" };

/** v4: exact project checks after the final change, explicit remaining work (gap E-247). */
export const CONTRACT_VERSION = "v4";

export type Variant = "main" | "subagent" | "minimal";

const RULES = ["C-01", "C-02", "C-03", "C-04", "C-05", "C-06"];
const METHOD = ["C-10", "C-11", "C-12", "C-13", "C-14", "C-15", "C-16", "C-17"];
const TOOLS = ["C-20", "C-21", "C-22", "C-23", "C-24", "C-25", "C-30", "C-31", "C-32"];

/** Clauses retained by each variant (SPEC-MOT-045 § 5.1, "Variantes"). */
export const VARIANT_CLAUSES: Readonly<Record<Variant, readonly string[]>> = {
  main: [...RULES, ...METHOD, ...TOOLS],
  subagent: [...RULES, "C-10", "C-12", "C-13", "C-14", "C-17", "C-20", "C-21", "C-22", "C-23", "C-24", "C-25"],
  minimal: [...RULES, "C-17", "C-20", "C-21", "C-22"],
};

/** Clauses reformulated when nobody can answer (non-interactive runs, including their sub-agents). */
export const NON_INTERACTIVE_CLAUSES: readonly string[] = ["C-02", "C-03", "C-14", "C-24"];

export interface ContractText {
  readonly clauses: ReadonlyMap<string, string>;
  readonly nonInteractive: ReadonlyMap<string, string>;
}

export function parseContract(markdown: string): ContractText {
  const clauses = new Map<string, string>();
  const nonInteractive = new Map<string, string>();
  const body = markdown.replace(/<!--[\s\S]*?-->/g, "");
  for (const chunk of body.split(/^## /m).slice(1)) {
    const newline = chunk.indexOf("\n");
    const heading = chunk.slice(0, newline).trim();
    const text = chunk.slice(newline + 1).trim();
    const m = /^([A-Z0-9-]+)(?:\s+\[non-interactive\])?$/.exec(heading);
    if (!m) continue;
    if (heading.endsWith("[non-interactive]")) nonInteractive.set(m[1]!, text);
    else clauses.set(m[1]!, text);
  }
  return { clauses, nonInteractive };
}

export interface ContractSections {
  readonly rules: string;
  readonly method: string;
  readonly tools: string;
  readonly covered: readonly string[];
}

export class ContractCoverageError extends Error {}

/** Assembles sections 2, 3 and 4 for a variant; fails when a clause of the variant is missing (EF-01). */
export function assembleContract(contract: ContractText, variant: Variant, nonInteractive: boolean, replaceConcision = false): ContractSections {
  const wanted = VARIANT_CLAUSES[variant];
  const text = (id: string) => {
    const t = (nonInteractive && NON_INTERACTIVE_CLAUSES.includes(id) ? contract.nonInteractive.get(id) : undefined) ?? contract.clauses.get(id);
    if (t === undefined) throw new ContractCoverageError(`Clause ${id} missing from the behavior contract text.`);
    if (nonInteractive && NON_INTERACTIVE_CLAUSES.includes(id) && !contract.nonInteractive.has(id)) {
      throw new ContractCoverageError(`Non-interactive form of ${id} missing from the behavior contract text.`);
    }
    return id === "C-30" && replaceConcision ? "Follow the selected output style for presentation. When an action is needed, act during this response rather than merely announcing future work." : t;
  };
  const section = (title: string, ids: readonly string[]) => {
    const kept = ids.filter((id) => wanted.includes(id));
    return `# ${title}\n\n${kept.map((id) => `- ${text(id)}`).join("\n")}`;
  };
  let tools = section("Using tools and communicating", TOOLS);
  if (variant === "subagent") {
    const report = contract.clauses.get("SUBAGENT-REPORT");
    if (report === undefined) throw new ContractCoverageError("Sub-agent report instruction missing.");
    tools += `\n- ${report}`;
  }
  return {
    rules: section("Rules of conduct", RULES),
    method: section("Working method", METHOD),
    tools,
    covered: [...wanted],
  };
}

export const CURRENT_CONTRACT = (): ContractText => parseContract(contractV4);
export const FALLBACK_CONTRACT = (): ContractText => parseContract(contractFallback);

/** Family layer to use (§ 5.1 "Adaptation par famille"): only the generic layer exists in v0. */
export function selectFamily(setting: string, modelFamily: string, knownLayers: readonly string[] = ["generic"]): { family: string; warning?: string } {
  if (setting === "auto") return { family: knownLayers.includes(modelFamily) ? modelFamily : "generic" };
  if (setting === "generic" || knownLayers.includes(setting)) return { family: setting };
  return { family: "generic", warning: "Famille d'instructions inconnue : variante générique utilisée." };
}
