// Implements: SPEC-MOD-012 (§ 5.1 structure, § 5.2 naming, § 5.3 catalogue of families and operations, § 5.4 common options, EF-01, RN-A to RN-H)
// Supports: gap E-066 (operations delivered in lot 1)

export interface OperationDef {
  /** Operation name, second level of the invocation (RN-F). */
  readonly name: string;
  /** Arguments, for the help. */
  readonly args?: string;
  readonly role: string;
  /** Delivered in this version. */
  readonly delivered?: boolean;
  /** Options of the owner sheet accepted by this operation, besides `--help` and `--verbose`. */
  readonly options?: readonly string[];
}

export interface FamilyDef {
  readonly name: string;
  readonly role: string;
  readonly operations: readonly OperationDef[];
}

const op = (name: string, role: string, extra: Partial<OperationDef> = {}): OperationDef => ({ name, role, ...extra });

/** Normative catalogue of SPEC-MOD-012 § 5.3; the behaviours belong to the owner sheets. */
export const FAMILY_CATALOG: readonly FamilyDef[] = [
  {
    name: "config",
    role: "Paramètres",
    operations: [
      op("list", "Liste les paramètres effectifs et leur source."),
      op("show", "Affiche la valeur effective d'un paramètre.", { args: "<clé>" }),
      op("set", "Définit un paramètre dans la portée choisie.", { args: "<clé> <valeur>" }),
      op("remove", "Retire un paramètre de la portée choisie.", { args: "<clé>" }),
      op("validate", "Vérifie la validité de toutes les sources de configuration, ou d'un fichier.", { args: "[<fichier>]", delivered: true, options: ["json", "scope"] }),
      op("show-sources", "Affiche les sources chargées et leur ordre de priorité."),
      op("push", "Envoie les paramètres vers l'emplacement de sauvegarde configuré."),
      op("pull", "Récupère les paramètres depuis l'emplacement de sauvegarde configuré."),
    ],
  },
  {
    name: "auth",
    role: "Identifiants",
    operations: [op("login", "Ouvre une session d'authentification."), op("logout", "Supprime les identifiants enregistrés."), op("show", "Affiche l'état d'authentification et l'expiration.")],
  },
  {
    name: "model",
    role: "Modèles",
    operations: [
      op("list", "Liste les gammes et les modèles disponibles, avec leurs capacités.", { delivered: true, options: ["json"] }),
      op("show", "Affiche les caractéristiques d'un modèle.", { args: "<nom>", delivered: true, options: ["json"] }),
    ],
  },
  {
    name: "connector",
    role: "Connecteurs",
    operations: [
      op("list", "Liste les connecteurs déclarés et leur état."),
      op("add", "Déclare un connecteur dans la portée choisie.", { args: "<nom> <déclaration>" }),
      op("show", "Affiche la déclaration et les capacités découvertes.", { args: "<nom>" }),
      op("remove", "Retire un connecteur.", { args: "<nom>" }),
      op("validate", "Vérifie le démarrage et la découverte des capacités.", { args: "<nom>" }),
      op("search", "Recherche un connecteur dans les annuaires configurés.", { args: "<terme>" }),
      op("import", "Importe des déclarations depuis une source reconnue.", { args: "<source>" }),
      op("reset-choices", "Réinitialise les décisions d'approbation de connecteurs du projet."),
    ],
  },
  { name: "connector-server", role: "Serveur de connecteur", operations: [op("start", "Lance le produit comme serveur de connecteur.")] },
  {
    name: "extension",
    role: "Extensions",
    operations: [
      op("list", "Liste les extensions installées et leur version."),
      op("add", "Installe une extension.", { args: "<référence>" }),
      op("show", "Affiche les contributions d'une extension.", { args: "<nom>" }),
      op("remove", "Désinstalle une extension.", { args: "<nom>" }),
      op("enable", "Active une extension installée.", { args: "<nom>" }),
      op("disable", "Désactive une extension installée.", { args: "<nom>" }),
      op("update", "Met à jour une ou toutes les extensions.", { args: "[<nom>]" }),
      op("rollback", "Revient à la version précédente d'une extension.", { args: "<nom>" }),
      op("validate", "Vérifie la conformité d'une extension en cours de développement.", { args: "<chemin>", delivered: true, options: ["json"] }),
    ],
  },
  {
    name: "catalog",
    role: "Catalogues d'extensions",
    operations: [
      op("list", "Liste les catalogues d'extensions configurés."),
      op("add", "Ajoute un catalogue d'extensions.", { args: "<référence>" }),
      op("update", "Actualise l'index d'un ou de tous les catalogues.", { args: "[<nom>]" }),
      op("remove", "Retire un catalogue.", { args: "<nom>" }),
    ],
  },
  {
    name: "session",
    role: "Sessions",
    operations: [
      op("list", "Liste les sessions enregistrées du dossier courant."),
      op("show", "Affiche le détail d'une session.", { args: "<identifiant>" }),
      op("export", "Exporte une session dans un format d'échange.", { args: "<identifiant>" }),
      op("read", "Écrit le contenu désigné par une référence de lecture.", { args: "<référence>" }),
      op("remove", "Supprime une session.", { args: "<identifiant>" }),
    ],
  },
  { name: "history", role: "Historique des saisies", operations: [op("remove", "Efface l'historique des saisies (--all).")] },
  { name: "storage", role: "Données locales", operations: [op("purge", "Supprime les données locales selon les règles de rétention.")] },
  { name: "project", role: "Projet courant", operations: [op("reset-choices", "Réinitialise les décisions mémorisées pour le projet courant.")] },
  { name: "diagnostic", role: "Diagnostic", operations: [op("validate", "Vérifie l'environnement et signale les anomalies."), op("repair", "Applique les corrections proposées et acceptées.")] },
  {
    name: "installation",
    role: "Installation",
    operations: [op("show", "Affiche la version et les informations de construction."), op("update", "Met à jour l'outil."), op("remove", "Désinstalle l'outil.")],
  },
  { name: "integration", role: "Intégrations", operations: [op("add", "Installe une intégration d'environnement de développement.", { args: "<cible>" })] },
  { name: "direct-server", role: "Connexion directe", operations: [op("start", "Lance un serveur de sessions en connexion directe."), op("connect", "Ouvre une session sur un serveur en connexion directe.", { args: "<adresse>" })] },
  { name: "remote-access", role: "Accès à distance", operations: [op("start", "Inscrit le poste comme environnement pilotable.")] },
  { name: "ssh-session", role: "Session SSH", operations: [op("connect", "Exécute le produit sur une machine distante par SSH.", { args: "<hôte> [dossier]" })] },
  {
    name: "service",
    role: "Superviseur local",
    operations: [op("start", "Démarre le superviseur local."), op("stop", "Arrête le superviseur local."), op("show", "Affiche l'état du superviseur local."), op("show-log", "Affiche le journal du superviseur local.")],
  },
  {
    name: "background-session",
    role: "Sessions détachées",
    operations: [
      op("list", "Liste les sessions détachées."),
      op("show-log", "Affiche le journal d'une session détachée.", { args: "<id>" }),
      op("attach", "Se rattache à une session détachée.", { args: "<id>" }),
      op("stop", "Arrête une session détachée.", { args: "<id>" }),
    ],
  },
  { name: "resident-agent", role: "Assistant persistant", operations: [op("attach", "Se rattache à l'assistant persistant.", { args: "[<id>]" })] },
  {
    name: "job",
    role: "Travaux",
    operations: [op("create", "Crée un travail à partir d'un modèle.", { args: "<modèle> [consigne]" }), op("list", "Liste les travaux."), op("reply", "Répond à un travail.", { args: "<id> <message>" })],
  },
  { name: "session-runner", role: "Exécuteur de sessions", operations: [op("start", "Lance un exécuteur de sessions affectées à un environnement.")] },
  { name: "job-runner", role: "Exécuteur de travaux", operations: [op("start", "Lance un exécuteur de travaux affectés.")] },
];

export const FAMILY_BY_NAME: ReadonlyMap<string, FamilyDef> = new Map(FAMILY_CATALOG.map((f) => [f.name, f]));

/** Common options of the sub-commands (§ 5.4): `true` when the option takes a value. */
export const COMMON_OPTIONS: Readonly<Record<string, boolean>> = { json: false, scope: true, force: false, "preserve-data": false, name: true, verbose: false, help: false };

export interface ParsedSubcommand {
  readonly family: string;
  readonly operation?: string;
  readonly args: readonly string[];
  readonly options: ReadonlyMap<string, string | true>;
}

export class SubcommandUsageError extends Error {}

/** Parses `<family> [<operation>] [arguments] [options]`; an option outside § 5.4 is refused as unknown (§ 5.1). */
export function parseSubcommand(argv: readonly string[]): ParsedSubcommand {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    if (!(name in COMMON_OPTIONS)) throw new SubcommandUsageError(`Option inconnue : --${name}.`);
    if (COMMON_OPTIONS[name]) {
      const value = eq !== -1 ? token.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "") throw new SubcommandUsageError(`Valeur manquante pour --${name}.`);
      options.set(name, value);
    } else options.set(name, true);
  }
  const [family, operation, ...args] = positionals;
  return { family: family ?? "", operation, args, options };
}

/** Help of a family (EF-01, RN-G): its operations, without any action. */
export function familyHelp(cli: string, family: FamilyDef): string {
  const width = Math.max(...family.operations.map((o) => `${o.name}${o.args ? ` ${o.args}` : ""}`.length));
  const lines = [`${family.role} — ${cli} ${family.name} <opération> [arguments] [options]`, "", "Opérations :"];
  for (const o of family.operations) {
    const head = `${o.name}${o.args ? ` ${o.args}` : ""}`;
    lines.push(`  ${head.padEnd(width)}  ${o.role}${o.delivered ? "" : " (non disponible dans cette version)"}`);
  }
  lines.push("", "Options communes : --json (sortie structurée), --scope <user|project|local>, --force, --name <nom>, --verbose, --help", "");
  return lines.join("\n");
}
