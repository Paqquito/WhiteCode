// Implements: SPEC-PER-028 (bound decisions, replacement validation and cancellation).
// Supports: SPEC-PER-001, gap E-169.
import { createHash, randomUUID } from "node:crypto";
import type { ApprovalRequest, DecisionDelegate, HostDecision } from "./resolver";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value) ?? "null";
}
const digest = (value: unknown) => createHash("sha256").update(canonical(value)).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
export interface DelegatedRequest { readonly request: ApprovalRequest; readonly binding: Readonly<Record<string, string>> }

/** Only the explicitly designated control component receives a fresh request binding. No model output is a decision. */
export function connectorPermissionDelegate(options: {
  readonly sessionId: string;
  readonly timeoutMs: () => number;
  readonly context: () => unknown;
  readonly invoke: (request: DelegatedRequest, signal: AbortSignal) => Promise<unknown>;
}): DecisionDelegate {
  return { async decide(request, signal): Promise<HostDecision> {
    const denied = (reason: string): HostDecision => ({ decision: "deny", reason });
    if (signal.aborted) return denied("The permission call was cancelled.");
    const controller = new AbortController(), active = AbortSignal.any([signal, controller.signal]);
    const timeoutMs = options.timeoutMs(), deadline = Date.now() + timeoutMs;
    const expired = () => active.aborted || Date.now() >= deadline;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let abort = () => {};
    const cancelled = new Promise<undefined>(resolve => { abort = () => resolve(undefined); active.addEventListener("abort", abort, { once: true }); if (active.aborted) abort(); });
    try {
      const contextVersion = digest(options.context());
      const binding = { sessionId: options.sessionId, nonce: randomUUID(), callId: request.callId, toolName: request.toolName, inputHash: digest(request.input), resourcesHash: digest(request.action ?? request.summary), contextVersion };
      const response = await Promise.race([Promise.resolve().then(() => active.aborted ? undefined : options.invoke({ request, binding }, active)), cancelled]);
      if (expired()) return denied("The permission delegate deadline expired or the call was cancelled.");
      if (digest(options.context()) !== contextVersion) return denied("The security context changed while the delegate was deciding.");
      if (expired()) return denied("The permission delegate deadline expired while validating the security context.");
      if (!object(response) || Object.keys(response).some(key => !["binding", "decision", "input", "reason"].includes(key)) || !object(response["binding"]) || canonical(response["binding"]) !== canonical(binding)) return denied("The permission delegate returned an invalid or unrelated decision.");
      if (response["decision"] === "deny" && typeof response["reason"] === "string" && response["reason"].trim() && response["reason"].length <= 4096 && response["input"] === undefined) return denied(response["reason"]);
      if (response["decision"] !== "allow" || response["reason"] !== undefined || response["input"] !== undefined && !object(response["input"])) return denied("The permission delegate returned an invalid decision schema.");
      return response["input"] === undefined ? { decision: "allow" } : { decision: "allow_modified", input: response["input"] as Record<string, unknown> };
    } catch { return denied("The permission delegate failed; the call was refused."); }
    finally { clearTimeout(timer); active.removeEventListener("abort", abort); controller.abort(); }
  } };
}
