// Implements: SPEC-PLA-003 (validated graph, parameters and trusted sources).
// Supports: SPEC-PLA-004, SPEC-CMD-077, gap E-165.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { compileSchema } from "../shared/schema";
import { parseYaml } from "../platform/yaml";
import { readPrivateText } from "../shared/private-text";
import { splitHeader } from "../skills/registry";
const name = () => Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" });
const scalar = Type.Union([Type.String({ maxLength: 10000 }), Type.Number(), Type.Boolean()]);
const value = Type.Union([scalar, Type.Array(scalar, { maxItems: 32 })]);
const schema = Type.Object({
  name: name(), description: Type.String({ minLength: 1, maxLength: 1000 }),
  parameters: Type.Optional(Type.Record(name(), Type.Object({ type: Type.Union([Type.Literal("string"), Type.Literal("number"), Type.Literal("boolean"), Type.Literal("array")]), required: Type.Optional(Type.Boolean()), default: Type.Optional(value), description: Type.Optional(Type.String({ maxLength: 1000 })) }, { additionalProperties: false }), { additionalProperties: false })),
  steps: Type.Array(Type.Object({ id: name(), type: Type.Union([Type.Literal("agent"), Type.Literal("shell")]), prompt: Type.Optional(Type.String({ minLength: 1, maxLength: 64000 })), command: Type.Optional(Type.String({ minLength: 1, maxLength: 10000 })), tools: Type.Optional(Type.Array(Type.String({ pattern: "^[a-zA-Z0-9_-]+$", maxLength: 64 }), { maxItems: 64, uniqueItems: true })), needs: Type.Optional(Type.Array(name(), { maxItems: 32, uniqueItems: true })), when: Type.Optional(Type.Union([Type.Boolean(), Type.String({ pattern: "^!?(inputs\\.[a-z][a-z0-9-]*|steps\\.[a-z][a-z0-9-]*\\.succeeded)$" })])), onError: Type.Optional(Type.Union([Type.Literal("stop"), Type.Literal("turn_completed"), Type.Literal("continue")])), forEach: Type.Optional(Type.String({ pattern: "^(inputs|steps)\\.[a-z][a-z0-9-]*$" })) }, { additionalProperties: false }), { minItems: 1, maxItems: 32 }),
  maxParallel: Type.Optional(Type.Integer({ minimum: 1, maximum: 32 })), output: Type.Optional(Type.String({ maxLength: 64000 })),
}, { additionalProperties: false });
export type WorkflowDefinition = Static<typeof schema>;
export type WorkflowStep = WorkflowDefinition["steps"][number];
export type Workflow = WorkflowDefinition & { readonly source: "built-in" | "user" | "project"; readonly file?: string };
const validate = compileSchema<WorkflowDefinition>(schema), validateValue = compileSchema(value);
const matchesType = (type: string, value: unknown) => type === "array" ? Array.isArray(value) : typeof value === type;
export function workflowTemplate(text: string): string {
  const normalized = text.replace(/\$\{steps\.([a-z][a-z0-9-]*)\.output\}/g, "{%steps.$1%}");
  if (/\$\{steps\./.test(normalized)) throw new Error("Invalid public workflow output reference."); return normalized;
}
function substitutions(text: string): string[] {
  const references: string[] = [];
  const rest = workflowTemplate(text).replace(/\{%([^%]+)%\}/g, (_match, reference: string) => { if (!/^(?:(inputs|steps)\.[a-z][a-z0-9-]*|item)$/.test(reference)) throw new Error(`Invalid workflow substitution: ${reference}.`); references.push(reference); return ""; });
  if (/\{%|%\}/.test(rest)) throw new Error("Invalid workflow substitution syntax."); return references;
}
export function parseWorkflow(text: string): WorkflowDefinition {
  const data = text.startsWith("---") ? splitHeader(text).header : parseYaml(text), result = validate(data);
  if (!result.ok) throw new Error(`Invalid workflow: ${result.errors.join("; ")}`);
  const definition = result.value, ids = new Set(definition.steps.map(step => step.id));
  if (ids.size !== definition.steps.length) throw new Error("Invalid workflow: duplicate step id.");
  for (const [key, param] of Object.entries(definition.parameters ?? {})) if (param.default !== undefined && !matchesType(param.type, param.default)) throw new Error(`Invalid workflow: default type for ${key}.`);
  const visited = new Set<string>(), stack = new Set<string>();
  const visit = (id: string): void => {
    if (stack.has(id)) throw new Error("Invalid workflow: dependency cycle.");
    if (visited.has(id)) return; stack.add(id);
    const step = definition.steps.find(step => step.id === id)!;
    if ((step.type === "agent" ? !step.prompt || step.command !== undefined : !step.command || step.prompt !== undefined || step.tools !== undefined)) throw new Error(`Invalid workflow: content of ${id}.`);
    for (const dependency of step.needs ?? []) { if (!ids.has(dependency)) throw new Error(`Invalid workflow: unknown dependency ${dependency}.`); visit(dependency); }
    const references = substitutions(step.prompt ?? step.command ?? ""), condition = typeof step.when === "string" ? step.when.replace(/^!/, "").replace(/\.succeeded$/, "") : undefined;
    if (condition?.startsWith("inputs.") && definition.parameters?.[condition.slice(7)]?.type !== "boolean") throw new Error(`Invalid workflow: condition ${condition} must be boolean.`);
    if (step.forEach?.startsWith("inputs.") && definition.parameters?.[step.forEach.slice(7)]?.type !== "array") throw new Error(`Invalid workflow: ${step.forEach} must be an array.`);
    for (const reference of [...references, ...(step.forEach ? [step.forEach] : []), ...(condition ? [condition] : [])]) {
      const [scope, key] = reference.split(".");
      if (scope === "steps" && !(step.needs ?? []).includes(key!)) throw new Error(`Invalid workflow: ${id} must depend on ${key}.`);
      if (scope === "inputs" && !Object.hasOwn(definition.parameters ?? {}, key!)) throw new Error(`Invalid workflow: unknown parameter ${key}.`);
      if (scope === "item" && !step.forEach) throw new Error(`Invalid workflow: item outside forEach in ${id}.`);
    }
    stack.delete(id); visited.add(id);
  };
  for (const id of ids) visit(id);
  for (const reference of substitutions(definition.output ?? "")) { const [scope, key] = reference.split("."); if (scope === "steps" ? !ids.has(key!) : scope !== "inputs" || !Object.hasOwn(definition.parameters ?? {}, key!)) throw new Error(`Invalid workflow: output reference ${reference}.`); }
  return definition;
}
export function workflowInputs(definition: WorkflowDefinition, inputs: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  const parameters = definition.parameters ?? {}, out: Record<string, unknown> = {};
  for (const key of Object.keys(inputs)) if (!Object.hasOwn(parameters, key)) throw new Error(`Invalid workflow input: unknown parameter ${key}.`);
  for (const [key, param] of Object.entries(parameters)) {
    const input = Object.hasOwn(inputs, key) ? inputs[key] : param.default;
    if (input === undefined) { if (param.required) throw new Error(`Invalid workflow input: ${key} is required.`); continue; }
    if (!validateValue(input).ok || !matchesType(param.type, input)) throw new Error(`Invalid workflow input: ${key} must be ${param.type}.`);
    out[key] = input;
  }
  for (const text of [...definition.steps.map(step => step.prompt ?? step.command ?? ""), definition.output ?? ""]) for (const reference of substitutions(text)) if (reference.startsWith("inputs.") && !Object.hasOwn(out, reference.slice(7))) throw new Error(`Invalid workflow input: ${reference.slice(7)} is used but absent.`);
  for (const step of definition.steps) for (const reference of [step.forEach, typeof step.when === "string" ? step.when.replace(/^!/, "") : undefined]) if (reference?.startsWith("inputs.") && !Object.hasOwn(out, reference.slice(7))) throw new Error(`Invalid workflow input: ${reference.slice(7)} is used but absent.`);
  return out;
}
export function loadWorkflows(builtins: readonly WorkflowDefinition[], locations: readonly { readonly source: "user" | "project"; readonly dir: string }[], denied: (path: string) => boolean, warn: (message: string) => void): Map<string, Workflow> {
  const out = new Map<string, Workflow>(builtins.map(definition => [definition.name, { ...definition, source: "built-in" }]));
  let files = 0;
  for (const location of locations) {
    let names: string[]; try { names = readdirSync(location.dir).sort(); } catch { continue; }
    for (const name of names) {
      if (!/\.(yaml|yml|md)$/.test(name) || ++files > 64) continue;
      const file = join(location.dir, name); if (denied(file)) continue;
      try { const definition = parseWorkflow(readPrivateText(file, 65536)); out.set(definition.name, { ...definition, source: location.source, file }); }
      catch (error) { warn(`Flux écarté (${file}) : ${(error as Error).message}`); }
    }
  }
  return out;
}
export function workflowPlan(definition: Workflow, globalMax = Infinity): string {
  return `${definition.name} — ${definition.description}\nSource : ${definition.source === "built-in" ? "intégré" : definition.source === "project" ? "projet" : "utilisateur"}\nParallélisme maximal : ${Math.min(definition.maxParallel ?? 4, globalMax)}\n` + definition.steps.map(step => `${step.id} (${step.type})${step.needs?.length ? ` après ${step.needs.join(", ")}` : ""} — ${step.type === "shell" ? `run_shell : ${step.command}` : `${step.tools?.join(", ") ?? "outils du parent"} : ${step.prompt}`}`).join("\n");
}
