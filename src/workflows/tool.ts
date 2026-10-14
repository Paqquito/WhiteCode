// Implements: SPEC-OUT-042 (validated approval plan, background launch and cancellation).
// Supports: SPEC-PLA-003, SPEC-CMD-077, gap E-165.
import type { Workflow } from "./definitions";
import { workflowInputs, workflowPlan } from "./definitions";
import { WorkflowRunner, type WorkflowResult } from "./runtime";
import type { Tool, ToolContext } from "../tools/types";
import { textOutcome } from "../tools/types";
import type { BackgroundTasks } from "../engine/background";
export interface WorkflowInput { readonly workflow: string; readonly inputs?: Readonly<Record<string, unknown>> }
export function createRunWorkflowTool(options: { readonly catalog: () => ReadonlyMap<string, Workflow>; readonly runner: WorkflowRunner; readonly depth: number; readonly maxDepth: number; readonly remainingMs?: () => number | undefined; readonly execute: (step: Workflow["steps"][number], task: string, signal: AbortSignal, background: BackgroundTasks) => Promise<WorkflowResult>; readonly redact: (text: string) => string }): Tool<WorkflowInput> {
  const prepared = new WeakMap<WorkflowInput, { definition: Workflow; inputs: Record<string, unknown> }>();
  const prepare = (input: WorkflowInput) => {
    const known = prepared.get(input); if (known) return known;
    const definition = options.catalog().get(input.workflow); if (!definition) throw new Error("Unknown or invalid workflow.");
    const inputs = workflowInputs(definition, input.inputs), plan = { definition: structuredClone(definition), inputs: structuredClone(inputs) }; prepared.set(input, plan); return plan;
  };
  return {
    name: "run_workflow", inputSchema: { type: "object", properties: { workflow: { type: "string", minLength: 1, maxLength: 48 }, inputs: { type: "object", maxProperties: 32 } }, required: ["workflow"], additionalProperties: false },
    description: () => "Run a named, validated workflow in the background after approval of its execution plan. Each step keeps the caller's ordinary permissions and budget. Use background_output and background_stop with the returned task id. Available workflows:\n" + options.redact([...options.catalog().values()].map(def => `${def.name}: ${def.description}; parameters: ${Object.entries(def.parameters ?? {}).map(([name, parameter]) => `${name} (${parameter.type}${parameter.required ? ", required" : ""})`).join(", ")}`).join("\n")).slice(0, 16000),
    flags: () => ({ readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: false, explicitApproval: true }),
    isEnabled: () => options.depth < options.maxDepth,
    validate: input => { if (options.depth >= options.maxDepth) return "Workflow nesting exceeds agents.maxDepth."; try { prepare(input); return undefined; } catch (error) { return (error as Error).message; } },
    ruleSubject: input => ({ kind: "name", name: input.workflow }),
    summary: input => { try { return `Flux ${input.workflow} — ${prepare(input).definition.steps.length} étapes`; } catch { return `Flux ${input.workflow}`; } },
    preview: async input => { try { const { definition, inputs } = prepare(input); return { diff: options.redact(workflowPlan(definition, options.runner.limit) + `\nParamètres : ${JSON.stringify(inputs)}`) }; } catch (error) { return { refusal: textOutcome((error as Error).message, true, "invalid_input") }; } },
    async execute(input, ctx: ToolContext) {
      if (!ctx.background) return textOutcome("Background tasks are unavailable.", true, "unavailable"); ctx.signal.throwIfAborted();
      const remaining = options.remainingMs?.();
      if (remaining !== undefined && remaining <= 0) return textOutcome("The run duration limit has been reached.", true, "unavailable");
      const { definition, inputs } = prepare(input);
      const task = ctx.background.start("workflow", definition.name, async (signal, write) => {
        // start() calls work before assigning the task variable; defer its first activity update.
        await Promise.resolve();
        const lifetime = new AbortController(), deadline = remaining === undefined ? undefined : AbortSignal.timeout(Math.max(1, Math.floor(remaining)));
        const combined = AbortSignal.any([signal, lifetime.signal, ...(deadline ? [deadline] : [])]), scope = ctx.background!.scope(combined);
        try {
          const result = await options.runner.run(definition, inputs, combined, (step, prompt, childSignal) => options.execute(step, prompt, childSignal, scope.tasks), activity => ctx.background!.updateActivity(task.id, activity), text => write(options.redact(text)));
          return { status: deadline?.aborted ? "timed_out" : signal.aborted ? "stopped" : result.isError ? "failed" : "completed", summary: options.redact(result.text).slice(0, 16000) };
        } finally { lifetime.abort(); await scope.close(); }
      });
      return textOutcome(`Workflow started as task ${task.id}. Its aggregate report will reach you as a notification. Use background_output or background_stop with task_id ${task.id}.`);
    },
  };
}
