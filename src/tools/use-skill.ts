// Implements: SPEC-EXT-020 (§ 5.3 steps 1, 2 and 4 for the model, EF-01, EF-04, ERR-01, CA-04)
// The model invokes a skill: its content comes back as the result, and its `tools` apply until the end of the turn.

import description from "../../prompts/tools/use_skill.md" with { type: "text" };
import { framed, loadSkill } from "../skills/invoke";
import type { Skill, SkillSet } from "../skills/registry";
import { textOutcome, type Tool } from "./types";

export interface UseSkillInput {
  readonly name: string;
  readonly arguments?: string;
}

export interface UseSkillDeps {
  readonly skills: () => SkillSet;
  readonly session: () => string;
  /** Applies the `tools` of the skill until the end of the turn (EF-02). */
  readonly activate: (skill: Skill) => void;
}

export function createUseSkillTool(deps: UseSkillDeps): Tool<UseSkillInput> {
  return {
    name: "use_skill",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, description: "Name of the skill, as listed in the system instructions." },
        arguments: { type: "string", description: "What the skill works on, when it expects arguments." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    description: () => description.trim(),
    flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: false }),
    isEnabled: () => true,
    // Rules `use_skill(<name>)` designate a skill (§ 5.3 step 1).
    ruleSubject: (input) => ({ kind: "name", name: input.name }),
    // Loading instructions needs no request; a `deny` or `ask` rule on the skill still applies first.
    permissionContribution: () => "allow",
    summary: (input) => `Use the skill ${input.name}${input.arguments ? ` (${input.arguments.slice(0, 80)})` : ""}`,

    async execute(input) {
      const loaded = loadSkill(deps.skills(), input.name, input.arguments ?? "", "model", { session: deps.session() });
      if (!loaded.ok) return textOutcome(loaded.message, true, loaded.kind === "forbidden" ? "permission_denied" : loaded.kind === "arguments" ? "invalid_input" : "unavailable");
      deps.activate(loaded.skill);
      return textOutcome(framed(loaded.skill, loaded.content, "use_skill"));
    },
  };
}
