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
  { key: "context.autoCompact.enabled", schema: bool(), default: true, scopes: [U], owner: "SPEC-MOT-012", hot: true },
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
  // SPEC-EXT-009, SPEC-EXT-015: extensions (lot 4).
  // Hot: taken into account by /reload-extensions within the session (SPEC-CMD-054).
  { key: "extensions.options", schema: Type.Record(Type.String(), Type.Unknown()), default: {}, scopes: [U, P, L, G], owner: "SPEC-EXT-015", hot: true },
  { key: "extensions.managedOnly", schema: bool(), default: false, scopes: [G], owner: "SPEC-EXT-009" },
  // Activations and catalogues merge key by key, the strongest scope last (SPEC-EXT-003 § 5.1: managed > local > project > user).
  { key: "extensions.enabled", schema: Type.Record(Type.String(), Type.Boolean()), default: {}, scopes: [U, P, L, G], owner: "SPEC-EXT-002", hot: true },
  { key: "extensions.catalogs", schema: Type.Record(Type.String(), Type.Unknown()), default: {}, scopes: [U, P, L, G], owner: "SPEC-EXT-004", hot: true },
  { key: "extensions.strictCatalogs", schema: strList(), scopes: [G], owner: "SPEC-EXT-009" },
  { key: "extensions.blockedCatalogs", schema: strList(), default: [], scopes: [G], owner: "SPEC-EXT-009" },
  { key: "extensions.blocked", schema: strList(), default: [], scopes: [G], owner: "SPEC-EXT-009" },
  { key: "extensions.allowFlagged", schema: strList(), default: [], scopes: [G], owner: "SPEC-EXT-010" },
  { key: "extensions.allowPrerelease", schema: bool(), default: false, scopes: [U, G], owner: "SPEC-EXT-008" },
  { key: "extensions.autoInstallProjectExtensions", schema: bool(), default: false, scopes: [U, G], owner: "SPEC-EXT-003" },
  // SPEC-EXT-019: skills (lot 4).
  { key: "skills.batch.maxAgents", schema: int(1, 100), default: 20, scopes: [U, G], owner: "SPEC-EXT-021" },
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

  // SPEC-MOD-010: phases of the start-up and deferred maintenance (lot 5).
  { key: "engine.startup.deferredMaintenance", schema: bool(), default: true, scopes: [U], owner: "SPEC-MOD-010" },
  { key: "engine.startup.verboseLog", schema: bool(), default: false, scopes: [U], owner: "SPEC-MOD-010" },
  // SPEC-MOD-004: structured output (lot 5).
  { key: "engine.control.enabled", schema: bool(), default: false, scopes: [U, P], owner: "SPEC-MOD-006" },
  { key: "engine.control.responseTimeoutMs", schema: int(1_000, 600_000), default: 120_000, scopes: [U, P], owner: "SPEC-MOD-006" },
  { key: "engine.control.maxInFlight", schema: int(1, 1_000), default: 32, scopes: [U], owner: "SPEC-MOD-006" },
  { key: "engine.control.allowEscalation", schema: bool(), default: false, scopes: [U, G], owner: "SPEC-MOD-006" },
  { key: "remote.transport.listenAddress", schema: str(), default: "127.0.0.1:0", scopes: [U, G], owner: "SPEC-MOD-007" },
  { key: "remote.transport.allowedOrigins", schema: strList(), default: [], scopes: [U, G], owner: "SPEC-MOD-007", widening: true },
  { key: "remote.transport.resumeWindowSeconds", schema: int(0, 3_600), default: 120, scopes: [U], owner: "SPEC-MOD-007" },
  { key: "remote.transport.keepAliveSeconds", schema: int(1, 3_600), default: 30, scopes: [U], owner: "SPEC-MOD-007" },
  { key: "remote.transport.maxFrameBytes", schema: int(1_024, 268_435_456), default: 4_194_304, scopes: [U], owner: "SPEC-MOD-007" },
  { key: "remote.transport.allowPlaintextLoopback", schema: bool(), default: true, scopes: [U], owner: "SPEC-MOD-007" },
  { key: "mcp.serve.capabilities", schema: strList(), default: ["run_agent", "read_file", "find_files", "search_content"], scopes: [U, P], owner: "SPEC-MOD-008" },
  { key: "mcp.serve.rootDirectory", schema: str(), scopes: [U, G], owner: "SPEC-MOD-008", widening: true },
  { key: "mcp.serve.maxConcurrency", schema: int(1, 32), default: 4, scopes: [U], owner: "SPEC-MOD-008" },
  { key: "mcp.serve.maxAgentDepth", schema: int(0, 10), default: 2, scopes: [U], owner: "SPEC-MOD-008" },
  { key: "agents.maxDepth", schema: int(0, 10), default: 2, scopes: [U, G], owner: "SPEC-OUT-016" },
  { key: "agents.maxParallel", schema: int(1, 100), default: 10, scopes: [U, G], owner: "SPEC-OUT-016" },
  { key: "agents.defaultModel", schema: str(), scopes: [U, P], owner: "SPEC-OUT-016" },
  { key: "agents.disabledBuiltIns", schema: strList(), default: [], scopes: [U, G], owner: "SPEC-AGT-002" },
  { key: "agents.loadProjectInstructions", schema: bool(), default: true, scopes: [U], owner: "SPEC-AGT-001" },
  { key: "agents.allowProjectAgents", schema: bool(), default: true, scopes: [U, G], owner: "SPEC-AGT-005" },
  { key: "tasks.maxOutputBytes", schema: int(1_024), default: 100 * 1024 * 1024, scopes: [U], owner: "SPEC-AGT-016" },
  { key: "planning.defaultResumeMode", schema: enumOf(["ask", "auto_edit"]), default: "ask", scopes: [U], owner: "SPEC-OUT-024" },
  { key: "tools.fetch.cacheTtl", schema: durationSchema(), kind: "duration", default: 15 * 60_000, scopes: [U], owner: "SPEC-OUT-012" },
  { key: "tools.fetch.maxBytes", schema: int(1_024), default: 10 * 1024 * 1024, scopes: [G], owner: "SPEC-OUT-012" },
  { key: "tools.fetch.timeout", schema: durationSchema(), kind: "duration", default: 30_000, scopes: [G], owner: "SPEC-OUT-012" },
  { key: "tools.fetch.preapprovedDomains", schema: strList(), default: [], scopes: [G], owner: "SPEC-OUT-012" },
  { key: "context.attachments.maxTokens", schema: int(100), default: 12_000, scopes: [U, G], owner: "SPEC-MOT-006" },
  { key: "context.attachments.maxTotalTokens", schema: int(100), default: 60_000, scopes: [U, G], owner: "SPEC-MOT-006" },
  { key: "engine.output.schemaRetries", schema: int(0, 5), default: 2, scopes: [U, P], owner: "SPEC-MOD-004" },
  { key: "engine.output.schemaStrictExtraction", schema: bool(), default: false, scopes: [U, P], owner: "SPEC-MOD-004" },
  { key: "engine.output.schemaMaxDepth", schema: int(1, 100), default: 12, scopes: [U], owner: "SPEC-MOD-004" },
  // SPEC-IHM-001, SPEC-IHM-002: rendering and layout of the interactive interface (lot 5; values in English, gap E-093).
  { key: "ui.colorMode", schema: enumOf(["auto", "none", "16", "256", "truecolor"]), default: "auto", scopes: [U], owner: "SPEC-IHM-001" },
  { key: "ui.maxFramesPerSecond", schema: int(1, 240), default: 30, scopes: [U], owner: "SPEC-IHM-001" },
  { key: "ui.minColumns", schema: int(10, 1_000), default: 60, scopes: [U], owner: "SPEC-IHM-001" },
  { key: "ui.unicodeLevel", schema: enumOf(["full", "restricted", "ascii"]), default: "full", scopes: [U], owner: "SPEC-IHM-001" },
  { key: "ui.retainedLines", schema: int(10, 1_000_000), default: 2_000, scopes: [U], owner: "SPEC-IHM-002" },
  { key: "ui.inputMinHeight", schema: int(1, 100), default: 1, scopes: [U], owner: "SPEC-IHM-002" },
  { key: "ui.inputMaxHeight", schema: int(1, 100), default: 10, scopes: [U], owner: "SPEC-IHM-002" },
  // SPEC-MOD-001, SPEC-IHM-007, SPEC-IHM-011: interactive session, input area and queue (lot 5).
  { key: "ui.exitConfirmation", schema: bool(), default: true, scopes: [U], owner: "SPEC-MOD-001" },
  { key: "ui.sessionSummary", schema: bool(), default: true, scopes: [U], owner: "SPEC-MOD-001" },
  { key: "ui.replayOnResume", schema: enumOf(["condensed", "full", "none"]), default: "condensed", scopes: [U], owner: "SPEC-MOD-001" },
  { key: "ui.exitDoublePressWindow", schema: durationSchema(), kind: "duration", default: 1_500, scopes: [U], owner: "SPEC-MOD-001" },
  { key: "ui.input.maxChars", schema: int(100, 10_000_000), default: 100_000, scopes: [U], owner: "SPEC-IHM-007" },
  { key: "ui.input.warnChars", schema: int(100, 10_000_000), default: 20_000, scopes: [U], owner: "SPEC-IHM-007" },
  { key: "ui.input.persistDraft", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-007" },
  { key: "ui.queue.maxMessages", schema: int(1, 1_000), default: 10, scopes: [U], owner: "SPEC-IHM-011" },
  { key: "ui.queue.autoSend", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-011" },
  { key: "ui.drafts.maxStashed", schema: int(1, 1_000), default: 10, scopes: [U], owner: "SPEC-IHM-011" },
  // SPEC-IHM-008: history of the inputs; SPEC-IHM-009: completion (lot 5; values in English, gap E-096).
  { key: "ui.history.enabled", schema: bool(), default: true, scopes: [U, G], owner: "SPEC-IHM-008" },
  { key: "ui.history.scope", schema: enumOf(["folder", "global"]), default: "folder", scopes: [U], owner: "SPEC-IHM-008" },
  { key: "ui.history.maxEntries", schema: int(1, 1_000_000), default: 5_000, scopes: [U, G], owner: "SPEC-IHM-008" },
  { key: "ui.history.retentionDays", schema: int(1, 36_500), default: 90, scopes: [U, G], owner: "SPEC-IHM-008" },
  { key: "ui.completion.enabled", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-009" },
  { key: "ui.completion.maxVisible", schema: int(1, 100), default: 10, scopes: [U], owner: "SPEC-IHM-009" },
  { key: "ui.completion.maxFileEntries", schema: int(10, 10_000_000), default: 20_000, scopes: [U], owner: "SPEC-IHM-009" },
  { key: "ui.completion.timeoutMs", schema: int(10, 60_000), default: 200, scopes: [U], owner: "SPEC-IHM-009" },
  { key: "ui.completion.fuzzy", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-009" },
  // SPEC-IHM-003, SPEC-IHM-004, SPEC-IHM-005: rich text, colouring of code, differences (lot 5; values in English, gap E-097).
  { key: "ui.richText.enabled", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-003" },
  { key: "ui.richText.maxRenderedChars", schema: int(1_000, 100_000_000), default: 200_000, scopes: [U], owner: "SPEC-IHM-003" },
  { key: "ui.richText.maxNestingLevel", schema: int(1, 50), default: 6, scopes: [U], owner: "SPEC-IHM-003" },
  { key: "ui.wrapTables", schema: bool(), default: false, scopes: [U], owner: "SPEC-IHM-002" },
  { key: "ui.syntaxHighlighting.enabled", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-004" },
  { key: "ui.syntaxHighlighting.maxBytes", schema: int(1_024, 100_000_000), default: 262_144, scopes: [U], owner: "SPEC-IHM-004" },
  { key: "ui.syntaxHighlighting.timeoutMs", schema: int(1, 10_000), default: 50, scopes: [U], owner: "SPEC-IHM-004" },
  { key: "ui.syntaxHighlighting.extraLanguages", schema: Type.Record(Type.String(), Type.String()), default: {}, scopes: [U, P], owner: "SPEC-IHM-004" },
  { key: "ui.diff.contextLines", schema: int(0, 20), default: 3, scopes: [U, P], owner: "SPEC-IHM-005" },
  { key: "ui.diff.layout", schema: enumOf(["auto", "side-by-side", "stacked"]), default: "auto", scopes: [U], owner: "SPEC-IHM-005" },
  { key: "ui.diff.maxDisplayedLines", schema: int(10, 1_000_000), default: 500, scopes: [U], owner: "SPEC-IHM-005" },
  { key: "ui.diff.intralineHighlight", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-005" },
  { key: "ui.diff.showInvisibleChanges", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-005" },
  // SPEC-IHM-010: pastes and attachments; SPEC-IHM-012: shell mode (lot 5; values in English, gap E-098).
  { key: "ui.paste.collapseThreshold", schema: int(10, 10_000_000), default: 2_000, scopes: [U], owner: "SPEC-IHM-010" },
  { key: "ui.paste.maxChars", schema: int(100, 100_000_000), default: 500_000, scopes: [U], owner: "SPEC-IHM-010" },
  { key: "ui.paste.detectHeuristic", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-010" },
  { key: "ui.attachments.maxCount", schema: int(1, 1_000), default: 20, scopes: [U], owner: "SPEC-IHM-010" },
  { key: "ui.attachments.maxTotalBytes", schema: int(1_024, 1_000_000_000), default: 20_971_520, scopes: [U], owner: "SPEC-IHM-010" },
  { key: "ui.shellMode.enabled", schema: bool(), default: true, scopes: [U, P, G], owner: "SPEC-IHM-012", restrictiveValues: [false] },
  { key: "ui.shellMode.addToContext", schema: enumOf(["always", "ask", "never"]), default: "always", scopes: [U], owner: "SPEC-IHM-012" },
  { key: "ui.shellMode.timeoutMs", schema: int(1_000, 86_400_000), default: 120_000, scopes: [U], owner: "SPEC-IHM-012" },
  { key: "ui.shellMode.maxOutputBytes", schema: int(1_024, 100_000_000), default: 65_536, scopes: [U], owner: "SPEC-IHM-012" },
  // SPEC-IHM-006: full-screen view of the transcript (lot 5; values in English, gap E-099).
  { key: "ui.transcript.defaultDetail", schema: enumOf(["summary", "normal", "full"]), default: "normal", scopes: [U], owner: "SPEC-IHM-006" },
  { key: "ui.transcript.collapseThreshold", schema: int(1, 100_000), default: 20, scopes: [U], owner: "SPEC-IHM-006" },
  { key: "ui.transcript.showThinking", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-006" },
  // SPEC-IHM-013: modal editing (lot 5; values in English, gap E-099).
  { key: "ui.input.editMode", schema: enumOf(["standard", "modal"]), default: "standard", scopes: [U], owner: "SPEC-IHM-013" },
  { key: "ui.input.modalStartMode", schema: enumOf(["insert", "normal"]), default: "insert", scopes: [U], owner: "SPEC-IHM-013" },
  { key: "ui.input.modalCountLimit", schema: int(1, 100_000), default: 999, scopes: [U], owner: "SPEC-IHM-013" },
  // SPEC-IHM-014: key bindings; SPEC-CMD-001: commands (lot 5).
  { key: "ui.keybindings.bindings", schema: Type.Record(Type.String(), Type.Union([Type.String(), Type.Array(Type.String())])), default: {}, scopes: [U], owner: "SPEC-IHM-014" },
  { key: "ui.keybindings.showFooterHints", schema: bool(), default: true, scopes: [U], owner: "SPEC-IHM-014" },
  { key: "ui.keybindings.strictConflicts", schema: bool(), default: false, scopes: [U], owner: "SPEC-IHM-014" },
  { key: "commands.disabled", schema: strList(), default: [], scopes: [U, P, G], owner: "SPEC-CMD-001", merge: "concat" },
  { key: "commands.createInstructions.guided", schema: bool(), default: false, scopes: [U, G], owner: "SPEC-CMD-033" },
  { key: "commands.allowProjectCommands", schema: bool(), default: true, scopes: [U, P, G], owner: "SPEC-CMD-001", restrictiveValues: [false] },

  // Options forbidden by the managed policy (SPEC-MOD-011 § 11, decision D-13, gap E-029).
  { key: "policy.forbiddenOptions", schema: strList(), default: [], scopes: [G], owner: "SPEC-MOD-011", merge: "concat" },
];

export const SETTING_BY_KEY: ReadonlyMap<string, SettingDef> = new Map(SETTINGS.map((d) => [d.key, d]));

/** True when `key` is a declared key or the parent of declared keys. */
export function isKnownPrefix(key: string): boolean {
  for (const k of SETTING_BY_KEY.keys()) if (k === key || k.startsWith(`${key}.`)) return true;
  return false;
}
