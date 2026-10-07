// Implements: SPEC-IHM-014 (§ 5.1 contexts and priority, § 5.2 catalogue of actions with stable identifiers, § 5.3 default bindings, § 5.4 customisation, § 5.5 conflicts and fallbacks, § 5.6 discovery,
//             EF-01 to EF-07, ERR-01 to ERR-04, RG-01 to RG-03, CA-01 to CA-06)
// Catalogue of the actions of the interface, their default combinations and their customisation. The most specific
// context answers first: dialog, then input area, then application.

import { comboOf, type KeyEvent } from "../ui/keys";

export type KeyContext = "dialog" | "input" | "app";

export interface ActionDef {
  /** Stable identifier (RG-02). */
  readonly id: string;
  readonly context: KeyContext;
  readonly label: string;
  readonly defaults: readonly string[];
  /** Essential action (EF-05): can never be disabled, nor have its combinations taken by another action. */
  readonly essential?: boolean;
}

export const ACTIONS: readonly ActionDef[] = [
  { id: "app.interrupt", context: "app", label: "Interrompre le tour, effacer la saisie, ou quitter (deux fois)", defaults: ["ctrl+c"], essential: true },
  { id: "app.exit", context: "app", label: "Quitter (deux fois, saisie vide)", defaults: ["ctrl+d"], essential: true },
  { id: "app.cancel", context: "app", label: "Interrompre le tour en cours", defaults: ["escape"], essential: true },
  { id: "mode.cycle", context: "app", label: "Changer de mode de permission", defaults: ["shift+tab"] },
  { id: "input.submit", context: "input", label: "Envoyer le message (en file pendant un tour)", defaults: ["enter"] },
  { id: "input.newline", context: "input", label: "Insérer un saut de ligne", defaults: ["shift+enter", "alt+enter", "ctrl+j"] },
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

const BY_ID: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((a) => [a.id, a]));

/** Combinations that some terminals do not send (§ 5.5): another combination of the same action is the fallback. */
export const UNRELIABLE: ReadonlySet<string> = new Set(["shift+enter", "ctrl+enter", "ctrl+backspace", "ctrl+delete", "ctrl+home", "ctrl+end", "ctrl+_", "alt+left", "alt+right"]);

const NAMED_KEYS = new Set(["enter", "tab", "backspace", "delete", "escape", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "insert", "space", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);
const KEY_ALIASES: Readonly<Record<string, string>> = { esc: "escape", return: "enter", del: "delete", pgup: "pageup", pgdn: "pagedown" };
const MODIFIER_ALIASES: Readonly<Record<string, string>> = { ctrl: "ctrl", control: "ctrl", alt: "alt", option: "alt", meta: "alt", shift: "shift" };

/** Canonical form of a combination (`ctrl+alt+shift+<key>`), or undefined when it cannot be read (ERR-02). */
export function parseCombo(value: string): string | undefined {
  const parts = value.trim().toLowerCase().split("+");
  // `ctrl++` names the `+` key.
  if (value.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const rawKey = parts.pop();
  if (!rawKey) return undefined;
  const mods = new Set<string>();
  for (const m of parts) {
    const canonical = MODIFIER_ALIASES[m];
    if (!canonical || mods.has(canonical)) return undefined;
    mods.add(canonical);
  }
  const key = KEY_ALIASES[rawKey] ?? rawKey;
  const printable = [...key].length === 1 && key >= " ";
  if (!NAMED_KEYS.has(key) && !printable) return undefined;
  // A printable key with shift alone is the character itself: it cannot be bound apart.
  if (printable && mods.size === 0) return undefined;
  if (printable && mods.has("shift") && !mods.has("ctrl") && !mods.has("alt")) return undefined;
  return `${mods.has("ctrl") ? "ctrl+" : ""}${mods.has("alt") ? "alt+" : ""}${mods.has("shift") && !printable ? "shift+" : ""}${key}`;
}

export interface Binding {
  readonly id: string;
  readonly combos: readonly string[];
  readonly custom: boolean;
}

export class Keymap {
  readonly #byContext = new Map<KeyContext, Map<string, string>>();
  readonly #bindings: ReadonlyMap<string, Binding>;

  constructor(bindings: ReadonlyMap<string, Binding> = new Map(ACTIONS.map((a) => [a.id, { id: a.id, combos: a.defaults, custom: false }]))) {
    this.#bindings = bindings;
    // Customised actions are declared first, so that they win a conflict (§ 5.5).
    const order = [...ACTIONS].sort((a, b) => Number(bindings.get(b.id)?.custom ?? false) - Number(bindings.get(a.id)?.custom ?? false));
    for (const a of order) {
      let map = this.#byContext.get(a.context);
      if (!map) this.#byContext.set(a.context, (map = new Map()));
      for (const c of bindings.get(a.id)?.combos ?? a.defaults) if (!map.has(c)) map.set(c, a.id);
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

  /** Effective combinations of an action: those that still trigger it after the conflicts (RG-03). */
  effective(id: string): string[] {
    const a = BY_ID.get(id);
    if (!a) return [];
    const map = this.#byContext.get(a.context);
    return (this.#bindings.get(id)?.combos ?? a.defaults).filter((c) => map?.get(c) === id);
  }

  isCustom(id: string): boolean {
    return this.#bindings.get(id)?.custom ?? false;
  }
}

/**
 * The key map of a session from `ui.keybindings.bindings` (§ 5.4): an unknown action (ERR-01), an unreadable combination
 * (ERR-02), the disabling of an essential action (ERR-03) are ignored with a warning, without invalidating the others
 * (EF-04); a conflict in a context is reported and the first declared wins (ERR-04), or the customisation is refused as a
 * whole with `ui.keybindings.strictConflicts`.
 */
export function buildKeymap(custom: Readonly<Record<string, unknown>>, o: { readonly strictConflicts: boolean }): { keymap: Keymap; warnings: string[] } {
  const warnings: string[] = [];
  const bindings = new Map<string, Binding>(ACTIONS.map((a) => [a.id, { id: a.id, combos: a.defaults, custom: false }]));
  const essentialCombos = new Map<string, string>();
  for (const a of ACTIONS) if (a.essential) for (const c of a.defaults) essentialCombos.set(c, a.id);
  for (const [id, raw] of Object.entries(custom)) {
    const def = BY_ID.get(id);
    if (!def) {
      warnings.push(`Action inconnue : ${id}.`); // ERR-01
      continue;
    }
    const values = Array.isArray(raw) ? raw : [raw];
    if (values.some((v) => typeof v !== "string")) {
      warnings.push(`Combinaison invalide : ${JSON.stringify(raw)}.`);
      continue;
    }
    const combos: string[] = [];
    for (const v of values as string[]) {
      if (v.trim() === "") continue;
      const c = parseCombo(v);
      if (!c) warnings.push(`Combinaison invalide : ${v}.`); // ERR-02
      else if (essentialCombos.has(c) && essentialCombos.get(c) !== id && !def.essential) warnings.push(`La combinaison ${v} est réservée à une action essentielle (${essentialCombos.get(c)}) : elle n'est pas associée à ${id}.`);
      else if (!combos.includes(c)) combos.push(c);
    }
    if (combos.length === 0 && values.every((v) => (v as string).trim() === "")) {
      // An empty binding disables the action, except an essential one (EF-05, ERR-03, CA-04).
      if (def.essential) {
        warnings.push(`Cette action ne peut pas être désactivée : ${id}.`);
        continue;
      }
      bindings.set(id, { id, combos: [], custom: true });
      continue;
    }
    if (combos.length === 0) continue;
    bindings.set(id, { id, combos, custom: true });
  }
  // EF-03: conflicts within a context, reported once each.
  const conflicts: string[] = [];
  for (const context of ["dialog", "input", "app"] as const) {
    const owners = new Map<string, string[]>();
    const ordered = [...bindings.values()].filter((b) => BY_ID.get(b.id)!.context === context).sort((a, b) => Number(b.custom) - Number(a.custom));
    for (const b of ordered) for (const c of b.combos) owners.set(c, [...(owners.get(c) ?? []), b.id]);
    for (const [combo, ids] of owners) if (ids.length > 1) conflicts.push(`Deux actions partagent la même combinaison : ${combo} (${ids.join(", ")}) ; ${ids[0]} s'applique.`); // ERR-04, CA-05
  }
  if (conflicts.length > 0 && o.strictConflicts) {
    warnings.push(...conflicts, "Associations personnalisées refusées en raison des conflits (ui.keybindings.strictConflicts) : les associations par défaut s'appliquent.");
    return { keymap: new Keymap(), warnings };
  }
  warnings.push(...conflicts);
  return { keymap: new Keymap(bindings), warnings };
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  enter: "Entrée", escape: "Échap", tab: "Tab", backspace: "Retour arrière", delete: "Suppr", up: "↑", down: "↓", left: "←", right: "→",
  home: "Début", end: "Fin", pageup: "Page préc.", pagedown: "Page suiv.", insert: "Inser", space: "Espace",
};

/** A combination as shown to the user: `Ctrl+Maj+Entrée`. */
export function comboLabel(combo: string): string {
  const parts = combo.split("+");
  if (combo.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const key = parts.pop()!;
  const mods = parts.map((m) => (m === "ctrl" ? "Ctrl" : m === "alt" ? "Alt" : "Maj"));
  const label = KEY_LABELS[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
  return [...mods, label].join("+");
}

/**
 * EF-06, CA-01, CA-02, CA-06: the effective bindings of the contexts, with the customised ones marked and the combinations
 * that some terminals do not send flagged with their fallback.
 */
export function bindingsHelp(keymap: Keymap, contexts: readonly KeyContext[]): Array<{ context: KeyContext; rows: Array<{ id: string; label: string; keys: string; note?: string }> }> {
  return contexts.map((context) => ({
    context,
    rows: ACTIONS.filter((a) => a.context === context).map((a) => {
      const combos = keymap.effective(a.id);
      const unreliable = combos.filter((c) => UNRELIABLE.has(c));
      const reliable = combos.filter((c) => !UNRELIABLE.has(c));
      const notes: string[] = [];
      if (keymap.isCustom(a.id)) notes.push("personnalisé");
      if (unreliable.length > 0) notes.push(`${unreliable.map(comboLabel).join(", ")} : non transmise par certains terminaux${reliable.length > 0 ? ` ; repli : ${reliable.map(comboLabel).join(", ")}` : ""}`);
      return { id: a.id, label: a.label, keys: combos.length > 0 ? combos.map(comboLabel).join(", ") : "(désactivée)", ...(notes.length > 0 ? { note: notes.join(" ; ") } : {}) };
    }),
  }));
}
