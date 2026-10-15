// Implements: SPEC-MOD-012 (§ 5.1 structure, § 5.2 naming, § 5.3 catalogue of families and operations, § 5.4 common options, EF-01, RN-A to RN-H)
// Supports: SPEC-MOD-011 (CA-10, CA-11: session coordination role), gap E-140.
// Supports: gaps E-066 (operations delivered in lot 1), E-126 (local authorised policy recovery verification).

import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
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
      op("recover-policy", "Vérifie une version de politique autorisée avant sa remise en place administrative.", { args: "<fichier>", delivered: true, options: ["json"] }),
      op("show-sources", "Affiche les sources chargées et leur ordre de priorité."),
      op("push", "Envoie les préférences choisies vers le service configuré.", { delivered: buildFlag("settings_sync"), options: ["resolve"] }),
      op("pull", "Récupère les préférences avec sauvegarde restaurable.", { delivered: buildFlag("settings_sync"), options: ["restore"] }),
    ],
  },
  {
    name: "auth",
    role: "Identifiants",
    operations: [op("login", "Connecte un compte de la société ou enregistre une clé d'API.", { delivered: true, options: ["company"] }), op("logout", "Supprime les identifiants choisis après confirmation.", { delivered: true, options: ["company"] }), op("show", "Affiche l'état d'authentification et l'expiration.", { delivered: true, options: ["json", "refresh"] })],
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
      op("list", "Liste les connecteurs déclarés et leur état.", { delivered: true, options: ["json"] }),
      op("add", "Déclare un connecteur dans la portée choisie.", { args: "<nom> [options] -- <commande ou URL> [arguments]", delivered: true, options: ["scope", "force", "transport", "env", "header", "declaration"] }),
      op("show", "Affiche la déclaration et les capacités découvertes.", { args: "<nom>", delivered: true, options: ["json"] }),
      op("remove", "Retire un connecteur.", { args: "<nom>", delivered: true, options: ["scope"] }),
      op("validate", "Vérifie le démarrage et la découverte des capacités.", { args: "<nom>", delivered: true, options: ["json"] }),
      op("search", "Recherche un connecteur dans le registre configuré.", { args: "<terme>", delivered: true, options: ["json"] }),
      op("import", "Importe les déclarations sélectionnées d’un fichier d’application de bureau.", { args: "<fichier> <noms séparés par des virgules>", delivered: true, options: ["force"] }),
      op("install-archive", "Installe une archive locale de connecteur après confirmation.", { args: "<fichier.mcpb>", delivered: true, options: ["scope", "force"] }),
      op("reset-choices", "Réinitialise les décisions d'approbation de connecteurs du projet.", { delivered: true }),
    ],
  },
  {
    name: "connector-server",
    role: "Serveur de connecteur",
    operations: [op("start", "Lance le produit comme serveur de connecteur.", { delivered: true, options: ["capabilities", "root", "transport", "approval-mode", "listen"] })],
  },
  {
    name: "extension",
    role: "Extensions",
    operations: [
      op("list", "Liste les extensions installées et leur version.", { delivered: true, options: ["json", "installable"] }),
      op("add", "Installe une extension.", { args: "<référence>", delivered: true, options: ["scope", "force"] }),
      op("show", "Affiche les contributions d'une extension.", { args: "<nom>" }),
      op("remove", "Désinstalle une extension.", { args: "<nom>", delivered: true, options: ["scope", "force", "preserve-data"] }),
      op("enable", "Active une extension installée.", { args: "<nom>", delivered: true, options: ["scope"] }),
      op("disable", "Désactive une extension installée.", { args: "<nom>", delivered: true, options: ["scope"] }),
      op("update", "Met à jour une ou toutes les extensions.", { args: "[<nom>]", delivered: true, options: ["force", "auto", "notify-only", "approval-pipe"] }),
      op("rollback", "Revient à la version précédente d'une extension.", { args: "<nom>", delivered: true }),
      op("validate", "Vérifie la conformité d'une extension en cours de développement.", { args: "<chemin>", delivered: true, options: ["json"] }),
    ],
  },
  {
    name: "catalog",
    role: "Catalogues d'extensions",
    operations: [
      op("list", "Liste les catalogues d'extensions configurés.", { delivered: true, options: ["json"] }),
      op("add", "Ajoute un catalogue d'extensions.", { args: "<référence>", delivered: true, options: ["scope", "lean-context", "name"] }),
      op("update", "Actualise l'index d'un ou de tous les catalogues.", { args: "[<nom>]", delivered: true }),
      op("remove", "Retire un catalogue.", { args: "<nom>", delivered: true, options: ["scope", "force"] }),
    ],
  },
  {
    name: "session",
    role: "Sessions",
    operations: [
      op("list", "Liste les sessions enregistrées du dossier courant."),
      op("show", "Affiche le détail d'une session.", { args: "<identifiant>" }),
      op("export", "Exporte une session dans un format d'échange.", { args: "<identifiant>" }),
      op("read", "Écrit le contenu désigné par une référence de lecture.", { args: "<référence>", delivered: true }),
      op("remove", "Supprime une session.", { args: "<identifiant>" }),
    ],
  },
  { name: "history", role: "Historique des saisies", operations: [op("remove", "Efface l'historique des saisies (--all).")] },
  { name: "storage", role: "Données locales", operations: [op("purge", "Supprime les données locales selon les règles de rétention.")] },
  { name: "project", role: "Projet courant", operations: [op("reset-choices", "Réinitialise les décisions mémorisées pour le projet courant.", { delivered: true })] },
  {
    name: "diagnostic",
    role: "Diagnostic",
    operations: [
      op("validate", "Vérifie l'environnement et signale les anomalies.", { delivered: true, options: ["json"] }),
      op("repair", "Applique les corrections proposées, chacune après accord.", { delivered: true }),
    ],
  },
  {
    name: "installation",
    role: "Installation",
    operations: [op("show", "Affiche la version et les informations de construction.", { delivered: true, options: ["json"] }), op("update", "Met à jour l'outil.", { delivered: true, options: ["json", "check", "channel", "version", "force"] }), op("remove", "Désinstalle l'outil.")],
  },
  { name: "integration", role: "Intégrations", operations: [op("add", "Installe une intégration d'environnement de développement.", { args: "<cible>" })] },
  { name: "direct-server", role: "Connexion directe", operations: [op("start", "Lance un serveur de sessions en connexion directe."), op("connect", "Ouvre une session sur un serveur en connexion directe.", { args: "<adresse>" })] },
  { name: "remote-access", role: "Accès à distance", operations: [op("start", "Inscrit le poste comme environnement pilotable.")] },
  { name: "ssh-session", role: "Session SSH", operations: [op("connect", "Exécute le produit sur une machine distante par SSH.", { args: "<hôte> [dossier]" })] },
  {
    name: "service",
    role: "Superviseur local",
    operations: [op("start", "Démarre le superviseur local.", {delivered:true,options:["foreground","json"]}), op("stop", "Arrête le superviseur local.", {delivered:true,options:["json"]}), op("show", "Affiche l'état du superviseur local.", {delivered:true,options:["json"]}), op("show-log", "Affiche le journal du superviseur local.", {delivered:true,options:["json"]})],
  },
  {
    name: "background-session",
    role: "Sessions détachées",
    operations: [
      op("list", "Liste les sessions détachées.", {delivered:true,options:["json"]}),
      op("show-log", "Affiche le journal d'une session détachée.", { args: "<id>",delivered:true,options:["json"] }),
      op("attach", "Se rattache à une session détachée.", { args: "<id>",delivered:true }),
      op("stop", "Arrête une session détachée.", { args: "<id>",delivered:true,options:["json"] }),
    ],
  },
  { name: "resident-agent", role: "Assistant persistant", operations: [op("attach", "Se rattache à l'assistant persistant.", { args: "[<id>]" })] },
  {
    name: "job",
    role: "Travaux",
    operations: [op("create", "Crée un travail à partir d'un modèle.", { args: "<modèle> [consigne]",delivered:true,options:["json"] }), op("list", "Liste les travaux.",{delivered:true,options:["json"]}), op("reply", "Répond à un travail.", { args: "<id> <message>",delivered:true,options:["json"] })],
  },
  { name: "session-runner", role: "Exécuteur de sessions", operations: [op("start", "Lance un exécuteur de sessions affectées à un environnement.", { delivered: buildFlag("remote_self_hosted_runner"), options: ["organization", "environment", "credential-file", "root", "concurrent-sessions"] })] },
  { name: "job-runner", role: "Exécuteur de travaux", operations: [op("start", "Lance un exécuteur de travaux affectés.", { delivered: buildFlag("remote_provided_environment"), options: ["organization", "environment", "credential-file", "root", "concurrent-sessions"] })] },
];

export const FAMILY_BY_NAME: ReadonlyMap<string, FamilyDef> = new Map(FAMILY_CATALOG.map((f) => [f.name, f]));

/** Common options of the sub-commands (§ 5.4): `true` when the option takes a value. */
/** § 5.4 of SPEC-MOD-012, plus the options proper to an operation: `--lean-context` (SPEC-EXT-004), `--installable` (SPEC-EXT-002). */
export const COMMON_OPTIONS: Readonly<Record<string, boolean>> = { foreground: false, organization: true, environment: true, "credential-file": true, "concurrent-sessions": true, auto: false, "notify-only": false, "approval-pipe": false, json: false, scope: true, force: false, "preserve-data": false, name: true, verbose: false, help: false, "lean-context": true, installable: false, capabilities: true, root: true, transport: true, "approval-mode": true, listen: true, orchestrator: false, env: true, header: true, declaration: true, check: false, channel: true, version: true, company: false, refresh: false, resolve: true, restore: true };

export interface ParsedSubcommand {
  readonly family: string;
  readonly operation?: string;
  readonly args: readonly string[];
  readonly options: ReadonlyMap<string, string | true>;
  readonly repeatedOptions?: ReadonlyMap<string, readonly string[]>;
}

export class SubcommandUsageError extends Error {}

/** The coordination role belongs to a session; the current engine exposes no coordination capability. */
export function orchestratorRefusal(family?: string, operation?: string): string {
  const invocation = family && operation ? family + " " + operation : undefined;
  const services = ["connector-server start", "direct-server start", "remote-access start", "service start", "session-runner start", "job-runner start"];
  if (invocation && services.includes(invocation)) return "--orchestrator : le rôle coordinateur appartient à une session, pas à un service ou à un superviseur.";
  const sessions = ["direct-server connect", "ssh-session connect", "resident-agent attach", "background-session attach", "job create", "job reply"];
  if (!family || (invocation && sessions.includes(invocation))) return "--orchestrator : le moteur de session ne dispose pas de la capacité de coordination ; lancement refusé.";
  return "--orchestrator : cette option de session ne s'applique pas à une opération d'administration.";
}

/** Parses `<family> [<operation>] [arguments] [options]`; an option outside § 5.4 is refused as unknown (§ 5.1). */
export function parseSubcommand(argv: readonly string[]): ParsedSubcommand {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const repeatedOptions = new Map<string, string[]>();
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
    if (name === "orchestrator" && eq !== -1) throw new SubcommandUsageError("--orchestrator n’accepte pas de valeur.");
    if (COMMON_OPTIONS[name]) {
      const value = eq !== -1 ? token.slice(eq + 1) : argv[++i];
      if (value === undefined || value === "" || (eq === -1 && value.startsWith("--"))) throw new SubcommandUsageError(`Valeur manquante pour --${name}.`);
      options.set(name, value);
      if (name === "env" || name === "header") repeatedOptions.set(name, [...(repeatedOptions.get(name) ?? []), value]);
    } else options.set(name, true);
  }
  const [family, operation, ...args] = positionals;
  return { family: family ?? "", operation, args, options, ...(repeatedOptions.size ? { repeatedOptions } : {}) };
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
