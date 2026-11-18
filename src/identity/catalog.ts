// Implements: SPEC-CAD-002 (§ 6.3 normative variable catalogue)
// Every brand-dependent value used by the product is declared here, never hard-coded elsewhere.

export type VariableKind = "primary" | "derived" | "optional";

export type VariableType =
  | "text" // free text, possibly localized
  | "identifier" // technical identifier
  | "domain"
  | "path"
  | "filename"
  | "url"
  | "color"
  | "email"
  | "resource" // binary resource referenced by a path relative to the identity file (EF-04)
  | "modelTier" // { label, ids }
  | "tierRef"; // reference to a model tier variable

export type Section =
  | "identity"
  | "locations"
  | "identifiers"
  | "profiles"
  | "models"
  | "services"
  | "git"
  | "visual"
  | "texts";

export interface VariableDef {
  readonly name: string;
  readonly section: Section;
  readonly kind: VariableKind;
  readonly type: VariableType;
  /** Derivation template (for derived variables) or default (for optional ones). May be localized. */
  readonly derive?: string | Readonly<Record<string, string>>;
  /** Constraint on the resolved value. */
  readonly pattern?: RegExp;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly localizable?: boolean;
  /** Runtime-overridable (RG-03): service URLs and default model tiers only. */
  readonly overridable?: boolean;
  /** Human-readable reminder of the constraint, used in ERR-05 messages. */
  readonly constraint?: string;
}

const SLUG = /^[a-z][a-z0-9-]{1,31}$/;
const SLUG_TEXT = "^[a-z][a-z0-9-]{1,31}$";

export { MODEL_TIERS, type ModelTier } from "./runtime-catalog";

export const VARIABLES: readonly VariableDef[] = [
  // 6.3.1 Identity
  { name: "SOCIETY", section: "identity", kind: "primary", type: "text", localizable: true, minLength: 1, maxLength: 64 },
  { name: "SOCIETY_LEGAL", section: "identity", kind: "derived", type: "text", derive: "{{SOCIETY}}", minLength: 1, maxLength: 128 },
  { name: "SOCIETY_SLUG", section: "identity", kind: "derived", type: "identifier", derive: "{{SOCIETY|kebab}}", pattern: SLUG, constraint: SLUG_TEXT },
  { name: "SOCIETY_DOMAIN", section: "identity", kind: "primary", type: "domain", pattern: /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, constraint: "nom de domaine valide" },
  { name: "PRODUCT", section: "identity", kind: "primary", type: "text", localizable: true, minLength: 1, maxLength: 32 },
  { name: "PRODUCT_SLUG", section: "identity", kind: "derived", type: "identifier", derive: "{{PRODUCT|kebab}}", pattern: SLUG, constraint: SLUG_TEXT },
  { name: "PRODUCT_CLI", section: "identity", kind: "derived", type: "identifier", derive: "{{PRODUCT_SLUG}}", pattern: SLUG, constraint: SLUG_TEXT },
  { name: "PRODUCT_BUNDLE_ID", section: "identity", kind: "derived", type: "identifier", pattern: /^[a-z0-9]+(\.[a-z0-9-]+)+$/, constraint: "^[a-z0-9]+(\\.[a-z0-9-]+)+$" },
  { name: "PRODUCT_TAGLINE", section: "identity", kind: "optional", type: "text", localizable: true, maxLength: 120 },
  { name: "ASSISTANT_NAME", section: "identity", kind: "derived", type: "text", localizable: true, derive: "{{PRODUCT}}" },

  // 6.3.2 Locations
  { name: "CONFIG_DIR", section: "locations", kind: "derived", type: "path", derive: "~/.{{PRODUCT_SLUG}}", pattern: /^(~\/|\/|[A-Za-z]:[\\/])/, constraint: "commence par ~/ ou est absolu" },
  { name: "USER_STATE_FILE", section: "locations", kind: "derived", type: "path", derive: "{{CONFIG_DIR}}/state.json", pattern: /^(~\/|\/|[A-Za-z]:[\\/])/, constraint: "commence par ~/ ou est absolu" },
  { name: "PROJECT_DIR", section: "locations", kind: "derived", type: "filename", derive: ".{{PRODUCT_SLUG}}", pattern: /^[^\\/]+$/, constraint: "nom simple, sans séparateur" },
  { name: "INSTRUCTIONS_FILE", section: "locations", kind: "derived", type: "filename", derive: "{{PRODUCT_SLUG}}.instructions.md", pattern: /^[^\\/]+\.md$/, constraint: "se termine par .md" },
  { name: "LOCAL_INSTRUCTIONS_FILE", section: "locations", kind: "derived", type: "filename", derive: "{{PRODUCT_SLUG}}.instructions.local.md", pattern: /^[^\\/]+\.md$/, constraint: "se termine par .md" },
  { name: "MEMORY_INDEX_FILE", section: "locations", kind: "derived", type: "filename", derive: "{{PRODUCT_SLUG|const}}.memory.md", pattern: /^[^\\/]+\.md$/, constraint: "se termine par .md" },
  { name: "LIVING_DOC_HEADER", section: "locations", kind: "derived", type: "text", derive: "# {{PRODUCT_SLUG|const}} LIVING DOC:", pattern: /^#[^\n]*$/, constraint: "commence par #, une seule ligne" },
  { name: "MANAGED_DIR_LINUX", section: "locations", kind: "derived", type: "path", derive: "/etc/{{PRODUCT_SLUG}}", pattern: /^\//, constraint: "absolu" },
  { name: "MANAGED_DIR_MACOS", section: "locations", kind: "derived", type: "path", derive: "/Library/Application Support/{{PRODUCT}}", pattern: /^\//, constraint: "absolu" },
  { name: "MANAGED_DIR_WINDOWS", section: "locations", kind: "derived", type: "path", derive: "C:\\ProgramData\\\\{{PRODUCT}}" /* gap E-036 */, pattern: /^[A-Za-z]:\\/, constraint: "absolu" },
  { name: "MANAGED_POLICY_DOMAIN", section: "locations", kind: "derived", type: "identifier", derive: "{{PRODUCT_BUNDLE_ID}}" },
  { name: "MANAGED_REGISTRY_KEY", section: "locations", kind: "derived", type: "text", derive: "SOFTWARE\\Policies\\\\{{SOCIETY}}\\\\{{PRODUCT}}" /* gap E-036 */, pattern: /^(?!HK)/, constraint: "sans ruche en préfixe" },
  { name: "INSTALL_DIR", section: "locations", kind: "derived", type: "path", derive: "~/.local/share/{{PRODUCT_SLUG}}" },
  { name: "BIN_LINK", section: "locations", kind: "derived", type: "path", derive: "~/.local/bin/{{PRODUCT_CLI}}" },
  { name: "TEMP_PREFIX", section: "locations", kind: "derived", type: "identifier", derive: "{{PRODUCT_SLUG}}-", pattern: /^[a-z0-9-]+$/, constraint: "^[a-z0-9-]+$" },

  // 6.3.3 Technical identifiers
  { name: "ENV_PREFIX", section: "identifiers", kind: "derived", type: "identifier", derive: "{{PRODUCT_SLUG|const}}_", pattern: /^[A-Z][A-Z0-9_]*_$/, constraint: "^[A-Z][A-Z0-9_]*_$" },
  { name: "URL_SCHEME", section: "identifiers", kind: "derived", type: "identifier", derive: "{{PRODUCT_SLUG}}", pattern: /^[a-z][a-z0-9+.-]*$/, constraint: "^[a-z][a-z0-9+.-]*$" },
  { name: "HINT_TAG", section: "identifiers", kind: "derived", type: "identifier", derive: "{{PRODUCT_SLUG}}-hint", pattern: /^[a-z][a-z0-9-]*$/, constraint: "^[a-z][a-z0-9-]*$" },
  { name: "KEYCHAIN_SERVICE", section: "identifiers", kind: "derived", type: "text", derive: "{{PRODUCT}} credentials" },
  { name: "NATIVE_HOST_NAME", section: "identifiers", kind: "derived", type: "identifier", derive: "{{PRODUCT_BUNDLE_ID|snake}}.browser_host" /* gap E-028: the "lower" derivation of § 6.3.3 breaks the constraint for hyphenated slugs */, pattern: /^[a-z0-9_.]+$/, constraint: "^[a-z0-9_.]+$" },
  { name: "SELF_MCP_SERVER_NAME", section: "identifiers", kind: "derived", type: "identifier", derive: "{{PRODUCT_SLUG}}" },
  { name: "USER_AGENT", section: "identifiers", kind: "derived", type: "text", derive: "{{PRODUCT_CLI}}/<version>" },
  { name: "HTTP_HEADER_PREFIX", section: "identifiers", kind: "derived", type: "identifier", derive: "x-{{PRODUCT_SLUG}}-", pattern: /^[a-z0-9-]+$/, constraint: "minuscules" },
  { name: "TELEMETRY_EVENT_PREFIX", section: "identifiers", kind: "derived", type: "identifier", derive: "{{PRODUCT_SLUG|snake}}_", pattern: /^[a-z][a-z0-9_]*_$/, constraint: "^[a-z][a-z0-9_]*_$" },
  { name: "PROCESS_TITLE", section: "identifiers", kind: "derived", type: "text", derive: "{{PRODUCT_CLI}}" },
  { name: "PACKAGE_NAME", section: "identifiers", kind: "derived", type: "identifier", derive: "@{{SOCIETY_SLUG}}/{{PRODUCT_SLUG}}", pattern: /^@[a-z0-9-]+\/[a-z0-9-]+$/, constraint: "règles du registre de paquets" },

  // 6.3.4 Profiles
  { name: "INTERNAL_PROFILE", section: "profiles", kind: "derived", type: "identifier", derive: "internal", pattern: /^[a-z][a-z0-9-]*$/, constraint: "^[a-z][a-z0-9-]*$" },

  // 6.3.5 Model tiers (at least one tier is required; checked by the resolver)
  { name: "MODEL_LARGE", section: "models", kind: "optional", type: "modelTier" },
  { name: "MODEL_MEDIUM", section: "models", kind: "optional", type: "modelTier" },
  { name: "MODEL_SMALL", section: "models", kind: "optional", type: "modelTier" },
  { name: "MODEL_DEFAULT", section: "models", kind: "derived", type: "tierRef", overridable: true },
  { name: "MODEL_BACKGROUND", section: "models", kind: "derived", type: "tierRef", overridable: true },

  // 6.3.6 Services (https only, localhost allowed in development)
  ...(
    [
      ["SERVICE_DOCS", "primary"],
      ["SERVICE_DOWNLOADS", "primary"],
      ["SERVICE_SUPPORT", "optional"],
      ["SERVICE_FEEDBACK", "optional"],
      ["SERVICE_STATUS", "optional"],
      ["SERVICE_TERMS", "optional"],
      ["SERVICE_PRIVACY", "optional"],
      ["SERVICE_RELEASE_NOTES", "optional"],
      ["SERVICE_CONSOLE", "optional"],
      ["SERVICE_WEB_APP", "optional"],
      ["SERVICE_OAUTH_AUTHORIZE", "optional"],
      ["SERVICE_OAUTH_TOKEN", "optional"],
      ["SERVICE_REMOTE_SESSIONS", "optional"],
      ["SERVICE_SPEECH_TO_TEXT", "optional"],
      ["SERVICE_TELEMETRY", "optional"],
      ["SERVICE_FEATURE_FLAGS", "optional"],
      ["SERVICE_ERROR_REPORTING", "optional"],
      ["SERVICE_MARKETPLACE", "optional"],
      ["SERVICE_MCP_REGISTRY", "optional"],
    ] as const
  ).map(([name, kind]): VariableDef => ({ name, section: "services", kind, type: "url", overridable: true })),
  { name: "OAUTH_CLIENT_ID", section: "services", kind: "optional", type: "identifier", overridable: true },
  ...(
    [
      "SERVICE_DESKTOP_APP",
      "SERVICE_MOBILE_IOS",
      "SERVICE_MOBILE_ANDROID",
      "SERVICE_BROWSER_EXTENSION",
      "SERVICE_MERCH",
    ] as const
  ).map((name): VariableDef => ({ name, section: "services", kind: "optional", type: "url" })),
  ...(["IDE_EXTENSION_ID_VSCODE", "IDE_PLUGIN_ID_JETBRAINS", "GIT_FORGE_APP", "TEAM_CHAT_APP"] as const).map(
    (name): VariableDef => ({ name, section: "services", kind: "optional", type: "identifier" }),
  ),

  // 6.3.7 Git attribution
  { name: "GIT_COAUTHOR_NAME", section: "git", kind: "derived", type: "text", derive: "{{PRODUCT}}" },
  { name: "GIT_COAUTHOR_EMAIL", section: "git", kind: "derived", type: "email", derive: "noreply@{{SOCIETY_DOMAIN}}", pattern: /^[^@\s]+@[^@\s]+$/, constraint: "adresse électronique" },
  {
    name: "PR_FOOTER",
    section: "git",
    kind: "derived",
    type: "text",
    localizable: true,
    derive: { fr: "Généré avec {{PRODUCT}} ({{SERVICE_DOCS}})", en: "Generated with {{PRODUCT}} ({{SERVICE_DOCS}})" },
  },
  { name: "BRANCH_PREFIX", section: "git", kind: "derived", type: "text", derive: "{{PRODUCT_SLUG}}/" },

  // 6.3.8 Visual identity
  { name: "BRAND_COLOR_PRIMARY", section: "visual", kind: "primary", type: "color", pattern: /^#[0-9A-Fa-f]{6}$/, constraint: "#RRGGBB" },
  { name: "BRAND_COLOR_ACCENT", section: "visual", kind: "derived", type: "color", derive: "{{BRAND_COLOR_PRIMARY}}", pattern: /^#[0-9A-Fa-f]{6}$/, constraint: "#RRGGBB" },
  { name: "ICON", section: "visual", kind: "optional", type: "resource", pattern: /^(?![\\/]|[A-Za-z]:)(?!(?:.*[\\/])?\.\.(?:[\\/]|$))[^\u0000-\u001f]+\.(?:svg|png)$/i, constraint: "un chemin relatif au fichier d'identité, sans `..`, vers un fichier .svg ou .png" },
  { name: "LOGO_TEXT", section: "visual", kind: "optional", type: "text", derive: "{{PRODUCT|upper}}" },
  { name: "COMPANION_NAME", section: "visual", kind: "optional", type: "text", localizable: true },

  // 6.3.9 Brand texts
  {
    name: "IDENTITY_STATEMENT",
    section: "texts",
    kind: "derived",
    type: "text",
    localizable: true,
    derive: {
      fr: "Tu es {{ASSISTANT_NAME}}, l'assistant de développement de {{SOCIETY}}.",
      en: "You are {{ASSISTANT_NAME}}, the software development assistant of {{SOCIETY}}.",
    },
  },
  { name: "WELCOME_MESSAGE", section: "texts", kind: "optional", type: "text", localizable: true, derive: { fr: "Bienvenue dans {{PRODUCT}}", en: "Welcome to {{PRODUCT}}" } },
  { name: "LEGAL_NOTICE", section: "texts", kind: "optional", type: "text", localizable: true },
];

export const VARIABLE_BY_NAME: ReadonlyMap<string, VariableDef> = new Map(VARIABLES.map((v) => [v.name, v]));

/** Variables that may be overridden at runtime (RG-03). */
export function isOverridable(name: string): boolean {
  return VARIABLE_BY_NAME.get(name)?.overridable === true;
}
