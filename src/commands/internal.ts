// Implements: SPEC-CMD-001 (§ 5.3 rank 1, § 5.5 kinds, EF-13 widening attribute declared by each internal command), SPEC-CMD-023 (§ 5.2), SPEC-CMD-030 (§ 5.2), SPEC-IHM-008 (EF-06), SPEC-CMD-002 (§ 5.3),
//             SPEC-CMD-009, SPEC-CMD-006, SPEC-CMD-059, SPEC-CMD-058, SPEC-CMD-024 (§ 5.2: commands of the user)
// The internal commands of this version. Each one declares its kind and whether it widens what the agent may do.
// Supports: SPEC-IHM-019 (model selector), SPEC-CMD-072 (appearance command), gap E-142.
// Supports: SPEC-CMD-075 (CA-01, persistent editing toggle), gap E-148.
// Supports: SPEC-CMD-069, SPEC-SES-009 (persistent labels), gap E-149.

import type { InternalCommand } from "./catalog";

export const INTERNAL_COMMANDS: readonly InternalCommand[] = [
  { name: "help", description: "Affiche les commandes disponibles et les raccourcis clavier.", kind: "display", widening: false, interactiveOnly: true },
  { name: "exit", description: "Quitte la session (le tour en cours est interrompu).", kind: "action", widening: false, interactiveOnly: true },
  { name: "login", description: "Enregistre une clé d'API par saisie masquée et termine la session pour sa prise en compte.", kind: "action", widening: true, interactiveOnly: true },
  { name: "logout", description: "Supprime les identifiants enregistrés après confirmation et termine la session.", kind: "action", widening: false, interactiveOnly: true },
  { name: "quit", description: "Quitte la session, comme /exit.", kind: "action", widening: false, interactiveOnly: true },
  { name: "transcript", description: "Ouvre la vue plein écran de la transcription (Alt+T).", kind: "display", widening: false, interactiveOnly: true },
  { name: "edit-mode", description: "Choisit l'édition standard ou modale de la zone de saisie, le contenu conservé.", kind: "action", widening: false, usage: "standard|modal", interactiveOnly: true },
  { name: "modal-editing", description: "Bascule l'édition modale et mémorise le choix dans la configuration utilisateur.", kind: "action", widening: false, interactiveOnly: true },
  { name: "history", description: "Efface l'historique des saisies (/history clear).", kind: "action", widening: false, usage: "clear", interactiveOnly: true },
  { name: "allow-dir", description: "Ajoute un dossier au périmètre de travail de la session.", kind: "action", widening: true, usage: "<chemin>" },
  { name: "clear", description: "Commence une nouvelle conversation ; l'actuelle reste reprenable.", kind: "action", widening: false, interactiveOnly: true },
  { name: "duplicate-session", description: "Copie la conversation dans une nouvelle session et y bascule (les fichiers ne sont pas dupliqués).", kind: "action", widening: false, usage: "[nom]", interactiveOnly: true },
  { name: "reopen", description: "Reprend une autre session du projet à la place de la courante.", kind: "action", widening: false, usage: "[identifiant ou nom]", interactiveOnly: true },
  { name: "retitle", description: "Donne un titre à la session.", kind: "action", widening: false, usage: "[titre]" },
  { name: "label-session", description: "Ajoute ou retire une étiquette ; sans argument, les affiche.", kind: "action", widening: false, usage: "[étiquette]" },
  { name: "save-transcript", description: "Enregistre la conversation dans un fichier texte, valeurs sensibles masquées.", kind: "action", widening: false, usage: "[fichier]" },
  { name: "status", description: "Affiche l'état de la session : version, modèle, mode, dossier, connecteurs.", kind: "display", widening: false },
  { name: "context-usage", description: "Affiche la répartition du contexte par catégorie.", kind: "display", widening: false },
  { name: "spending", description: "Affiche la consommation et le coût estimé de la session, par modèle.", kind: "display", widening: false },
  { name: "background-tasks", description: "Liste les tâches de fond de la session.", kind: "display", widening: false },
  { name: "skill-list", description: "Liste les compétences disponibles, par source.", kind: "display", widening: false },
  { name: "switch-model", description: "Choisit le modèle ; avec un argument, le change pour les prochains tours (défaut : l'enregistre).", kind: "action", widening: false, usage: "[modèle] [défaut]" },
  { name: "appearance", description: "Choisit le thème avec aperçu ; Échap rétablit le thème initial.", kind: "action", widening: false, interactiveOnly: true },
  { name: "reasoning-level", description: "Règle le niveau de réflexion (low, medium, high ; max pour cette session seulement).", kind: "action", widening: false, usage: "<niveau>" },
  { name: "planning", description: "Passe en mode planification ; avec une description, l'envoie au modèle.", kind: "mixed", widening: false, usage: "[description]" },
  { name: "condense", description: "Résume la conversation pour libérer le contexte, selon les consignes données.", kind: "action", widening: false, usage: "[consignes]" },
  { name: "preferences", description: "Affiche ou modifie un réglage de l'utilisateur.", kind: "action", widening: true, usage: "[clé [valeur]]" },
  { name: "access-rules", description: "Affiche ou modifie les règles d'accès ; consent gère l'accord automatique, classifier affiche ses consignes et décisions.", kind: "action", widening: true, usage: "[allow|ask|deny|remove <règle> [user|project|local] | consent [revoke] | classifier]" },
  { name: "event-hooks", description: "Affiche les crochets par événement avec leur source ; ajoute ou supprime un crochet.", kind: "action", widening: true, usage: "[add <événement> <commande> | remove <crochet>]" },
  { name: "connectors", description: "Affiche les connecteurs et leur état ; reconnecte un connecteur.", kind: "action", widening: false, usage: "[<nom> | reconnect <nom>]" },
  { name: "turn-changes", description: "Affiche les modifications de fichiers de chaque tour ; « dépôt » : les différences non enregistrées du dépôt.", kind: "display", widening: false, usage: "[dépôt]" },
  { name: "restore", description: "Rétablit les fichiers dans leur état d'avant un message, après aperçu et confirmation.", kind: "action", widening: false, usage: "[numéro du message] [code]", interactiveOnly: true },
  { name: "extensions", description: "Gère les extensions : installées, découvrir, catalogues, erreurs ; install <réf> après présentation et accord.", kind: "action", widening: true, usage: "[installées|découvrir|catalogues|erreurs|install <réf> [user|project|local]]" },
  { name: "reload-extensions", description: "Recharge les extensions : compétences, commandes et crochets ajoutés ou retirés, avec un rapport.", kind: "action", widening: true },
  { name: "diagnose", description: "Vérifie la configuration et l'environnement ; repair applique les corrections acceptées.", kind: "action", widening: false, usage: "[repair]" },
  { name: "create-instructions", description: "Explore le dépôt et propose des instructions de projet concises, écrites après accord.", kind: "mixed", widening: false, usage: "[projet] [personnel] [compétences] [crochets]" },
  { name: "shortcuts", description: "Affiche les raccourcis clavier effectifs ; edit ouvre leur fichier, reset rétablit ceux par défaut.", kind: "mixed", widening: false, usage: "[edit|reset]", interactiveOnly: true },
];
