// Implements: SPEC-BLD-002 (single registry, known profiles, descriptions, inventory).
// Supports: SPEC-BLD-003 (disabled feature markers), gap E-144.
export const BUILD_PROFILES = ["public", "internal", "development", "test"] as const;
export type BuildProfile = (typeof BUILD_PROFILES)[number];
const option = (value: boolean, description: string, specs: string[], absentMarkers: string[] = []) => ({ description, specs, implemented: value, values: { public: value, internal: value, development: value, test: value }, absentMarkers });
export const BUILD_OPTIONS = {
  automation_scripts: option(true, "Flux déclaratifs avec permissions et tâches de fond.", ["SPEC-PLA-003", "SPEC-PLA-004", "SPEC-OUT-042", "SPEC-CMD-077"], ["Run a named, validated workflow"]),
  mode_brief: option(true, "Vue des messages adressés avec accès au détail.", ["SPEC-MOD-029", "SPEC-OUT-034", "SPEC-CMD-007"]),
  skill_discovery: option(true, "Sélection locale des compétences pertinentes.", ["SPEC-OUT-038"]),
  connector_published_skills: option(true, "Compétences publiées par les connecteurs autorisés.", ["SPEC-MCP-014"], ["Remote skill unavailable:"]),
  connector_structured_display: option(true, "Tableaux bornés pour les résultats structurés de connecteurs.", ["SPEC-MCP-015"], ["[Sortie repliée ; contenu brut dans le détail.]"]),
  push_notifications: option(true, "Notifications locales bornées demandées par l’agent.", ["SPEC-OUT-036"], ["Send a brief device notification only"]),
  ui_auto_theme: option(true, "Suivi de la couleur de fond du terminal.", ["SPEC-IHM-020"], ["Automatique selon le terminal"]),
  review_artifact: option(true, "Décisions humaines sur les constats de revue.", ["SPEC-OUT-045"]),
  ui_fast_find: option(true, "Navigation par fichier et recherche locale au clavier.", ["SPEC-IHM-015", "SPEC-IHM-018"], ["Ouverture rapide", "Recherche globale"]),
  ui_history_browser: option(true, "Sélecteur filtrable de l’historique des saisies.", ["SPEC-IHM-016"], ["Filtrer mes saisies"]),
  ui_message_menu: option(true, "Copie et reprise des messages en vue plein écran.", ["SPEC-IHM-017", "SPEC-IHM-034"], ["Copier le bloc"]),
  ui_dev_bar: { ...option(true, "Dernières opérations lentes du profil de développement.", ["SPEC-IHM-039"], ["Développement ·"]), values: { public: false, internal: true, development: true, test: true } },
  hook_questions: option(true, "Questions humaines posées par les crochets synchrones.", ["SPEC-HOK-011"], ["Question du crochet"]),
  scheduled_triggers: option(true, "Déclencheurs locaux et outils de planification.", ["SPEC-PLA-001", "SPEC-PLA-005", "SPEC-OUT-031"], ["Create a local scheduled prompt", "List the local scheduled prompts"]),
  agent_explorer_planner: option(true, "Agents intégrés d’exploration et de planification en lecture seule.", ["SPEC-AGT-003"], ["You are the repository explorer", "You are the implementation planner"]),
  agent_verifier: option(true, "Agent intégré de vérification avec preuves observées.", ["SPEC-AGT-004"], ["You are the independent feature verifier"]),
  permission_auto_approve: option(true, "Approbation automatique avec consentement et classifieur.", ["SPEC-PER-004", "SPEC-PER-018"], ["You are the approval classifier for a coding session", "The complete action is too large for an approval decision"]),
  permission_auto_approve_powershell: option(false, "Classifieur d’approbation pour PowerShell.", ["SPEC-PER-005"]),
  shell_classifier: option(false, "Classifieur de commandes shell.", ["SPEC-PER-006"]),
  shell_syntax_analysis: option(false, "Analyse syntaxique des commandes shell.", ["SPEC-PER-007"]),
  compaction_on_overflow: option(true, "Compaction après dépassement de contexte.", ["SPEC-MOT-016"]),
  context_compaction_notices: option(true, "Rappels de franchissement et de compaction.", ["SPEC-MOT-018"]),
  history_pruning: option(true, "Projection des résultats élagués et reprise.", ["SPEC-MOT-019", "SPEC-OUT-043"], ["Remove the bodies of obsolete tool results"]),
  context_token_target: option(true, "Objectif de volume de travail en jetons de sortie.", ["SPEC-MOT-022"]),
  cache_miss_diagnostics: option(true, "Détection de pertes de cache non expiré.", ["SPEC-MOT-034"]),
  thinking_max_keyword: option(true, "Réflexion maximale pour un seul tour.", ["SPEC-MOT-024"]),
  context_overflow_probe: { ...option(true, "Résultat volumineux déterministe, réservé aux tests.", ["SPEC-OUT-048"], ["Generate a deterministic context overflow probe"]), values: { public: false, internal: false, development: false, test: true } },
  permission_test: { ...option(true, "Vérification sans effet du circuit de permission.", ["SPEC-OUT-049"], ["Exercise the ordinary permission circuit"]), values: { public: false, internal: false, development: false, test: true } },
  telemetry_enhanced: option(true, "Traces enrichies sur double consentement, en bêta.", ["SPEC-OBS-005"], ["tool.input.bytes", "tool.output.bytes"]),
  telemetry_orchestrator_role: { ...option(true, "Étiquette du rôle de collaboration dans les diagnostics.", ["SPEC-OBS-007"], ["orchestrator.role"]), values: { public: false, internal: true, development: true, test: true } },
  memory_auto_extraction: option(true, "Extraction automatique de mémoire.", ["SPEC-MOT-038"], ["Update only durable project memories in the designated memory folder"]),
  agent_forked: option(true, "Agent issu d’une copie de contexte.", ["SPEC-AGT-010"], ["start a fork of the caller's complete conversation"]),
  stream_compact_profile: option(true, "Profil compact du flux de sortie.", ["SPEC-OBS-022"], ["tool_summary"]),
  strict_failure: { ...option(true, "Arrêt à la première erreur journalisée.", ["SPEC-OBS-014"], ["STRICT-FAILURE:"]), values: { public: false, internal: true, development: true, test: true } },
  system_instructions_export: { ...option(true, "Export des instructions système.", ["SPEC-OBS-019"], ["Export non masqué des instructions système"]), values: { public: false, internal: true, development: true, test: true } },
} as const;
export type BuildFlagName = keyof typeof BUILD_OPTIONS;
export type BuildValues = Readonly<Record<BuildFlagName, boolean>>;

export function resolveBuildOptions(profile: string, overrides: unknown = {}): BuildValues {
  if (!BUILD_PROFILES.includes(profile as BuildProfile)) throw new Error(`Profil de build inconnu : ${profile}.`);
  if (!overrides || typeof overrides !== "object" || Array.isArray(overrides)) throw new Error("Objet d’options de build attendu.");
  const values = Object.fromEntries(Object.entries(BUILD_OPTIONS).map(([name, definition]) => [name, definition.values[profile as BuildProfile]])) as Record<BuildFlagName, boolean>;
  for (const [name, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(BUILD_OPTIONS, name)) throw new Error(`Option de build inconnue : ${name}.`);
    if (typeof value !== "boolean") throw new Error(`Valeur booléenne attendue pour ${name}.`);
    if (value && profile === "public" && ["telemetry_orchestrator_role", "ui_dev_bar", "strict_failure", "system_instructions_export"].includes(name)) throw new Error(`Option réservée aux profils internes : ${name}.`);
    if (value && profile !== "test" && ["permission_test", "context_overflow_probe"].includes(name)) throw new Error(`Option réservée au profil de test : ${name}.`);
    if (value && !BUILD_OPTIONS[name as BuildFlagName].implemented) throw new Error(`Option de build réservée, fonctionnalité non livrée : ${name}.`);
    values[name as BuildFlagName] = value;
  }
  return Object.freeze(values);
}
