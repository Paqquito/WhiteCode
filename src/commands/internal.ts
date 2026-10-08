// Implements: SPEC-CMD-001 (§ 5.3 rank 1, § 5.5 kinds, EF-13 widening attribute declared by each internal command), SPEC-CMD-023 (§ 5.2), SPEC-CMD-030 (§ 5.2), SPEC-IHM-008 (EF-06), SPEC-CMD-002 (§ 5.3),
//             SPEC-CMD-009, SPEC-CMD-006, SPEC-CMD-059, SPEC-CMD-058, SPEC-CMD-024 (§ 5.2: commands of the user)
// The internal commands of this version. Each one declares its kind and whether it widens what the agent may do.

import type { InternalCommand } from "./catalog";

export const INTERNAL_COMMANDS: readonly InternalCommand[] = [
  { name: "help", description: "Affiche les commandes disponibles et les raccourcis clavier.", kind: "display", widening: false, interactiveOnly: true },
  { name: "exit", description: "Quitte la session (le tour en cours est interrompu).", kind: "action", widening: false, interactiveOnly: true },
  { name: "quit", description: "Quitte la session, comme /exit.", kind: "action", widening: false, interactiveOnly: true },
  { name: "transcript", description: "Ouvre la vue plein écran de la transcription (Alt+T).", kind: "display", widening: false, interactiveOnly: true },
  { name: "edit-mode", description: "Choisit l'édition standard ou modale de la zone de saisie, le contenu conservé.", kind: "action", widening: false, usage: "standard|modal", interactiveOnly: true },
  { name: "history", description: "Efface l'historique des saisies (/history clear).", kind: "action", widening: false, usage: "clear", interactiveOnly: true },
  { name: "allow-dir", description: "Ajoute un dossier au périmètre de travail de la session.", kind: "action", widening: true, usage: "<chemin>" },
  { name: "clear", description: "Commence une nouvelle conversation ; l'actuelle reste reprenable.", kind: "action", widening: false, interactiveOnly: true },
  { name: "duplicate-session", description: "Copie la conversation dans une nouvelle session et y bascule (les fichiers ne sont pas dupliqués).", kind: "action", widening: false, usage: "[nom]", interactiveOnly: true },
  { name: "reopen", description: "Reprend une autre session du projet à la place de la courante.", kind: "action", widening: false, usage: "[identifiant ou nom]", interactiveOnly: true },
  { name: "retitle", description: "Donne un titre à la session.", kind: "action", widening: false, usage: "[titre]" },
  { name: "save-transcript", description: "Enregistre la conversation dans un fichier texte, valeurs sensibles masquées.", kind: "action", widening: false, usage: "[fichier]" },
  { name: "status", description: "Affiche l'état de la session : version, modèle, mode, dossier, connecteurs.", kind: "display", widening: false },
  { name: "context-usage", description: "Affiche la répartition du contexte par catégorie.", kind: "display", widening: false },
  { name: "spending", description: "Affiche la consommation et le coût estimé de la session, par modèle.", kind: "display", widening: false },
  { name: "background-tasks", description: "Liste les tâches de fond de la session.", kind: "display", widening: false },
  { name: "skill-list", description: "Liste les compétences disponibles, par source.", kind: "display", widening: false },
  { name: "switch-model", description: "Change de modèle pour la suite de la session (défaut : l'enregistre pour les suivantes).", kind: "action", widening: false, usage: "<modèle> [défaut]" },
  { name: "reasoning-level", description: "Règle le niveau de réflexion (low, medium, high ; max pour cette session seulement).", kind: "action", widening: false, usage: "<niveau>" },
  { name: "planning", description: "Passe en mode planification ; avec une description, l'envoie au modèle.", kind: "mixed", widening: false, usage: "[description]" },
  { name: "condense", description: "Résume la conversation pour libérer le contexte, selon les consignes données.", kind: "action", widening: false, usage: "[consignes]" },
  { name: "preferences", description: "Affiche ou modifie un réglage de l'utilisateur.", kind: "action", widening: true, usage: "[clé [valeur]]" },
  { name: "shortcuts", description: "Affiche les raccourcis clavier effectifs ; reset rétablit ceux par défaut.", kind: "mixed", widening: false, usage: "[reset]", interactiveOnly: true },
];
