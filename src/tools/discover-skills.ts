// Implements: SPEC-OUT-038 (local lexical selection and exclusion of known skills).
// Supports: SPEC-MOT-007, SPEC-EXT-019, gap E-161.
import { modelSkills, type Skill, type SkillSet } from "../skills/registry";
import { textOutcome, type Tool } from "./types";

const STOP = new Set(["the", "and", "for", "with", "from", "this", "that", "then", "before", "after", "your", "our", "are", "use", "les", "des", "une", "pour", "avec", "dans", "sur", "est", "avant", "apres"]);
const words = (text: string): Set<string> => new Set((text.normalize("NFKD").toLowerCase().replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(word => !STOP.has(word)));
/** Ranking uses metadata only; selecting never reads instructions or grants tools. */
export class SkillDiscovery {
  readonly #known = new Set<string>();
  constructor(readonly skills: () => SkillSet) {}
  markKnown(name: string): void { this.#known.add(name); }
  select(description: string, maxResults: number): Skill[] {
    const query = words(description.slice(0, 8192));
    const selected = modelSkills(this.skills()).filter(skill => !this.#known.has(skill.name)).map(skill => {
      const name = words(skill.name), details = words(skill.description);
      let score = 0;
      for (const word of query) { if (name.has(word)) score += 4; if (details.has(word)) score += 1; }
      return { skill, score };
    }).filter(row => row.score > 0).sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name)).slice(0, Math.max(1, Math.min(10, maxResults)));
    for (const row of selected) this.#known.add(row.skill.name);
    return selected.map(row => row.skill);
  }
}

export function createDiscoverSkillsTool(discovery: SkillDiscovery, remote?: (description: string, maximum: number, signal: AbortSignal) => Promise<Skill[]>): Tool<{ description: string; max_results?: number }> {
  return {
    name: "discover_skills",
    description: () => "Find local skills relevant to your next action before changing direction. Give a precise description. Skills already suggested or loaded are excluded. Discovery returns metadata and never grants permissions or loads instructions; invoke use_skill to load a selected skill.",
    inputSchema: { type: "object", properties: { description: { type: "string", minLength: 1, maxLength: 8192 }, max_results: { type: "integer", minimum: 1, maximum: 10 } }, required: ["description"], additionalProperties: false },
    flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: () => "Discover relevant local skills",
    async execute(input, ctx) {
      const skills = discovery.select(input.description, input.max_results ?? 5);
      if (remote && skills.length < (input.max_results ?? 5)) skills.push(...await remote(input.description, (input.max_results ?? 5) - skills.length, ctx.signal));
      return textOutcome(skills.length ? JSON.stringify(skills.map(skill => ({ name: skill.name, description: skill.description }))) : "No new relevant skills found.");
    },
  };
}
