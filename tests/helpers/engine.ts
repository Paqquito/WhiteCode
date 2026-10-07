// Engine test bench: a conversation, a registry with test tools, the simulated provider and a permission context.
import type { PermissionMode } from "../../src/config/settings-schema";
import { Conversation } from "../../src/engine/conversation";
import type { EngineEvent } from "../../src/engine/events";
import type { LoopDeps } from "../../src/engine/loop";
import { NEUTRAL_HOOKS, type HookBus } from "../../src/extension-points/hooks";
import type { Rule } from "../../src/permissions/rules";
import type { Authorities } from "../../src/permissions/resolver";
import { currentPlatform } from "../../src/platform/system";
import { ToolRegistry } from "../../src/tools/registry";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome } from "../../src/tools/types";
import { testModel, testToolFields, workspace, type Workspace } from "./env";
import { ScriptedProvider, type ScriptedResponse } from "./scripted-provider";

export const platform = currentPlatform();

export interface BenchOptions {
  readonly tools?: Tool<never>[];
  readonly mode?: PermissionMode | (() => PermissionMode);
  readonly rules?: Rule[];
  readonly authorities?: Authorities;
  readonly hooks?: HookBus;
  readonly model?: string;
  readonly deps?: Partial<LoopDeps>;
  readonly executor?: Partial<LoopDeps["executor"]>;
}

export function bench(script: ScriptedResponse[], options: BenchOptions = {}) {
  const ws: Workspace = workspace();
  const provider = new ScriptedProvider(script);
  const registry = ToolRegistry.build({ platform, home: ws.home }, { extraTools: (options.tools ?? []).map((tool) => ({ tool })) });
  const conversation = new Conversation([{ text: "system", cacheBoundary: true }], registry.list().map((t) => ({ name: t.name, description: "d", inputSchema: t.inputSchema })));
  const events: EngineEvent[] = [];
  const mode = options.mode ?? "unrestricted";
  const hooks = options.hooks ?? NEUTRAL_HOOKS;
  const deps: LoopDeps = {
    provider,
    model: testModel(options.model ?? "default"),
    conversation,
    hooks,
    maxOutputTokens: 1000,
    thinking: { enabled: false, mode: "adaptive", budgetTokens: 1000, showSummaries: false },
    maxOutputContinuations: 3,
    maxStopHookContinuations: 3,
    emit: (e) => events.push(e),
    ...options.deps,
    executor: {
      registry,
      hooks,
      authorities: options.authorities ?? {},
      concurrency: 4,
      toolTimeoutMs: 5000,
      permissionContext: () => ({ mode: typeof mode === "function" ? mode() : mode, rules: options.rules ?? [], sessionAllows: [], managedRulesOnly: false, cwd: ws.project, home: ws.home, platform }),
      toolContext: (signal): ToolContext => ({ platform, home: ws.home, cwd: ws.project, allowedDirectories: [ws.project], signal, ...testToolFields() }) as ToolContext,
      ...options.executor,
    },
  };
  const toolResults = () =>
    conversation.messages.flatMap((m) => (m.role === "user" ? m.parts.filter((p) => p.type === "tool_result") : [])) as unknown as Array<{ callId: string; isError: boolean; content: Array<{ type: string; text?: string }> }>;
  return { ws, provider, conversation, events, deps, toolResults };
}

/** Test tool: records its calls, runs `run` (default: an "ok" result). */
export function probe(
  name: string,
  options: { readOnly?: boolean; run?: (input: Record<string, unknown>, signal: AbortSignal) => Promise<ToolOutcome>; needsPermission?: boolean; calls?: unknown[] } = {},
): Tool<never> {
  const readOnly = options.readOnly ?? true;
  return {
    name,
    inputSchema: { type: "object", properties: {}, additionalProperties: true },
    description: () => name,
    flags: () => ({ readOnly, concurrencySafe: readOnly, destructive: false, requiresPermission: options.needsPermission ?? false, openWorld: false }),
    isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: options.needsPermission ? undefined : () => "allow",
    summary: () => name,
    async execute(input: Record<string, unknown>, ctx: ToolContext) {
      options.calls?.push(input);
      return options.run ? options.run(input, ctx.signal) : textOutcome("ok");
    },
  } as unknown as Tool<never>;
}
