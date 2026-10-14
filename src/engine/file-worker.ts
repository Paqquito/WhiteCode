// Supports: SPEC-CMD-005 (read-only fork, private loop guard), gap E-171.
// Supports: SPEC-AGT-010, SPEC-MOT-038, SPEC-MOT-040, gap E-163.
import { Conversation } from "../engine/conversation";
import { completeForkHistory } from "./forked-context";
import { runTurn, type LoopDeps } from "../engine/loop";
import { restrictedView } from "../tools/registry";
import type { Tool, ToolContext } from "../tools/types";
import type { ModelPricing, ResolvedModel } from "../providers/catalog";
import type { TurnResult } from "../engine/events";
import { RunLimits } from "../engine/limits";
import type { HookBus } from "../extension-points/hooks";
import { LoopGuard } from "./loop-guard";

/** A private fork can only invoke the supplied file tools, without touching the caller's history or terminal. */
export async function runFileWorker(o: { readonly parent: LoopDeps; readonly id: string; readonly directive: string; readonly model: ResolvedModel; readonly pricing?: ModelPricing; readonly owns: (path: string) => boolean; readonly signal: AbortSignal; readonly readOnly?: boolean; readonly context?: (ctx: ToolContext) => ToolContext; readonly afterWrite?: () => void; readonly readTool?: Tool<never>; readonly writeTool?: Tool<never>; readonly hooks?: HookBus }): Promise<TurnResult> {
  const replacements = new Map<string, Tool<never>>();
  for (const name of ["read_file", "write_file"]) {
    if (o.readOnly && name === "write_file") continue;
    const inherited = o.parent.executor.registry.get(name); if (!inherited) continue;
    const tool = name === "write_file" ? o.writeTool ?? inherited : o.readTool ?? inherited;
    replacements.set(name, { ...tool, validate: (input: never, ctx: ToolContext) => {
      const subject = tool.ruleSubject(input, ctx);
      if (subject.kind !== "paths" || !subject.paths.length || !subject.paths.every(o.owns)) return "This internal worker may access only its designated memory files.";
      return tool.validate?.(input, ctx);
    } });
  }
  const view = restrictedView(o.parent.executor.registry, name => replacements.has(name), replacements);
  const conversation = new Conversation(o.parent.conversation.system, o.parent.conversation.tools.filter(tool => replacements.has(tool.name)));
  const readState = new Map(o.parent.executor.toolContext(o.signal).readState);
  conversation.restore(completeForkHistory(o.parent.conversation.messages));
  const hooks = o.hooks ?? { promptSubmitted: async () => ({}), turnCompleted: async () => ({}), turnFailed: async () => {},
    beforeTool: (call: import("../providers/types").ToolCall) => o.parent.hooks.beforeTool(call),
    afterTool: (call: import("../providers/types").ToolCall, isError: boolean, output: string) => o.parent.hooks.afterTool(call, isError, output),
    approvalRefused: (call: import("../providers/types").ToolCall, reason: string) => o.parent.hooks.approvalRefused(call, reason),
    beforeCompaction: async () => ({}), afterCompaction: async () => {},
  };
  return runTurn({ ...o.parent, model: o.model, pricing: o.pricing, conversation, transcript: undefined, agentId: o.id, hooks, context: undefined, projectHistory: undefined, takeQueued: undefined, pendingNote: undefined, reminders: undefined, takeSubmittedResult: undefined, onUserMessage: undefined, fallback: undefined, limits: new RunLimits({ ledger: o.parent.limits?.ledger, maxIterations: 4 }), requestCounter: { count: 0 }, maxIterations: Math.min(o.parent.maxIterations ?? 4, 4), maxOutputTokens: Math.min(o.parent.maxOutputTokens, 4096),
    emit: event => { if (["usage", "warning", "permission", "retry"].includes(event.type)) o.parent.emit(event); },
    executor: { ...o.parent.executor, loopGuard: o.parent.executor.loopGuard ? new LoopGuard(o.parent.executor.loopGuard.threshold, o.parent.executor.loopGuard.enabled) : undefined, registry: view, hooks, toolContext: signal => { const context = { ...o.parent.executor.toolContext(signal), readState, agentName: o.id }; return o.context ? o.context(context) : context; } },
    afterToolResults: (calls, results) => { if (calls.some(call => call.name === "write_file" && results.some(result => result.callId === call.callId && !result.isError))) o.afterWrite?.(); },
  }, o.directive, o.signal);
}
