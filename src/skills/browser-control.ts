// Implements: SPEC-EXT-033 (reference required per caller before browser use; permissions remain authoritative).
import type { Skill } from "./registry";
import { textOutcome, type Tool, type ToolContext } from "../tools/types";
const REQUIRED = "Load the product browser-control reference with use_skill before using browser control in this context. A replaced reference cannot authorize browser control.";
export class BrowserControlReference {
  readonly #loaded = new Map<string, number>();
  constructor(readonly epoch: (agent: string | undefined) => number) {}
  activate(skill: Skill, agent?: string): void { if (skill.name === "browser-control" && skill.scope === "product" && skill.file === "product:browser-control") this.#loaded.set(agent ?? "main", this.epoch(agent)); }
  invalidate(): void { this.#loaded.clear(); }
  protect<I>(tool: Tool<I>): Tool<I> {
    const refusal = (context: ToolContext) => this.#loaded.get(context.agentName ?? "main") === this.epoch(context.agentName) ? undefined : REQUIRED;
    return { ...tool, description: environment => "Before the first call, load the browser-control reference with use_skill. " + tool.description(environment),
      validate: (input, context) => refusal(context) ?? tool.validate?.(input, context),
      execute: (input, context) => { const denied = refusal(context); return denied ? Promise.resolve(textOutcome(denied, true, "permission_denied")) : tool.execute(input, context); },
    };
  }
}
