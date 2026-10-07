// Implements: SPEC-IHM-014 (§ 5.1 contexts and priority, § 5.2 catalogue of actions with stable identifiers, § 5.3 default bindings, EF-01, EF-05, EF-07, RG-02)
// Catalogue of the actions of the interface and their default combinations. The most specific context answers first:
// dialog, then input area, then application.

import { comboOf, type KeyEvent } from "../ui/keys";

export type KeyContext = "dialog" | "input" | "app";

export interface ActionDef {
  /** Stable identifier (RG-02). */
  readonly id: string;
  readonly context: KeyContext;
  readonly label: string;
  readonly defaults: readonly string[];
  /** Essential action (EF-05): can never be disabled. */
  readonly essential?: boolean;
}

export const ACTIONS: readonly ActionDef[] = [
  { id: "app.interrupt", context: "app", label: "Interrompre le tour, effacer la saisie, ou quitter (deux fois)", defaults: ["ctrl+c"], essential: true },
  { id: "app.exit", context: "app", label: "Quitter (deux fois, saisie vide)", defaults: ["ctrl+d"], essential: true },
  { id: "app.cancel", context: "app", label: "Interrompre le tour en cours", defaults: ["escape"], essential: true },
  { id: "mode.cycle", context: "app", label: "Changer de mode de permission", defaults: ["shift+tab"] },
  { id: "input.submit", context: "input", label: "Envoyer le message (en file pendant un tour)", defaults: ["enter"] },
  { id: "input.newline", context: "input", label: "Insérer un saut de ligne", defaults: ["alt+enter", "shift+enter", "ctrl+j"] },
  { id: "input.left", context: "input", label: "Caractère précédent", defaults: ["left", "ctrl+b"] },
  { id: "input.right", context: "input", label: "Caractère suivant", defaults: ["right", "ctrl+f"] },
  { id: "input.wordLeft", context: "input", label: "Mot précédent", defaults: ["ctrl+left", "alt+left", "alt+b"] },
  { id: "input.wordRight", context: "input", label: "Mot suivant", defaults: ["ctrl+right", "alt+right", "alt+f"] },
  { id: "input.lineStart", context: "input", label: "Début de ligne", defaults: ["home", "ctrl+a"] },
  { id: "input.lineEnd", context: "input", label: "Fin de ligne", defaults: ["end", "ctrl+e"] },
  { id: "input.start", context: "input", label: "Début du contenu", defaults: ["ctrl+home"] },
  { id: "input.end", context: "input", label: "Fin du contenu", defaults: ["ctrl+end"] },
  { id: "input.up", context: "input", label: "Ligne précédente, message en file, historique", defaults: ["up", "ctrl+p"] },
  { id: "input.down", context: "input", label: "Ligne suivante, historique", defaults: ["down", "ctrl+n"] },
  { id: "input.deleteBack", context: "input", label: "Supprimer le caractère précédent", defaults: ["backspace", "shift+backspace"] },
  { id: "input.deleteForward", context: "input", label: "Supprimer le caractère suivant", defaults: ["delete"] },
  { id: "input.deleteWordBack", context: "input", label: "Supprimer le mot précédent", defaults: ["ctrl+w", "alt+backspace", "ctrl+backspace"] },
  { id: "input.deleteWordForward", context: "input", label: "Supprimer le mot suivant", defaults: ["alt+d", "ctrl+delete"] },
  { id: "input.killLineEnd", context: "input", label: "Supprimer jusqu'à la fin de la ligne", defaults: ["ctrl+k"] },
  { id: "input.killLineStart", context: "input", label: "Supprimer jusqu'au début de la ligne", defaults: ["ctrl+u"] },
  { id: "input.transpose", context: "input", label: "Échanger deux caractères", defaults: ["ctrl+t"] },
  { id: "input.undo", context: "input", label: "Annuler", defaults: ["ctrl+z", "ctrl+_"] },
  { id: "input.redo", context: "input", label: "Rétablir", defaults: ["ctrl+y"] },
  { id: "draft.stash", context: "input", label: "Mettre le brouillon de côté", defaults: ["ctrl+s"] },
  { id: "draft.restore", context: "input", label: "Restituer le dernier brouillon mis de côté", defaults: ["alt+s"] },
  { id: "queue.clear", context: "input", label: "Vider la file des messages en attente", defaults: ["alt+x"] },
  { id: "dialog.confirm", context: "dialog", label: "Valider le choix", defaults: ["enter"] },
  { id: "dialog.previous", context: "dialog", label: "Choix précédent", defaults: ["up", "shift+tab"] },
  { id: "dialog.next", context: "dialog", label: "Choix suivant", defaults: ["down"] },
  { id: "dialog.scope", context: "dialog", label: "Changer la portée de la règle", defaults: ["tab"] },
  { id: "dialog.refuse", context: "dialog", label: "Refuser", defaults: ["escape"] },
];

export class Keymap {
  readonly #byContext = new Map<KeyContext, Map<string, string>>();

  constructor(bindings: ReadonlyMap<string, readonly string[]> = new Map()) {
    for (const a of ACTIONS) {
      const combos = bindings.get(a.id) ?? a.defaults;
      let map = this.#byContext.get(a.context);
      if (!map) this.#byContext.set(a.context, (map = new Map()));
      for (const c of combos) if (!map.has(c)) map.set(c, a.id);
    }
  }

  /** Action of a key in the given contexts, from the most specific (§ 5.1). */
  action(key: KeyEvent, contexts: readonly KeyContext[]): string | undefined {
    const combo = comboOf(key);
    for (const c of contexts) {
      const id = this.#byContext.get(c)?.get(combo);
      if (id) return id;
    }
    return undefined;
  }
}
