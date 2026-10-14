// Implements: SPEC-EXT-021, SPEC-EXT-022, SPEC-EXT-026, SPEC-EXT-028, SPEC-EXT-029, SPEC-EXT-031, SPEC-EXT-032 (the skills
// built into the product: their definitions, their invocation and their tools)
// Supports: SPEC-EXT-019 (same header and same invocation as the other skills), gap E-117

import batch from "../../prompts/skills/batch.md" with { type: "text" };
import configGuide from "../../prompts/skills/config-guide.md" with { type: "text" };
import debug from "../../prompts/skills/debug.md" with { type: "text" };
import promoteMemory from "../../prompts/skills/promote-memory.md" with { type: "text" };
import simplify from "../../prompts/skills/simplify.md" with { type: "text" };
import skillFromSession from "../../prompts/skills/skill-from-session.md" with { type: "text" };
import verify from "../../prompts/skills/verify.md" with { type: "text" };
import loop from "../../prompts/skills/loop.md" with { type: "text" };
import shortcutHelp from "../../prompts/skills/shortcut-help.md" with { type: "text" };
import apiGuide from "../../prompts/skills/ai-api-guide.md" with { type: "text" };
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
import { splitHeader, type Invocation, type Skill } from "./registry";

const SOURCES = [batch, configGuide, debug, promoteMemory, simplify, skillFromSession, verify, shortcutHelp, apiGuide, ...(buildFlag("scheduled_triggers") ? [loop] : [])];

/** The skills of the product, scope `product`: a skill of the same name of any other scope replaces it. */
export function builtinSkills(): Skill[] {
  return SOURCES.map((text) => {
    const { header, body } = splitHeader(text);
    const h = header ?? {};
    const name = String(h["name"]);
    return {
      name,
      description: String(h["description"]),
      invocation: (h["invocation"] ?? "both") as Invocation,
      ...(typeof h["argumentsHelp"] === "string" ? { argumentsHelp: h["argumentsHelp"] } : {}),
      tools: Array.isArray(h["tools"]) ? (h["tools"] as string[]) : [],
      context: "inline",
      scope: "product",
      root: "",
      file: `product:${name}`,
      command: false,
      content: body,
    };
  });
}
