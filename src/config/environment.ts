// Implements: SPEC-CFG-007 (EF-01 to EF-05, RG-01, RG-02, ERR-01, ERR-02, § 5.3 priority), SPEC-CAD-002 (FA-02 environment overrides)
// Single entry point to the process environment (P-07): own variables use the identity prefix, public ones keep their names.

import { readProcessEnvironment } from "../platform/environment";
import { suggest } from "../shared/suggest";
import { parseBoolean, parseDuration } from "./units";

export type EnvType = "string" | "boolean" | "integer" | "duration" | "path";

export interface OwnVariableDef {
  /** Name without the identity prefix. */
  readonly name: string;
  readonly type: EnvType;
  readonly owner: string;
  /** Setting key fed by this variable (priority: above files, below `cli` and `managed`). */
  readonly setting?: string;
  readonly secret?: boolean;
}

/** Catalogue of own variables (SPEC-CFG-007 § 5.1), generated from this single definition (EF-03). */
export const OWN_VARIABLES: readonly OwnVariableDef[] = [
  { name: "CONFIG_HOME", type: "path", owner: "SPEC-CAD-002" },
  { name: "STREAM_PROFILE", type: "string", owner: "SPEC-OBS-022", setting: "ui.streamProfile" },
  { name: "PROVIDER", type: "string", owner: "SPEC-API-001", setting: "api.provider" },
  { name: "MODEL_DEFAULT", type: "string", owner: "SPEC-CAD-002" },
  { name: "MODEL_BACKGROUND", type: "string", owner: "SPEC-CAD-002" },
  { name: "RESPONSE_TOKEN_LIMIT", type: "integer", owner: "SPEC-API-002" },
  { name: "REQUEST_TIMEOUT", type: "duration", owner: "SPEC-API-002" },
  { name: "DEBUG", type: "boolean", owner: "SPEC-OBS-012" },
  { name: "DEBUG_FILE", type: "path", owner: "SPEC-OBS-012" },
  { name: "NO_TELEMETRY", type: "boolean", owner: "SPEC-OBS-001" },
  { name: "NO_ERROR_REPORTS", type: "boolean", owner: "SPEC-OBS-011" },
  { name: "NO_AUTO_UPDATES", type: "boolean", owner: "SPEC-INS-002" },
  { name: "NO_BROWSER", type: "boolean", owner: "SPEC-MCP-006" },
  { name: "OFFLINE_MINIMAL", type: "boolean", owner: "SPEC-OBS-001" },
  { name: "MINIMAL", type: "boolean", owner: "SPEC-MOD-009" },
  { name: "SHELL_INIT_FILE", type: "path", owner: "SPEC-OUT-008" },
  { name: "CHILD_PROCESS", type: "string", owner: "SPEC-OUT-008" },
  { name: "CONTROL_TOKEN", type: "string", owner: "SPEC-MOD-007", secret: true },
  { name: "AGENT_DEPTH", type: "integer", owner: "SPEC-MOD-008" },
  { name: "CONTROL_TLS_CERT", type: "path", owner: "SPEC-MOD-007" },
  { name: "CONTROL_TLS_KEY", type: "path", owner: "SPEC-MOD-007", secret: true },
  { name: "EXTRA_CA_CERTS", type: "path", owner: "SPEC-PER-022" },
  { name: "TLS_CLIENT_CERT", type: "path", owner: "SPEC-PER-022" },
  { name: "TLS_CLIENT_KEY", type: "path", owner: "SPEC-PER-022", secret: true },
  { name: "DISABLE_STATE_CAPTURE", type: "boolean", owner: "SPEC-SES-014" },
  { name: "FEATURE_OVERRIDES", type: "string", owner: "SPEC-CFG-014" },
  { name: "PLAN_CHECK_TOOL", type: "boolean", owner: "SPEC-OUT-025" },
  { name: "PROMPT_HINTS", type: "boolean", owner: "SPEC-MOT-028" },
  { name: "JOB_WORKSPACE", type: "path", owner: "SPEC-MOT-043" },
  { name: "PERSISTENT_MEMORY_DIR", type: "path", owner: "SPEC-AGT-007" },
  { name: "NO_SURVEYS", type: "boolean", owner: "SPEC-IHM-037" },
  { name: "HIDE_DIAGNOSTIC", type: "boolean", owner: "SPEC-CMD-020" },
  { name: "HIDE_SIGN_OUT", type: "boolean", owner: "SPEC-CMD-040" },
  { name: "NO_EDITOR_EXTENSION_INSTALL", type: "boolean", owner: "SPEC-INT-005" },
  { name: "TELEMETRY", type: "boolean", owner: "SPEC-OBS-002" },
  { name: "DETAILED_TELEMETRY", type: "boolean", owner: "SPEC-OBS-005" },
  { name: "TELEMETRY_INCLUDE_CONTENT", type: "boolean", owner: "SPEC-OBS-005" },
  { name: "TELEMETRY_INCLUDE_PROMPTS", type: "boolean", owner: "SPEC-OBS-002" },
  { name: "ORCHESTRATOR_ROLE", type: "string", owner: "SPEC-OBS-007" },
  { name: "PERF_TRACE", type: "string", owner: "SPEC-OBS-008" },
  { name: "PROFILE", type: "string", owner: "SPEC-OBS-009" },
  { name: "SLOW_OP_WARN_MS", type: "integer", owner: "SPEC-OBS-013" },
  { name: "SESSION_RECORDING", type: "string", owner: "SPEC-OBS-016" },
  { name: "API_RECORDING", type: "string", owner: "SPEC-OBS-018" },
  { name: "API_RECORDING_DIR", type: "path", owner: "SPEC-OBS-018" },
  { name: "SESSION_MIRROR", type: "boolean", owner: "SPEC-MOD-017" },
  { name: "SERVER_TOKEN", type: "string", owner: "SPEC-MOD-018", secret: true },
  { name: "EXPERIMENT_BASELINE", type: "boolean", owner: "SPEC-MOD-031" },
];

/** Public variables whose values are secrets: never logged, never passed to child processes (RG-01, RG-02). */
export const PUBLIC_SECRET_VARIABLES: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "OPENAI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_API_KEY",
];

export interface EnvironmentIssue {
  readonly code: "ERR-01" | "ERR-02";
  readonly message: string;
}

export class EnvironmentView {
  readonly #raw: Readonly<Record<string, string>>;
  readonly #prefix: string;
  readonly issues: EnvironmentIssue[] = [];

  constructor(prefix: string, raw: Readonly<Record<string, string>> = readProcessEnvironment()) {
    this.#prefix = prefix;
    this.#raw = raw;
    const known = new Set(OWN_VARIABLES.map((v) => v.name));
    for (const name of Object.keys(raw)) {
      if (!name.startsWith(prefix)) continue;
      const own = name.slice(prefix.length);
      if (known.has(own) || own.startsWith("SERVICE_")) continue;
      const near = suggest(own, known);
      this.issues.push({ code: "ERR-02", message: `Variable inconnue \`${name}\`${near[0] ? ` — vouliez-vous dire \`${prefix}${near[0]}\` ?` : "."}` });
    }
  }

  get prefix(): string {
    return this.#prefix;
  }

  /** Raw value of an own variable (name without prefix). */
  own(name: string): string | undefined {
    return this.#raw[this.#prefix + name];
  }

  ownBoolean(name: string): boolean | undefined {
    const raw = this.own(name);
    if (raw === undefined) return undefined;
    const b = parseBoolean(raw);
    if (b === undefined) this.issues.push({ code: "ERR-01", message: `\`${this.#prefix}${name}\` : valeur invalide.` });
    return b;
  }

  ownInteger(name: string): number | undefined {
    const raw = this.own(name);
    if (raw === undefined) return undefined;
    if (!/^\d+$/.test(raw.trim())) {
      this.issues.push({ code: "ERR-01", message: `\`${this.#prefix}${name}\` : valeur invalide.` });
      return undefined;
    }
    return Number(raw.trim());
  }

  ownDuration(name: string): number | undefined {
    const raw = this.own(name);
    if (raw === undefined) return undefined;
    const d = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : parseDuration(raw);
    if (d === undefined) this.issues.push({ code: "ERR-01", message: `\`${this.#prefix}${name}\` : valeur invalide.` });
    return d;
  }

  /** Public variable, read under its standard name (EF-02). */
  public(name: string): string | undefined {
    return this.#raw[name];
  }

  /** Setting values supplied by own variables (origin `env`). */
  settingsLayer(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const def of OWN_VARIABLES) {
      if (!def.setting) continue;
      const raw = this.own(def.name);
      if (raw !== undefined) out[def.setting] = raw;
    }
    return out;
  }

  /** Runtime identity overrides (`SERVICE_*`, `MODEL_DEFAULT`, `MODEL_BACKGROUND`, and any other variable name for ERR-13). */
  identityOverrides(identityVariables: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const name of identityVariables) {
      const raw = this.own(name);
      if (raw !== undefined) out[name] = raw;
    }
    return out;
  }

  /** Names of the own variables that are set, with secret values masked (EF-05). */
  activeOwnVariables(): Array<{ name: string; value: string }> {
    return OWN_VARIABLES.filter((d) => this.own(d.name) !== undefined).map((d) => ({
      name: this.#prefix + d.name,
      value: d.secret ? "••••" : this.own(d.name)!,
    }));
  }

  /**
   * Environment for a child process (RG-02): the user's environment without the product's own variables
   * nor provider secrets, plus `CHILD_PROCESS=1` and the variables declared in `environment.variables`.
   */
  childEnvironment(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.#raw)) {
      if (k.startsWith(this.#prefix)) continue;
      if (PUBLIC_SECRET_VARIABLES.includes(k)) continue;
      out[k] = v;
    }
    for (const [k, v] of Object.entries(extra)) out[k] = v;
    // SPEC-MOD-008 EF-05: the depth of `run_agent` follows the processes, so that a chain of connectors stays bounded.
    // SPEC-PER-022 § 5.3 step 4: the extra authorities reach the children by the usual variable.
    const ca = this.#raw[`${this.#prefix}EXTRA_CA_CERTS`];
    if (ca !== undefined && out["NODE_EXTRA_CA_CERTS"] === undefined) out["NODE_EXTRA_CA_CERTS"] = ca;
    const depth = this.#raw[`${this.#prefix}AGENT_DEPTH`];
    if (depth !== undefined) out[`${this.#prefix}AGENT_DEPTH`] = depth;
    out[`${this.#prefix}CHILD_PROCESS`] = "1";
    return out;
  }
}
