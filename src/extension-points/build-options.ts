// Implements: SPEC-BLD-002 (single registry, known profiles, descriptions, inventory).
// Supports: SPEC-BLD-003 (disabled feature markers), gap E-144.
export const BUILD_PROFILES = ["public", "internal", "development", "test"] as const;
export type BuildProfile = (typeof BUILD_PROFILES)[number];
const option = (value: boolean, description: string, specs: string[], absentMarkers: string[] = []) => ({ description, specs, implemented: value, values: { public: value, internal: value, development: value, test: value }, absentMarkers });
export const BUILD_OPTIONS = {
  agent_explorer_planner: option(true, "Agents intégrés d’exploration et de planification en lecture seule.", ["SPEC-AGT-003"], ["You are the repository explorer", "You are the implementation planner"]),
  agent_verifier: option(true, "Agent intégré de vérification avec preuves observées.", ["SPEC-AGT-004"], ["You are the independent feature verifier"]),
  permission_auto_approve: option(true, "Approbation automatique avec consentement et classifieur.", ["SPEC-PER-004", "SPEC-PER-018"], ["You are the approval classifier for a coding session", "The complete action is too large for an approval decision"]),
  permission_auto_approve_powershell: option(false, "Classifieur d’approbation pour PowerShell.", ["SPEC-PER-005"]),
  shell_classifier: option(false, "Classifieur de commandes shell.", ["SPEC-PER-006"]),
  shell_syntax_analysis: option(false, "Analyse syntaxique des commandes shell.", ["SPEC-PER-007"]),
  compaction_on_overflow: option(false, "Compaction après dépassement de contexte.", ["SPEC-MOT-016"]),
  context_token_target: option(false, "Cible dynamique de taille du contexte.", ["SPEC-MOT-022"]),
  memory_auto_extraction: option(false, "Extraction automatique de mémoire.", ["SPEC-MOT-038"]),
  agent_forked: option(false, "Agent issu d’une copie de contexte.", ["SPEC-AGT-010"]),
  stream_compact_profile: option(false, "Profil compact du flux de sortie.", ["SPEC-OBS-022"]),
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
