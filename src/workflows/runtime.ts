// Implements: SPEC-PLA-003 (CA-01/02, dependencies and bounded execution), SPEC-OUT-042 (CA-01/02).
// Supports: SPEC-AGT-023, gap E-165.
import type { Workflow, WorkflowStep } from "./definitions";
import { workflowTemplate } from "./definitions";
export interface WorkflowResult { readonly text: string; readonly isError: boolean }
type State = "pending" | "running" | "succeeded" | "failed" | "skipped";
export class WorkflowRunner {
  #running = 0;
  readonly #waiters: Array<() => void> = [];
  constructor(readonly limit: number) {}
  async #enter(signal: AbortSignal): Promise<() => void> {
    while (this.#running >= this.limit) { await new Promise<void>(resolve => { const wake = () => { signal.removeEventListener("abort", wake); const index = this.#waiters.indexOf(wake); if (index >= 0) this.#waiters.splice(index, 1); resolve(); }; this.#waiters.push(wake); signal.addEventListener("abort", wake, { once: true }); if (signal.aborted) wake(); }); signal.throwIfAborted(); }
    signal.throwIfAborted(); this.#running++;
    return () => { this.#running--; this.#waiters.shift()?.(); };
  }
  async run(definition: Workflow, inputs: Readonly<Record<string, unknown>>, parentSignal: AbortSignal, execute: (step: WorkflowStep, task: string, signal: AbortSignal) => Promise<WorkflowResult>, progress: (state: string) => void, write: (text: string) => void): Promise<WorkflowResult> {
    const controller = new AbortController(), signal = AbortSignal.any([parentSignal, controller.signal]), states = new Map(definition.steps.map(step => [step.id, "pending" as State])), outputs = new Map<string, string>(), active = new Set<Promise<void>>();
    let failed = false;
    const local = new WorkflowRunner(Math.min(definition.maxParallel ?? 4, this.limit));
    const resolve = (reference: string, item?: unknown): unknown => { if (reference === "item") return item; const [scope, key] = reference.split("."); if (scope === "inputs") return inputs[key!]; const output = outputs.get(key!); if (output === undefined) throw new Error(`Unavailable workflow output: ${key}.`); return output; };
    const fill = (text: string, item?: unknown) => workflowTemplate(text).replace(/\{%([^%]+)%\}/g, (_, reference: string) => { const value = resolve(reference, item); if (value === undefined) throw new Error(`Unavailable workflow parameter: ${reference}.`); return typeof value === "string" ? value : JSON.stringify(value); });
    const condition = (step: WorkflowStep): boolean => { if (step.when === undefined) return true; if (typeof step.when === "boolean") return step.when; const negative = step.when.startsWith("!"), reference = step.when.replace(/^!/, ""), value = reference.startsWith("steps.") ? states.get(reference.split(".")[1]!) === "succeeded" : resolve(reference); if (typeof value !== "boolean") throw new Error(`Workflow condition must be boolean: ${reference}.`); return negative ? !value : value; };
    const update = (id: string, state: State) => { states.set(id, state); const label = [...states].map(([id, state]) => `${id}: ${state}`).join(" · "); progress(label); write(`${id}: ${state}\n`); };
    const runStep = async (step: WorkflowStep) => {
      update(step.id, "running");
      try {
        if (!condition(step)) { outputs.set(step.id, "[Skipped by condition]"); update(step.id, "skipped"); return; }
        const rawItems = step.forEach ? resolve(step.forEach) : [undefined], items: unknown = step.forEach && typeof rawItems === "string" ? JSON.parse(rawItems) : rawItems;
        if (!Array.isArray(items) || items.length > 32 || items.some(item => item !== undefined && !["string", "number", "boolean"].includes(typeof item))) throw new Error("Workflow forEach requires up to 32 scalar items.");
        const jobs = items.map(async item => {
          const releaseLocal = await local.#enter(signal); let release: (() => void) | undefined;
          try {
            release = await this.#enter(signal); const result = await execute(step, fill(step.prompt ?? step.command!, item), signal);
            signal.throwIfAborted();
            if (result.isError) { if (step.onError !== "continue") controller.abort("workflow step failed"); throw new Error(result.text); }
            return result.text.slice(0, 40000);
          } catch (error) { if (step.onError !== "continue") controller.abort("workflow step failed"); throw error;
          } finally { release?.(); releaseLocal(); }
        });
        const completed = await Promise.allSettled(jobs), results = completed.map(result => result.status === "fulfilled" ? result.value : String((result.reason as Error)?.message ?? result.reason).slice(0, 40000));
        outputs.set(step.id, step.forEach ? JSON.stringify(results) : results[0] ?? "[]");
        if (completed.some(result => result.status === "rejected")) { failed = true; update(step.id, "failed"); if (step.onError !== "continue") controller.abort("workflow step failed"); } else update(step.id, "succeeded");
      } catch (error) {
        failed = true; outputs.set(step.id, String((error as Error).message).slice(0, 40000));
        if (step.onError !== "continue") controller.abort("workflow step failed");
        update(step.id, "failed");
      }
    };
    try {
      while (([...states.values()].includes("pending") || active.size > 0) && !signal.aborted) {
        for (const step of definition.steps) {
          if (active.size >= Math.min(definition.maxParallel ?? 4, this.limit)) break;
          if (states.get(step.id) !== "pending" || (step.needs ?? []).some(id => ["pending", "running"].includes(states.get(id)!))) continue;
          const work = runStep(step).finally(() => active.delete(work)); active.add(work);
        }
        if (active.size) await Promise.race(active); else if ([...states.values()].includes("pending")) throw new Error("Workflow graph cannot advance.");
      }
    } catch (error) { controller.abort("workflow orchestration failed"); throw error;
    } finally { if (signal.aborted) controller.abort(); await Promise.allSettled(active); }
    const aggregate = JSON.stringify(Object.fromEntries([...states].map(([id, state]) => [id, { state, output: outputs.get(id) ?? "[Not executed]" }])), null, 2);
    let text = aggregate;
    if (definition.output) { try { text = fill(definition.output); } catch (error) { if (!failed && !signal.aborted) throw error; } }
    write(text); return { text, isError: failed || parentSignal.aborted };
  }
}
