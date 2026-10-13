// Implements: SPEC-BLD-002 (single registry, known profiles, descriptions, inventory).
// Supports: SPEC-BLD-003 (disabled feature markers), gap E-144.
export const BUILD_PROFILES = ["public", "internal", "development", "test"] as const;
export type BuildProfile = (typeof BUILD_PROFILES)[number];
const option = (value: boolean, description: string, specs: string[], absentMarkers: string[] = []) => ({ description, specs, implemented: value, values: { public: value, internal: value, development: value, test: value }, absentMarkers });
export const BUILD_OPTIONS = {
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
  memory_auto_extraction: option(false, "Extraction automatique de mémoire.", ["SPEC-MOT-038"]),
  agent_forked: option(false, "Agent issu d’une copie de contexte.", ["SPEC-AGT-010"]),
  stream_compact_profile: option(true, "Profil compact du flux de sortie.", ["SPEC-OBS-022"], ["tool_summary"]),
  system_instructions_export: option(false, "Export des instructions système.", ["SPEC-OBS-019"]),
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
    if (value && !BUILD_OPTIONS[name as BuildFlagName].implemented) throw new Error(`Option de build réservée, fonctionnalité non livrée : ${name}.`);
    values[name as BuildFlagName] = value;
  }
  return Object.freeze(values);
}
