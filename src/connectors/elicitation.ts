// Implements: SPEC-MCP-012 (local schema validation, human review, hooks, cancel in headless, CA-01, CA-02).
// Supports: gap E-155 (flat primitive schemas, masked field buffers, no defaults or model-visible answers).
import { secureConnectorUrl } from "./url";
export interface ElicitationResponse { readonly action: "accept" | "decline" | "cancel"; readonly content?: Readonly<Record<string, string | number | boolean>> }
export interface ElicitationField { readonly type: "string" | "number" | "integer" | "boolean"; readonly format?: string; readonly enum?: readonly (string | number | boolean)[]; readonly title?: string; readonly description?: string; readonly minLength?: number; readonly maxLength?: number; readonly minimum?: number; readonly maximum?: number }
export interface ElicitationUi {
  field(server: string, message: string, key: string, field: ElicitationField, error: boolean, signal: AbortSignal): Promise<string | undefined>;
  review(server: string, values: Readonly<Record<string, string | number | boolean>>, signal: AbortSignal): Promise<"send" | "edit" | "decline" | undefined>;
  url(server: string, message: string, url: string, signal: AbortSignal): Promise<boolean | undefined>;
}
interface Request { readonly mode?: "form" | "url"; readonly message: string; readonly url?: string; readonly elicitationId?: string; readonly requestedSchema?: { readonly type: "object"; readonly properties: Readonly<Record<string, ElicitationField>>; readonly required?: readonly string[] } }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function validSchema(value: unknown): value is NonNullable<Request["requestedSchema"]> {
  if (!object(value) || value.type !== "object" || !object(value.properties) || Object.keys(value.properties).length > 32 || Object.keys(value).some(k => !["type", "properties", "required", "additionalProperties", "title", "description", "$schema"].includes(k)) || value.required !== undefined && (!Array.isArray(value.required) || value.required.some(k => typeof k !== "string" || !Object.hasOwn(value.properties as object, k)))) return false;
  for (const [key, field] of Object.entries(value.properties)) {
    if (!key || key.length > 128 || /[\u0000-\u001f\u007f]/.test(key) || !object(field) || !["string", "number", "integer", "boolean"].includes(String(field.type)) || Object.keys(field).some(k => !["type", "format", "enum", "enumNames", "title", "description", "default", "minLength", "maxLength", "minimum", "maximum"].includes(k))) return false;
    if (["title", "description"].some(k => field[k] !== undefined && (typeof field[k] !== "string" || field[k].length > 4000)) || field.format !== undefined && !["email", "uri", "url", "date", "date-time"].includes(String(field.format))) return false;
    if (["minimum", "maximum", "minLength", "maxLength"].some(k => field[k] !== undefined && (typeof field[k] !== "number" || !Number.isFinite(field[k])))) return false;
    if (["minLength", "maxLength"].some(k => field[k] !== undefined && (!Number.isInteger(field[k]) || Number(field[k]) < 0))) return false;
    if (typeof field.minimum === "number" && typeof field.maximum === "number" && field.minimum > field.maximum || typeof field.minLength === "number" && typeof field.maxLength === "number" && field.minLength > field.maxLength) return false;
    if (field.enum !== undefined && (!Array.isArray(field.enum) || !field.enum.length || field.enum.length > 64 || field.enum.some(v => !["string", "number", "boolean"].includes(typeof v) || typeof v === "string" && v.length > 2048))) return false;
  } return true;
}
function valid(field: ElicitationField, value: unknown): value is string | number | boolean {
  if (field.type === "string") {
    if (typeof value !== "string" || value.length > 2048 || value.length < (field.minLength ?? 0) || value.length > (field.maxLength ?? 2048)) return false;
    if (field.format === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return false;
    if (field.format === "date-time" && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)) || !valid({ type: "string", format: "date" }, value.slice(0, 10)))) return false;
    if (field.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return false;
    if (field.format === "uri" || field.format === "url") { try { new URL(value); } catch { return false; } }
  } else if (field.type === "boolean") { if (typeof value !== "boolean") return false; }
  else if (typeof value !== "number" || !Number.isFinite(value) || field.type === "integer" && !Number.isInteger(value) || value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity)) return false;
  return !field.enum || field.enum.includes(value as string | number | boolean);
}
export class Elicitation {
  #busy = false;
  constructor(readonly options: { before?: (server: string, request: Request, signal: AbortSignal) => Promise<ElicitationResponse | undefined>; after: (server: string, result: ElicitationResponse) => void | Promise<void>; ui?: ElicitationUi; containsSecret?: (content: string) => boolean }) {}
  async request(server: string, raw: unknown, signal: AbortSignal): Promise<ElicitationResponse> {
    if (this.#busy || signal.aborted) { const result = { action: "cancel" } as const; try { await this.options.after(server, result); } catch {} return result; }
    this.#busy = true; let result: ElicitationResponse = { action: "decline" };
    try { result = await this.#request(server, raw, signal); }
    catch { result = { action: "cancel" }; }
    finally { this.#busy = false; }
    try { await this.options.after(server, result); } catch {} return result;
  }
  async #request(server: string, raw: unknown, signal: AbortSignal): Promise<ElicitationResponse> {
    if (!object(raw) || typeof raw.message !== "string" || raw.message.length > 8000 || JSON.stringify(raw).length > 65536 || raw.mode !== undefined && !["form", "url"].includes(String(raw.mode))) return { action: "decline" };
    const request = raw as unknown as Request;
    if (request.mode === "url") {
      if (typeof request.url !== "string" || typeof request.elicitationId !== "string" || !request.elicitationId || request.elicitationId.length > 256) return { action: "decline" }; secureConnectorUrl(request.url);
    } else if (!validSchema(request.requestedSchema)) return { action: "decline" };
    // Never present server-supplied defaults, including through a hook or a review panel.
    const safe = structuredClone(request); if (safe.requestedSchema) for (const field of Object.values(safe.requestedSchema.properties)) delete (field as ElicitationField & { default?: unknown }).default;
    const check = (response: ElicitationResponse): ElicitationResponse => {
      if (response.action !== "accept") return { action: response.action === "decline" ? "decline" : "cancel" };
      if (safe.mode === "url") return { action: "accept" };
      const schema = safe.requestedSchema!, content = response.content;
      if (!content || !object(content) || (schema.required ?? []).some(k => !Object.hasOwn(content, k)) || Object.entries(content).some(([k, v]) => !schema.properties[k] || !valid(schema.properties[k]!, v)) || this.options.containsSecret?.(JSON.stringify(content))) return { action: "decline" };
      return { action: "accept", content };
    };
    const hook = await this.options.before?.(server, safe, signal); if (hook) return check(hook);
    const ui = this.options.ui; if (!ui) return { action: "cancel" };
    if (safe.mode === "url") { const accepted = await ui.url(server, safe.message, safe.url!, signal); return { action: accepted === undefined ? "cancel" : accepted ? "accept" : "decline" }; }
    for (let review = 0; review < 10; review++) {
      const content: Record<string, string | number | boolean> = Object.create(null) as Record<string, string | number | boolean>;
      for (const [key, field] of Object.entries(safe.requestedSchema!.properties)) {
        let bad = false, accepted = false;
        for (let attempt = 0; attempt < 20; attempt++) {
          signal.throwIfAborted(); const input = await ui.field(server, safe.message, key, field, bad, signal); if (input === undefined) return { action: "cancel" };
          const value = field.type === "string" ? input : field.type === "boolean" ? input === "true" ? true : input === "false" ? false : undefined : input.trim() ? Number(input) : undefined;
          if (valid(field, value)) { content[key] = value; accepted = true; break; } bad = true;
        } if (!accepted) return { action: "cancel" };
      }
      if (this.options.containsSecret?.(JSON.stringify(content))) return { action: "decline" };
      const decision = await ui.review(server, content, signal); if (decision === "edit") continue;
      return decision === "send" ? check({ action: "accept", content }) : { action: decision === "decline" ? "decline" : "cancel" };
    } return { action: "cancel" };
  }
}
