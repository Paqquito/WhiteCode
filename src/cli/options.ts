// Implements: SPEC-MOD-011 (§ 5.1 naming, § 5.3 catalogue, combinations), SPEC-MOD-012 (§ 5.3 families), decisions D-03, D-05, D-06
// Declarative catalogue of global options: the single source of the parser, of the help and of the danger banner.

import { FAMILY_CATALOG } from "./families";

export type OptionValue = "none" | "required" | "optional";
export const DEBUG_DOMAINS = ["api", "mcp", "hooks", "permissions", "tools", "config", "render", "remote", "context", "engine", "control", "agents", "startup", "maintenance", "commands", "serve"] as const;
export type OptionType = "string" | "integer" | "amount" | "seconds" | "enum" | "list" | "rules" | "path-or-content" | "path";

export interface OptionDef {
  readonly name: string;
  readonly value: OptionValue;
  readonly type?: OptionType;
  readonly enumValues?: readonly string[];
  /** Enum values delivered in this version (the others are recognised but refused as not delivered). */
  readonly deliveredValues?: readonly string[];
  readonly repeatable?: boolean;
  readonly group: string;
  readonly description: string;
  readonly defaultText?: string;
  /** Lifts a protection (RN-C, EF-04): announced at start-up. */
  readonly danger?: boolean;
  readonly delivered: boolean;
  readonly hidden?: boolean;
  readonly owner: string;
}

const MODES = ["ask", "planning", "auto_edit", "no_prompt", "auto_approve", "unrestricted"];

export const OPTIONS: readonly OptionDef[] = [
  // Session and execution
  { name: "non-interactive", value: "none", group: "Session et exécution", description: "Exécution automatisée, sans interface.", delivered: true, owner: "SPEC-MOD-002" },
  { name: "reopen-last", value: "none", group: "Session et exécution", description: "Reprend la dernière session du dossier courant.", delivered: true, owner: "SPEC-SES-002" },
  { name: "reopen", value: "optional", type: "string", group: "Session et exécution", description: "Reprend une session désignée (--reopen=<id>), ou propose une sélection.", delivered: true, owner: "SPEC-SES-002" },
  { name: "reopen-at", value: "required", type: "string", group: "Session et exécution", description: "Reprend à un point donné de l'historique.", delivered: true, owner: "SPEC-SES-004" },
  { name: "reopen-as-copy", value: "none", group: "Session et exécution", description: "Reprend en créant une session dérivée.", delivered: true, owner: "SPEC-SES-003" },
  { name: "assign-session-id", value: "required", type: "string", group: "Session et exécution", description: "Impose l'identifiant de la session créée.", delivered: true, owner: "SPEC-SES-001" },
  { name: "ephemeral", value: "none", group: "Session et exécution", description: "N'enregistre pas la session.", delivered: true, owner: "SPEC-SES-012" },
  { name: "remote-session", value: "required", type: "string", group: "Session et exécution", description: "Crée une session distante.", delivered: false, owner: "SPEC-MOD-014" },
  { name: "reopen-remote", value: "optional", type: "string", group: "Session et exécution", description: "Rapatrie une session distante.", delivered: false, owner: "SPEC-MOD-015" },
  { name: "background", value: "required", type: "string", group: "Session et exécution", description: "Lance une session d'arrière-plan.", delivered: false, owner: "SPEC-MOD-022" },
  { name: "orchestrator", value: "none", group: "Session et exécution", description: "Active le mode coordinateur.", delivered: false, owner: "SPEC-MOD-028" },
  { name: "max-iterations", value: "required", type: "integer", group: "Session et exécution", description: "Nombre maximal d'itérations (allers-retours avec le modèle).", defaultText: "50 en exécution automatisée", delivered: true, owner: "SPEC-MOD-005" },
  { name: "max-cost", value: "required", type: "amount", group: "Session et exécution", description: "Plafond de coût de l'exécution, montant à point décimal sans devise (ex. 2.50).", delivered: true, owner: "SPEC-MOD-005" },
  { name: "max-duration", value: "required", type: "seconds", group: "Session et exécution", description: "Durée maximale, en secondes.", delivered: true, owner: "SPEC-MOD-005" },
  { name: "wait-for-capacity", value: "none", group: "Session et exécution", description: "Patiente en cas de saturation au lieu d'échouer.", delivered: false, owner: "SPEC-API-004" },
  { name: "dry-run", value: "none", group: "Session et exécution", description: "Avec --reopen et --restore-files seulement : plan de restauration sans effet.", delivered: true, owner: "SPEC-SES-007" },
  { name: "restore-files", value: "required", type: "string", group: "Session et exécution", description: "Avec --reopen : rétablit l'état des fichiers au message indiqué.", delivered: true, owner: "SPEC-SES-007" },
  { name: "allow-external-overwrite", value: "required", type: "string", group: "Session et exécution", description: "Consentement à écraser les conflits externes du plan d'empreinte donnée.", danger: true, delivered: true, owner: "SPEC-SES-006" },

  // Model and service
  { name: "model", value: "required", type: "string", group: "Modèle et service", description: "Modèle principal (alias de gamme ou identifiant).", defaultText: "configuration", delivered: true, owner: "SPEC-API-006" },
  { name: "backup-model", value: "required", type: "string", group: "Modèle et service", description: "Modèle de repli.", delivered: true, owner: "SPEC-API-005" },
  { name: "api-previews", value: "required", type: "list", group: "Modèle et service", description: "Capacités expérimentales du service à activer.", delivered: false, owner: "SPEC-API-002" },
  { name: "api-provider", value: "required", type: "string", group: "Modèle et service", description: "Fournisseur de modèles.", delivered: false, owner: "SPEC-API-001" },

  // Input and output (decision D-06: machine-readable values in English)
  { name: "request-format", value: "required", type: "enum", enumValues: ["text", "jsonl"], group: "Entrées et sorties", description: "Format d'entrée.", defaultText: "text", delivered: true, owner: "SPEC-MOD-003" },
  { name: "result-format", value: "required", type: "enum", enumValues: ["text", "json", "jsonl"], group: "Entrées et sorties", description: "Format de sortie.", defaultText: "text", delivered: true, owner: "SPEC-MOD-003" },
  { name: "stream-profile", value: "required", type: "enum", enumValues: ["standard", "compact"], group: "Entrées et sorties", description: "Profil de présentation d'une sortie jsonl.", defaultText: "standard", delivered: false, owner: "SPEC-OBS-022" },
  { name: "output-schema", value: "required", type: "path-or-content", group: "Entrées et sorties", description: "Schéma JSON du résultat attendu (fichier ou contenu).", delivered: true, owner: "SPEC-MOD-004" },
  { name: "control-channel", value: "none", group: "Entrées et sorties", description: "Ouvre le canal de contrôle d'un programme hôte (avec --request-format jsonl et --result-format jsonl).", delivered: true, owner: "SPEC-MOD-006" },
  { name: "control-listen", value: "optional", type: "string", group: "Entrées et sorties", description: "Canal de contrôle sur une connexion persistante : attend l'hôte (--control-listen=<hôte:port>).", defaultText: "remote.transport.listenAddress", delivered: true, owner: "SPEC-MOD-007" },
  { name: "control-connect", value: "required", type: "string", group: "Entrées et sorties", description: "Canal de contrôle sur une connexion persistante : se connecte au point d'entrée de l'hôte (wss://…).", delivered: true, owner: "SPEC-MOD-007" },
  { name: "emit-partial", value: "none", group: "Entrées et sorties", description: "Émet les fragments progressifs dans le flux.", delivered: false, owner: "SPEC-MOD-003" },
  { name: "emit-hook-events", value: "none", group: "Entrées et sorties", description: "Émet les événements de crochets dans le flux.", delivered: false, owner: "SPEC-MOD-003" },
  { name: "verbose", value: "none", group: "Entrées et sorties", description: "Diagnostic détaillé sur la sortie d'erreur.", delivered: true, owner: "SPEC-MOD-011" },
  { name: "no-color", value: "none", group: "Entrées et sorties", description: "Supprime toute mise en forme colorée.", delivered: true, owner: "SPEC-MOD-011" },

  // Instructions and context
  { name: "system-instructions", value: "required", type: "string", group: "Instructions et contexte", description: "Remplace les instructions de base.", delivered: true, owner: "SPEC-MOT-004" },
  { name: "system-instructions-file", value: "required", type: "path", group: "Instructions et contexte", description: "Idem, depuis un fichier.", delivered: true, owner: "SPEC-MOT-004" },
  { name: "add-system-instructions", value: "required", type: "string", group: "Instructions et contexte", description: "Ajoute aux instructions de base.", delivered: true, owner: "SPEC-MOT-004" },
  { name: "add-system-instructions-file", value: "required", type: "path", group: "Instructions et contexte", description: "Idem, depuis un fichier.", delivered: true, owner: "SPEC-MOT-004" },
  { name: "allow-dir", value: "required", type: "path", repeatable: true, group: "Instructions et contexte", description: "Ajoute un dossier au périmètre autorisé.", danger: true, delivered: false, owner: "SPEC-PER-011" },
  { name: "lean-context", value: "none", group: "Instructions et contexte", description: "Contexte d'environnement réduit.", delivered: false, owner: "SPEC-MOT-003" },

  // Tools, permissions and hooks
  { name: "approval-mode", value: "required", type: "enum", enumValues: MODES, group: "Outils, permissions et crochets", description: "Mode de permission.", defaultText: "ask ; no_prompt en exécution automatisée", delivered: true, owner: "SPEC-PER-003" },
  { name: "allow-unrestricted-mode", value: "none", group: "Outils, permissions et crochets", description: "Rend le mode unrestricted accessible pour cette exécution.", danger: true, delivered: true, owner: "SPEC-PER-003" },
  { name: "allow-rule", value: "required", type: "rules", repeatable: true, group: "Outils, permissions et crochets", description: "Règles d'autorisation pour la session.", danger: true, delivered: true, owner: "SPEC-PER-002" },
  { name: "deny-rule", value: "required", type: "rules", repeatable: true, group: "Outils, permissions et crochets", description: "Règles de refus pour la session.", delivered: true, owner: "SPEC-PER-002" },
  { name: "toolset", value: "required", type: "list", group: "Outils, permissions et crochets", description: "Restreint les outils exposés au modèle (\"\" : aucun ; default : tous).", defaultText: "tous", delivered: true, owner: "SPEC-OUT-001" },
  { name: "no-hooks", value: "none", group: "Outils, permissions et crochets", description: "Désactive les crochets facultatifs.", delivered: true, owner: "SPEC-HOK-012" },
  { name: "permission-delegate", value: "required", type: "string", group: "Outils, permissions et crochets", description: "Outil qui décide des permissions en exécution automatisée.", delivered: false, owner: "SPEC-PER-028" },
  { name: "allow-project-trust", value: "none", group: "Outils, permissions et crochets", description: "Accorde la confiance au projet pour cette seule exécution (jamais mémorisée).", danger: true, delivered: true, owner: "SPEC-PER-016" },

  // Extensions, connectors and configuration
  { name: "config-source", value: "required", type: "path-or-content", group: "Extensions, connecteurs et configuration", description: "Source de configuration supplémentaire, prioritaire sur les fichiers.", delivered: true, owner: "SPEC-CFG-004" },
  { name: "config-scopes", value: "required", type: "list", enumValues: ["user", "project", "local"], group: "Extensions, connecteurs et configuration", description: "Restreint les portées de configuration chargées.", defaultText: "toutes", delivered: true, owner: "SPEC-CFG-001" },
  { name: "connectors", value: "required", type: "path-or-content", repeatable: true, group: "Extensions, connecteurs et configuration", description: "Déclare des connecteurs supplémentaires.", delivered: true, owner: "SPEC-MCP-001" },
  { name: "connectors-only", value: "none", group: "Extensions, connecteurs et configuration", description: "N'utilise que les connecteurs déclarés par --connectors.", delivered: true, owner: "SPEC-MCP-001" },
  { name: "wait-for-mcp", value: "none", group: "Extensions, connecteurs et configuration", description: "Attend que tous les connecteurs soient prêts.", delivered: true, owner: "SPEC-MCP-022" },
  { name: "extension-dir", value: "required", type: "path", repeatable: true, group: "Extensions, connecteurs et configuration", description: "Charge des extensions depuis un emplacement local.", delivered: true, owner: "SPEC-EXT-014" },
  { name: "extension-dir-watch", value: "none", group: "Extensions, connecteurs et configuration", description: "Recharge les extensions locales à chaque modification.", delivered: false, owner: "SPEC-EXT-014" },
  { name: "inbound-connectors", value: "required", type: "list", group: "Extensions, connecteurs et configuration", description: "Connecteurs autorisés à pousser des messages entrants.", delivered: false, owner: "SPEC-MCP-013" },
  { name: "dangerously-allow-unlisted-inbound", value: "none", group: "Extensions, connecteurs et configuration", description: "Accepte des canaux entrants hors liste autorisée.", danger: true, delivered: false, owner: "SPEC-MCP-013" },
  { name: "minimal", value: "none", delivered: true, group: "Extensions, connecteurs et configuration", description: "Session minimale : sans instructions de projet, extensions, compétences, connecteurs ni crochets non gérés.", owner: "SPEC-MOD-009" },

  // Miscellaneous
  { name: "help", value: "none", group: "Divers", description: "Affiche l'aide.", delivered: true, owner: "SPEC-MOD-011" },
  { name: "version", value: "none", group: "Divers", description: "Affiche la version.", delivered: true, owner: "SPEC-MOD-011" },
  { name: "cwd", value: "required", type: "path", group: "Divers", description: "Dossier de travail.", defaultText: "dossier courant", delivered: true, owner: "SPEC-MOD-011" },
  { name: "debug", value: "optional", type: "list", group: "Divers", description: "Active le journal de débogage (--debug <domaines>, préfixe ! pour exclure).", delivered: true, owner: "SPEC-OBS-012" },
  { name: "debug-output", value: "required", type: "string", group: "Divers", description: "Destination du journal de débogage (chemin, ou stderr).", defaultText: "fichier de la session", delivered: true, owner: "SPEC-OBS-012" },
  { name: "strict-failure", value: "none", group: "Divers", description: "Arrête le processus à toute erreur journalisée.", hidden: true, delivered: false, owner: "SPEC-OBS-014" },
  { name: "export-system-instructions", value: "none", group: "Divers", description: "Affiche les instructions système et quitte.", hidden: true, delivered: false, owner: "SPEC-OBS-019" },

  // Integrations
  { name: "connect-editor", value: "none", group: "Intégrations", description: "Se connecte à l'IDE compatible.", delivered: false, owner: "SPEC-INT-001" },
  { name: "isolated-copy", value: "optional", type: "string", group: "Intégrations", description: "Démarre dans une copie de travail isolée.", delivered: false, owner: "SPEC-INT-007" },
  { name: "multiplexer", value: "none", group: "Intégrations", description: "Avec --isolated-copy, ouvre la session dans le multiplexeur de terminal.", delivered: false, owner: "SPEC-INT-007" },
  { name: "from-merge-request", value: "required", type: "string", group: "Intégrations", description: "Reprend la session liée à une demande de fusion.", delivered: false, owner: "SPEC-INT-009" },
  { name: "browser", value: "none", group: "Intégrations", description: "Active le pilotage du navigateur.", delivered: false, owner: "SPEC-INT-011" },
];

export const OPTION_BY_NAME: ReadonlyMap<string, OptionDef> = new Map(OPTIONS.map((o) => [o.name, o]));

/** Pairs of options that cannot be used together (§ 5.3, combinations of execution modes). */
export const CONFLICTS: ReadonlyArray<readonly [string, string]> = [
  ["remote-session", "background"],
  ["remote-session", "reopen-remote"],
  ["background", "reopen-remote"],
  ...(["remote-session", "background", "reopen-remote"] as const).flatMap((a) =>
    (["reopen", "reopen-last", "restore-files"] as const).map((b) => [a, b] as const),
  ),
  ["dry-run", "allow-external-overwrite"],
  ["control-listen", "control-connect"],
];

/** Options that require another option. */
export const REQUIRES: ReadonlyArray<readonly [string, string]> = [
  ["connectors-only", "connectors"],
  ["multiplexer", "isolated-copy"],
  ["allow-external-overwrite", "restore-files"],
  ["restore-files", "reopen"],
];

/** Families of sub-commands (SPEC-MOD-012 § 5.3), from the single catalogue of `families.ts`. */
export const FAMILIES: readonly string[] = FAMILY_CATALOG.map((f) => f.name);
