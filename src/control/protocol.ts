// Implements: SPEC-MOD-006 (§ 5.2 and § 5.3 catalogues, § 5.4 steps 2 and 3, EF-01, EF-04, EF-06, ENF-03, RG-01, ERR-01, ERR-03)
// Messages of the control channel, independent of the transport: one JSON object per message, in the same stream as the
// events of the `jsonl` format (SPEC-MOD-003), distinguished by its type. The same objects travel over a network
// connection (SPEC-MOD-007 EF-06).

import type { PermissionMode } from "../config/settings-schema";

/** Major.minor: a minor version stays compatible with the earlier hosts (ENF-03); another major is refused (EF-06). */
export const CONTROL_PROTOCOL_VERSION = "1.0";

/** Requests of the host to the engine (§ 5.2). */
export const HOST_REQUESTS = [
  "cancel_turn",
  "inject_user_message",
  "set_approval_mode",
  "select_model",
  "get_state",
  "list_commands",
  "invoke_command",
  "set_tool_permissions",
  "add_context",
  "shutdown",
] as const;
export type HostRequest = (typeof HOST_REQUESTS)[number];

/** Demands of the engine to the host (§ 5.3). */
export const ENGINE_DEMANDS = ["approval_request", "request_user_choice", "notify", "open_resource", "confirm_escalation"] as const;
export type EngineDemand = (typeof ENGINE_DEMANDS)[number];

/** Demands this version sends: the others are part of the protocol, but no function of the product emits them yet. */
export const EMITTED_DEMANDS: readonly EngineDemand[] = ["approval_request", "request_user_choice", "notify", "confirm_escalation"];

/** Response delay bounds and default (§ 6). */
export const RESPONSE_TIMEOUT_BOUNDS = { min: 1_000, max: 600_000 } as const;

export type ControlMessage =
  | { readonly type: "control_init"; readonly protocolVersion: string; readonly demands: readonly string[]; readonly responseTimeoutMs?: number; readonly decisionAuthority?: boolean; readonly toolProgress?: boolean }
  | { readonly type: "control_request"; readonly id: string; readonly request: string; readonly params: Readonly<Record<string, unknown>> }
  | { readonly type: "control_response"; readonly id: string; readonly ok: boolean; readonly result?: unknown; readonly error?: { readonly code: string; readonly message: string } };

export const CONTROL_TYPES: ReadonlySet<string> = new Set(["control_init", "control_request", "control_response"]);

/** An error answered to the host, with a stable code (ERR-03 to ERR-06). */
export class ControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const invalid = (detail: string) => new ControlError("invalid_request", `Requête de contrôle invalide : ${detail}.`); // ERR-03

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A control object of the host, checked; `{ error }` names what is wrong (ERR-03) and carries the identifier when one
 * could be read, so that the error is correlated.
 */
export function parseControlMessage(value: Record<string, unknown>): ControlMessage | { readonly error: string; readonly id?: string } {
  const type = value["type"];
  if (type === "control_init") {
    if (value["toolProgress"] !== undefined && typeof value["toolProgress"] !== "boolean") return { error: "toolProgress : booléen attendu" };
    const version = value["protocolVersion"];
    if (typeof version !== "string") return { error: "protocolVersion attendu" };
    const demands = value["demands"] ?? [];
    if (!Array.isArray(demands) || demands.some((d) => typeof d !== "string")) return { error: "demands : liste de noms attendue" };
    const timeout = value["responseTimeoutMs"];
    if (timeout !== undefined && (!Number.isInteger(timeout) || (timeout as number) < RESPONSE_TIMEOUT_BOUNDS.min || (timeout as number) > RESPONSE_TIMEOUT_BOUNDS.max)) {
      return { error: `responseTimeoutMs : entier de ${RESPONSE_TIMEOUT_BOUNDS.min} à ${RESPONSE_TIMEOUT_BOUNDS.max} attendu` };
    }
    const authority = value["decisionAuthority"];
    if (authority !== undefined && typeof authority !== "boolean") return { error: "decisionAuthority : booléen attendu" };
    return { type, protocolVersion: version, demands: demands as string[], ...(timeout !== undefined ? { responseTimeoutMs: timeout as number } : {}), ...(authority !== undefined ? { decisionAuthority: authority } : {}), ...(value["toolProgress"] === true ? { toolProgress: true } : {}) };
  }
  const id = value["id"];
  if (typeof id !== "string" || id === "" || id.length > 200) return { error: "identifiant attendu (texte non vide)" };
  if (type === "control_request") {
    const request = value["request"];
    if (typeof request !== "string") return { error: "request attendu", id };
    const params = value["params"] ?? {};
    if (!isObject(params)) return { error: "params : objet attendu", id };
    return { type, id, request, params };
  }
  const ok = value["ok"];
  if (typeof ok !== "boolean") return { error: "ok attendu", id };
  const error = value["error"];
  if (!ok && error !== undefined && !(isObject(error) && typeof error["message"] === "string")) return { error: "error : objet avec message attendu", id };
  return { type: "control_response", id, ok, result: value["result"], ...(isObject(error) ? { error: { code: String(error["code"] ?? "error"), message: String(error["message"]) } } : {}) };
}

/** EF-06, ERR-01: the same major version is accepted, whatever its minor version (ENF-03). */
export function compatibleVersion(version: string): boolean {
  const m = /^(\d+)\.(\d+)$/.exec(version);
  return m !== null && m[1] === CONTROL_PROTOCOL_VERSION.split(".")[0];
}

/**
 * Ranking of the modes by what they let the agent do without asking (RG-01): `planning` changes nothing; `no_prompt`
 * and `ask` run what the rules allow and submit the rest to an authority; then `auto_edit`, `auto_approve`,
 * `unrestricted`. Going up the ranking is a widening (§ 5.2, `set_approval_mode`).
 */
const MODE_RANK: Readonly<Record<PermissionMode, number>> = { planning: 0, no_prompt: 1, ask: 1, auto_edit: 2, auto_approve: 3, unrestricted: 4 };

export function morePermissive(target: PermissionMode, current: PermissionMode): boolean {
  return MODE_RANK[target] > MODE_RANK[current];
}
