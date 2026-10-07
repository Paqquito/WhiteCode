// Implements: SPEC-CMD-001 (§ 5.3 rank 1, § 5.5 kinds, EF-13 widening attribute declared by each internal command), SPEC-CMD-023 (§ 5.2), SPEC-CMD-030 (§ 5.2)
// The internal commands of this version. Each one declares its kind and whether it widens what the agent may do.

import type { InternalCommand } from "./catalog";

export const INTERNAL_COMMANDS: readonly InternalCommand[] = [
  { name: "help", description: "Affiche les commandes disponibles et les raccourcis clavier.", kind: "display", widening: false, interactiveOnly: true },
  { name: "exit", description: "Quitte la session (le tour en cours est interrompu).", kind: "action", widening: false, interactiveOnly: true },
  { name: "quit", description: "Quitte la session, comme /exit.", kind: "action", widening: false, interactiveOnly: true },
  { name: "shortcuts", description: "Affiche les raccourcis clavier effectifs ; reset rétablit ceux par défaut.", kind: "mixed", widening: false, usage: "[reset]", interactiveOnly: true },
];
