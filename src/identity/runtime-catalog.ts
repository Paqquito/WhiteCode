// Implements: SPEC-CAD-002 (RG-03 runtime-overridable variables, EF-30 no unresolved template in a deliverable)
// Runtime view of the variable catalogue: names and kinds only. Derivation templates stay in the build-time catalogue.

export const MODEL_TIERS = ["MODEL_LARGE", "MODEL_MEDIUM", "MODEL_SMALL"] as const;
export type ModelTier = (typeof MODEL_TIERS)[number];

/** Service URLs overridable at runtime (§ 6.3.6, column S). */
export const OVERRIDABLE_SERVICE_URLS: readonly string[] = [
  "SERVICE_DOCS", "SERVICE_DOWNLOADS", "SERVICE_SUPPORT", "SERVICE_FEEDBACK", "SERVICE_STATUS", "SERVICE_TERMS",
  "SERVICE_PRIVACY", "SERVICE_RELEASE_NOTES", "SERVICE_CONSOLE", "SERVICE_WEB_APP", "SERVICE_OAUTH_AUTHORIZE",
  "SERVICE_OAUTH_TOKEN", "SERVICE_REMOTE_SESSIONS", "SERVICE_SPEECH_TO_TEXT", "SERVICE_TELEMETRY",
  "SERVICE_FEATURE_FLAGS", "SERVICE_ERROR_REPORTING", "SERVICE_MARKETPLACE", "SERVICE_MCP_REGISTRY",
];

export const OVERRIDABLE_VARIABLES: ReadonlySet<string> = new Set([...OVERRIDABLE_SERVICE_URLS, "OAUTH_CLIENT_ID", "MODEL_DEFAULT", "MODEL_BACKGROUND"]);

export function isOverridable(name: string): boolean {
  return OVERRIDABLE_VARIABLES.has(name);
}

export function isServiceUrl(name: string): boolean {
  return OVERRIDABLE_SERVICE_URLS.includes(name) || name.startsWith("SERVICE_");
}
