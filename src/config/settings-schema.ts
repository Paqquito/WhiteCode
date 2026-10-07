// Implements: SPEC-CFG-002 (EF-02, § 6 widening keys, § 6.1 catalogue for the keys of lot 1)
// Single source of truth for setting keys: type, default, allowed scopes, owner sheet, merge rule, widening flags.

import { Type, type TSchema } from "@sinclair/typebox";

export const SCOPES = ["managed", "cli", "local", "project", "user"] as const;
export type Scope = (typeof SCOPES)[number];
export type Origin = Scope | "env" | "default";

export const PERMISSION_MODES = ["ask", "planning", "auto_edit", "no_prompt", "auto_approve", "unrestricted"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export type ValueKind = "plain" | "duration" | "size" | "amount";

export interface SettingDef {
  readonly key: string;
  readonly schema: TSchema;
  readonly kind?: ValueKind;
  readonly default?: unknown;
  /** Scopes where the key is read (U=user, P=project, L=local, G=managed, C=cli). */
  readonly scopes: readonly Scope[];
  readonly owner: string;
  /** Lists of rules are concatenated across scopes (RG-03); other lists are replaced (RG-04). */
  readonly merge?: "concat" | "replace";
  /** Widening key (SPEC-CFG-002 § 6): never read from `project` or `local`. */
  readonly widening?: boolean;
  /** For value-dependent keys: values accepted from `project` and `local` (SPEC-CFG-001 RG-08). */
  readonly restrictiveValues?: readonly unknown[];
  /** Sensitive value: masked in diagnostics. */
  readonly secret?: boolean;
  /** Applied during a session when its file changes (SPEC-CFG-005 § 5.1); the other keys wait for the next session. */
  readonly hot?: boolean;
}

const U: Scope = "user";
const P: Scope = "project";
const L: Scope = "local";
const G: Scope = "managed";
const C: Scope = "cli";

const str = () => Type.String();
const bool = () => Type.Boolean();
const int = (min?: number, max?: number) => Type.Integer({ ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}) });
const num = (min?: number, max?: number) => Type.Number({ ...(min !== undefined ? { minimum: min } : {}), ...(max !== undefined ? { maximum: max } : {}) });
const strList = () => Type.Array(Type.String());
const durationSchema = () => Type.Union([Type.Number({ minimum: 0 }), Type.String()]);
const enumOf = (values: readonly string[]) => Type.Union(values.map((v) => Type.Literal(v)));
const mode = () => enumOf(PERMISSION_MODES);

export const SETTINGS: readonly SettingDef[] = [
  // Models, thinking and effort
  { key: "models.selected", schema: str(), scopes: [U, P, G, C], owner: "SPEC-MOT-001" },
  // Tier alias → model identifier (SPEC-API-007); how each developer maps the neutral tiers (gap E-040).
  { key: "models.identifierMap", schema: Type.Object({ large: Type.Optional(str()), medium: Type.Optional(str()), small: Type.Optional(str()) }, { additionalProperties: false }), default: {}, scopes: [U, G], owner: "SPEC-API-007" },
  // Entries for models absent from the distribution catalogue (gap E-041, proposed key).
  // SPEC-API-007: restricts the selectable models (aliases or identifiers); a managed list cannot be widened (EF-03).
  { key: "models.allowList", schema: strList(), scopes: [U, G], owner: "SPEC-API-007" },
  { key: "models.extraCatalog", schema: Type.Array(Type.Unknown()), default: [], scopes: [U, G], owner: "SPEC-API-006", merge: "concat" },
  // Price overrides by model id, in the reference currency (gap E-055); a user override is ignored under a managed cap (SPEC-MOD-005 CA-14).
  { key: "models.pricingOverrides", schema: Type.Record(Type.String(), Type.Record(Type.String(), Type.Unknown())), default: {}, scopes: [U, G], owner: "SPEC-MOD-005" },
  // SPEC-API-005: backup model after consecutive overloads.
  { key: "models.fallback", schema: str(), scopes: [U, P, G, C], owner: "SPEC-API-005" },
  { key: "models.fallbackAfterOverloads", schema: int(1), default: 3, scopes: [U, G], owner: "SPEC-API-005" },
  { key: "models.fallbackCooldown", schema: durationSchema(), kind: "duration", default: 600_000, scopes: [U, G], owner: "SPEC-API-005" },
  { key: "models.effort", schema: enumOf(["low", "medium", "high"]), default: "high", scopes: [U, P], owner: "SPEC-MOT-025" },
  { key: "thinking.enabled", schema: bool(), default: true, scopes: [U], owner: "SPEC-MOT-023" },
  { key: "thinking.mode", schema: enumOf(["adaptive", "budget"]), default: "adaptive", scopes: [U], owner: "SPEC-MOT-023" },
  { key: "thinking.budgetTokens", schema: int(1024), default: 16_000, scopes: [U], owner: "SPEC-MOT-023" },
  { key: "thinking.summaries.visible", schema: bool(), default: false, scopes: [U], owner: "SPEC-MOT-023" },

  // Permissions
  { key: "permissions.allowRules", schema: strList(), default: [], scopes: [U, P, L, G, C], owner: "SPEC-PER-001", merge: "concat", hot: true },
  { key: "permissions.askRules", schema: strList(), default: [], scopes: [U, P, L, G, C], owner: "SPEC-PER-001", merge: "concat", hot: true },
  { key: "permissions.denyRules", schema: strList(), default: [], scopes: [U, P, L, G, C], owner: "SPEC-PER-001", merge: "concat", hot: true },
  { key: "permissions.initialMode", schema: mode(), default: "ask", scopes: [U, P, L, G], owner: "SPEC-PER-003", restrictiveValues: ["ask", "planning"] },
  { key: "permissions.managedRulesOnly", schema: bool(), default: false, scopes: [G], owner: "SPEC-PER-001", hot: true },
  { key: "permissions.disableUnrestrictedMode", schema: bool(), default: false, scopes: [G], owner: "SPEC-PER-003" },
  { key: "permissions.disableAutoApproveMode", schema: bool(), default: false, scopes: [G], owner: "SPEC-PER-003" },
  { key: "permissions.trustedDirectories", schema: strList(), default: [], scopes: [G], owner: "SPEC-PER-016", merge: "concat" },
  { key: "permissions.extraDirectories", schema: strList(), default: [], scopes: [U, G], owner: "SPEC-PER-011", merge: "concat", widening: true },
  { key: "permissions.decisionHooks", schema: Type.Array(Type.Unknown()), default: [], scopes: [U, G], owner: "SPEC-PER-001", merge: "concat", hot: true },

  // Engine
  { key: "engine.maxOutputContinuations", schema: int(0), default: 3, scopes: [U, P, G], owner: "SPEC-MOT-001" },
  { key: "engine.maxStopHookContinuations", schema: int(0), default: 5, scopes: [U, P, G], owner: "SPEC-MOT-001" },
  { key: "engine.toolConcurrency", schema: int(1, 32), default: 8, scopes: [U, P, G], owner: "SPEC-MOT-002" },
  { key: "engine.toolTimeout", schema: durationSchema(), kind: "duration", default: 30 * 60_000, scopes: [U, P, G], owner: "SPEC-MOT-002" },
  { key: "engine.cancelGracePeriod", schema: durationSchema(), kind: "duration", default: 3_000, scopes: [U, G], owner: "SPEC-MOT-002" },
  { key: "engine.limits.maxIterations", schema: int(1), default: 50, scopes: [U, P, G], owner: "SPEC-MOD-005" },
  { key: "engine.limits.maxCost", schema: Type.Union([Type.Number(), Type.String()]), kind: "amount", scopes: [U, P, G], owner: "SPEC-MOD-005" },
  { key: "engine.limits.maxDurationSeconds", schema: int(1), scopes: [U, P, G], owner: "SPEC-MOD-005" },
  { key: "engine.limits.warnRatio", schema: num(0, 1), default: 0.8, scopes: [U], owner: "SPEC-MOD-005" },
  { key: "engine.loopGuard.enabled", schema: bool(), default: true, scopes: [U, G], owner: "SPEC-MOT-046" },
  { key: "engine.loopGuard.threshold", schema: int(2, 10), default: 3, scopes: [U, G], owner: "SPEC-MOT-046" },
  { key: "engine.nonInteractive.defaultPermissionMode", schema: mode(), default: "no_prompt", scopes: [U, P, L, G], owner: "SPEC-MOD-002", restrictiveValues: ["no_prompt", "planning"] },
  { key: "engine.nonInteractive.persistSession", schema: bool(), default: true, scopes: [U, P], owner: "SPEC-MOD-002" },
  { key: "engine.nonInteractive.progressToStderr", schema: bool(), default: false, scopes: [U], owner: "SPEC-MOD-002" },
  { key: "engine.output.format", schema: enumOf(["text", "json", "jsonl"]), default: "text", scopes: [U, P], owner: "SPEC-MOD-003" },
  { key: "engine.output.maxEventSize", schema: durationSchema(), kind: "size", default: 1_048_576, scopes: [U], owner: "SPEC-MOD-003" },
  { key: "engine.output.includeThinking", schema: bool(), default: false, scopes: [U, P], owner: "SPEC-MOD-003" },
  { key: "engine.outputReserveTokens", schema: int(0), default: 16_000, scopes: [G], owner: "SPEC-MOT-010" },
  { key: "engine.unknownModelContextWindow", schema: int(1), default: 128_000, scopes: [G], owner: "SPEC-MOT-010" },

  // Context
  { key: "context.systemInstructionsBudget", schema: int(2000), default: 20_000, scopes: [U, G], owner: "SPEC-MOT-003" },
  { key: "context.allowCustomSystemInstructions", schema: bool(), default: true, scopes: [G], owner: "SPEC-MOT-004" },
  { key: "context.instructions.excludes", schema: strList(), default: [], scopes: [U, P, L, G], owner: "SPEC-MOT-005", merge: "concat" },
  { key: "context.instructions.includeDepth", schema: int(1, 10), default: 4, scopes: [U, G], owner: "SPEC-MOT-005" },
  { key: "context.instructions.fileWarnSize", schema: durationSchema(), kind: "size", default: 40_960, scopes: [U], owner: "SPEC-MOT-005" },
  { key: "context.reminders.maxTokens", schema: int(100), default: 2_000, scopes: [G], owner: "SPEC-MOT-007" },
  { key: "context.reminders.todoInterval", schema: int(1), default: 8, scopes: [U], owner: "SPEC-MOT-007" },
  { key: "context.gitStatus.enabled", schema: bool(), default: true, scopes: [U, P, G], owner: "SPEC-MOT-003" },
  { key: "context.gitGuidance.enabled", schema: bool(), default: true, scopes: [U, P, G], owner: "SPEC-MOT-003" },
  { key: "context.promptFamily", schema: str(), default: "auto", scopes: [U, G], owner: "SPEC-MOT-045" },
  { key: "context.autoCompact.enabled", schema: bool(), default: true, scopes: [U], owner: "SPEC-MOT-012" },
  { key: "context.autoCompact.warnRatio", schema: num(0, 1), default: 0.8, scopes: [U], owner: "SPEC-MOT-012" },
  { key: "context.autoCompact.urgentRatio", schema: num(0, 1), default: 0.88, scopes: [U], owner: "SPEC-MOT-012" },
  { key: "context.autoCompact.triggerRatio", schema: num(0, 1), default: 0.9, scopes: [U], owner: "SPEC-MOT-012" },
  { key: "context.autoCompact.maxFailures", schema: int(1), default: 3, scopes: [U], owner: "SPEC-MOT-012" },
  { key: "context.microCompact.enabled", schema: bool(), default: true, scopes: [U], owner: "SPEC-MOT-013" },
  { key: "context.microCompact.triggerRatio", schema: num(0, 1), default: 0.6, scopes: [U], owner: "SPEC-MOT-013" },
  { key: "context.microCompact.keepRecent", schema: int(0), default: 8, scopes: [U], owner: "SPEC-MOT-013" },
  { key: "context.microCompact.idleMinutes", schema: int(1), default: 60, scopes: [U], owner: "SPEC-MOT-013" },
  { key: "context.providerContextManagement.enabled", schema: bool(), default: true, scopes: [U, G], owner: "SPEC-MOT-014" },
  { key: "context.providerContextManagement.targetTokens", schema: int(0), default: 50_000, scopes: [U], owner: "SPEC-MOT-014" },
  { key: "context.compaction.restoreFiles", schema: int(0), default: 5, scopes: [U], owner: "SPEC-MOT-011" },
  { key: "context.compaction.restoreTokens", schema: int(0), default: 40_000, scopes: [U], owner: "SPEC-MOT-011" },
  // Estimation coefficients by model family (SPEC-MOT-010 EF-02, gap E-062): characters per token, pixels per token.
  { key: "context.tokenEstimation", schema: Type.Record(Type.String(), Type.Object({ text: Type.Optional(num(0.5, 20)), code: Type.Optional(num(0.5, 20)), json: Type.Optional(num(0.5, 20)), pixelsPerToken: Type.Optional(num(1, 100000)) }, { additionalProperties: false })), default: {}, scopes: [U, G], owner: "SPEC-MOT-010" },

  // Tools
  { key: "tools.resultInlineLimit", schema: int(2000), default: 40_000, scopes: [U, G], owner: "SPEC-OUT-001" },
  { key: "tools.read.defaultLines", schema: int(1), default: 1_500, scopes: [U, G], owner: "SPEC-OUT-002" },
  { key: "tools.read.maxLineLength", schema: int(1), default: 2_500, scopes: [G], owner: "SPEC-OUT-002" },
  { key: "tools.read.maxBytesWithoutRange", schema: durationSchema(), kind: "size", default: 384 * 1024, scopes: [G], owner: "SPEC-OUT-002" },
  { key: "tools.read.pdfMaxPages", schema: int(1), default: 15, scopes: [G], owner: "SPEC-OUT-002" },
  { key: "tools.write.maxSize", schema: durationSchema(), kind: "size", default: 10 * 1024 * 1024, scopes: [G], owner: "SPEC-OUT-003" },
  { key: "tools.edit.lenientMatching", schema: bool(), default: true, scopes: [U, G], owner: "SPEC-OUT-004" },
  { key: "tools.find.maxResults", schema: int(1), default: 250, scopes: [U, G], owner: "SPEC-OUT-006" },
  { key: "tools.find.timeout", schema: durationSchema(), kind: "duration", default: 20_000, scopes: [G], owner: "SPEC-OUT-006" },
  { key: "tools.respectIgnoreFiles", schema: bool(), default: true, scopes: [U, P], owner: "SPEC-OUT-006" },
  { key: "tools.search.defaultLimit", schema: int(1), default: 200, scopes: [U, G], owner: "SPEC-OUT-007" },
  { key: "tools.search.maxLineLength", schema: int(1), default: 400, scopes: [G], owner: "SPEC-OUT-007" },
  { key: "tools.search.timeout", schema: durationSchema(), kind: "duration", default: 30_000, scopes: [G], owner: "SPEC-OUT-007" },
  { key: "tools.shell.default", schema: str(), scopes: [U, G], owner: "SPEC-OUT-008", widening: true },
  { key: "tools.shell.defaultTimeout", schema: durationSchema(), kind: "duration", default: 180_000, scopes: [U, G], owner: "SPEC-OUT-008" },
  { key: "tools.shell.maxTimeout", schema: durationSchema(), kind: "duration", default: 1_200_000, scopes: [G], owner: "SPEC-OUT-008" },
  { key: "tools.shell.outputLimit", schema: int(1000), default: 24_000, scopes: [G], owner: "SPEC-OUT-008" },
  { key: "tools.powershell.path", schema: str(), scopes: [U, G], owner: "SPEC-OUT-009", widening: true },
  { key: "tools.powershell.loadProfile", schema: bool(), default: false, scopes: [U], owner: "SPEC-OUT-009" },

  // Sandbox (widening keys, SPEC-CFG-002 § 6)
  { key: "sandbox.enabled", schema: bool(), default: false, scopes: [U, P, G], owner: "SPEC-PER-015", restrictiveValues: [true] },
  { key: "sandbox.excludedCommands", schema: strList(), default: [], scopes: [U, G], owner: "SPEC-PER-015", merge: "concat", widening: true },
  { key: "sandbox.network.allowedDomains", schema: strList(), default: [], scopes: [U, G], owner: "SPEC-PER-015", merge: "concat", widening: true },

  // API
  // No default provider (decision D-09, gap E-039).
  { key: "api.provider", schema: enumOf(["anthropic", "openai", "openai_compatible", "bedrock", "vertex", "foundry"]), scopes: [U, G], owner: "SPEC-API-001" },
  // Base URL of the configured provider (gap E-042, proposed key); mandatory for `openai_compatible`.
  { key: "api.baseUrl", schema: str(), scopes: [U, G], owner: "SPEC-API-001" },
  { key: "api.streamIdleTimeout", schema: durationSchema(), kind: "duration", default: 90_000, scopes: [U, G], owner: "SPEC-API-002" },
  { key: "api.maxRetries", schema: int(0), default: 8, scopes: [U, G], owner: "SPEC-API-003" },
  { key: "auth.loginMethod", schema: str(), scopes: [G], owner: "SPEC-API-012" },

  // Storage, sessions, environment
  { key: "storage.encryption.enabled", schema: bool(), default: false, scopes: [U, G], owner: "SPEC-SES-001" },
  { key: "sessions.snapshotMaxFileSize", schema: durationSchema(), kind: "size", default: 5_242_880, scopes: [U, G], owner: "SPEC-SES-006" },
  { key: "sessions.presenceTimeout", schema: durationSchema(), kind: "duration", default: 60_000, scopes: [U, G], owner: "SPEC-SES-011" },
  { key: "sessions.retentionDays", schema: int(1), default: 30, scopes: [U, G], owner: "SPEC-CFG-013" },
  // SPEC-HOK-002, SPEC-HOK-012: hook declarations by scope and their controls (applied during the session, SPEC-HOK-002 FA-01).
  { key: "hooks", schema: Type.Record(Type.String(), Type.Unknown()), default: {}, scopes: [U, P, L, G, C], owner: "SPEC-HOK-002", hot: true },
  { key: "hooksConfig.disabled", schema: bool(), default: false, scopes: [U, L, G], owner: "SPEC-HOK-012", hot: true },
  { key: "hooksConfig.managedOnly", schema: bool(), default: false, scopes: [G], owner: "SPEC-HOK-012", hot: true },
  { key: "hooksConfig.commandTimeout", schema: durationSchema(), kind: "duration", default: 60_000, scopes: [U, G], owner: "SPEC-HOK-003" },
  { key: "hooksConfig.outputMaxSize", schema: durationSchema(), kind: "size", default: 65_536, scopes: [U, G], owner: "SPEC-HOK-003" },
  { key: "hooksConfig.payloadMaxSize", schema: durationSchema(), kind: "size", default: 262_144, scopes: [U, G], owner: "SPEC-HOK-001" },
  { key: "hooksConfig.http.timeout", schema: durationSchema(), kind: "duration", default: 10_000, scopes: [U, G], owner: "SPEC-HOK-004" },
  { key: "hooksConfig.http.allowedUrls", schema: strList(), scopes: [U, G], owner: "SPEC-HOK-004" },
  { key: "hooksConfig.http.allowedEnvVars", schema: strList(), default: [], scopes: [U, G], owner: "SPEC-HOK-004" },
  { key: "hooksConfig.maxAsync", schema: int(1, 64), default: 8, scopes: [U, G], owner: "SPEC-HOK-007" },
  { key: "hooksConfig.asyncKillOnExit", schema: bool(), default: false, scopes: [U, G], owner: "SPEC-HOK-007" },
  // SPEC-EXT-019: skills (lot 4).
  { key: "skills.maxDescriptionsTokens", schema: int(100, 100_000), default: 4_000, scopes: [U, G], owner: "SPEC-EXT-019" },
  // SPEC-MCP-001 to 022, SPEC-PER-019: connectors (lot 3).
  { key: "mcp.enableProjectServers", schema: bool(), default: false, scopes: [U], owner: "SPEC-PER-019", widening: true },
  { key: "mcp.enabledProjectServers", schema: strList(), default: [], scopes: [U], owner: "SPEC-PER-019", widening: true },
  { key: "mcp.disabledProjectServers", schema: strList(), default: [], scopes: [U, L], owner: "SPEC-PER-019", merge: "concat" },
  { key: "mcp.allowList", schema: Type.Array(Type.Unknown()), scopes: [G], owner: "SPEC-MCP-021" },
  { key: "mcp.denyList", schema: Type.Array(Type.Unknown()), default: [], scopes: [G], owner: "SPEC-MCP-021" },
  { key: "mcp.managedServersOnly", schema: bool(), default: false, scopes: [G], owner: "SPEC-MCP-021" },
  { key: "mcp.connectTimeout", schema: durationSchema(), kind: "duration", default: 30_000, scopes: [U, G], owner: "SPEC-MCP-002" },
  { key: "mcp.toolTimeout", schema: durationSchema(), kind: "duration", default: 600_000, scopes: [U, G], owner: "SPEC-MCP-009" },
  { key: "mcp.toolDescriptionMax", schema: int(100, 100_000), default: 2_000, scopes: [U, G], owner: "SPEC-MCP-009" },
  { key: "mcp.eagerToolsThreshold", schema: int(0, 10_000), default: 15, scopes: [U, G], owner: "SPEC-MCP-009" },
  { key: "mcp.outputInlineLimit", schema: int(100, 10_000_000), default: 20_000, scopes: [U, G], owner: "SPEC-MCP-020" },
  { key: "mcp.maxParallelConnects", schema: int(1, 100), default: 10, scopes: [U, G], owner: "SPEC-MCP-022" },
  { key: "mcp.maxReconnects", schema: int(0, 100), default: 6, scopes: [U, G], owner: "SPEC-MCP-022" },
  { key: "environment.variables", schema: Type.Record(Type.String(), Type.String()), default: {}, scopes: [U, G], owner: "SPEC-CFG-007", widening: true },

  // Options forbidden by the managed policy (SPEC-MOD-011 § 11, decision D-13, gap E-029).
  { key: "policy.forbiddenOptions", schema: strList(), default: [], scopes: [G], owner: "SPEC-MOD-011", merge: "concat" },
];

export const SETTING_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((d) => [d.key, d]));

/** True when `key` is a declared key or the parent of declared keys. */
export function isKnownPrefix(key: string): boolean {
  for (const k of SETTING_BY_KEY.keys()) if (k === key || k.startsWith(`${key}.`)) return true;
  return false;
}
