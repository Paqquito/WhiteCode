// Implements: SPEC-CMD-030 (§ 5.1, § 5.3, EF-01, EF-02), SPEC-IHM-014 (§ 5.6 discovery, § 10 view in two columns, EF-06, RG-03, CA-01, CA-02, CA-06), SPEC-CMD-001 (EF-08 catalogue with descriptions and arguments)
// The help of the interactive session: the commands really available, by source, then the effective key bindings of the
// contexts, customised ones and fallbacks marked.

import type { CatalogEntry, CommandSource } from "../commands/catalog";
import { box, text, type Node } from "../ui/layout";
import type { Span } from "../ui/text";
import { bindingsHelp, type KeyContext, type Keymap } from "./keymap";

const SOURCE_LABEL: Readonly<Record<CommandSource, string>> = {
  internal: "Commandes du produit",
  managed: "Commandes de l'organisation",
  project: "Commandes du projet",
  user: "Commandes de l'utilisateur",
  extension: "Commandes des extensions",
  connector: "Commandes des connecteurs",
};

const CONTEXT_LABEL: Readonly<Record<KeyContext, string>> = { input: "Raccourcis de la zone de saisie", app: "Raccourcis de l'application", dialog: "Raccourcis des dialogues" };

/** Two columns: a fixed first column, the second wrapped beside it. */
function row(left: string, right: Span[], width: number): Node {
  return box([box([text([{ text: left, style: { bold: true } }])], { width }), box([text(right)], { width: "grow" })], { direction: "row" });
}

/** Width of the first column: its longest entry, within bounds. */
const columnWidth = (lefts: readonly string[], min: number, max: number) => Math.max(min, Math.min(max, Math.max(0, ...lefts.map((l) => [...l].length)) + 2));

export function commandsHelp(entries: readonly CatalogEntry[]): Node[] {
  const out: Node[] = [];
  for (const source of Object.keys(SOURCE_LABEL) as CommandSource[]) {
    const group = entries.filter((e) => e.source === source).sort((a, b) => (a.name < b.name ? -1 : 1));
    if (group.length === 0) continue;
    out.push(text([{ text: SOURCE_LABEL[source], style: { underline: true } }]));
    const lefts = group.map((e) => `  /${e.name}${e.usage ? ` ${e.usage}` : ""}`);
    const width = columnWidth(lefts, 16, 36);
    group.forEach((e, i) => out.push(row(lefts[i]!, [{ text: e.description }], width)));
  }
  return out;
}

export function shortcutsHelp(keymap: Keymap, contexts: readonly KeyContext[] = ["input", "app", "dialog"]): Node[] {
  const out: Node[] = [];
  const groups = bindingsHelp(keymap, contexts);
  const width = columnWidth(groups.flatMap((g) => g.rows.map((r) => `  ${r.keys}`)), 16, 40);
  for (const group of groups) {
    out.push(text([{ text: CONTEXT_LABEL[group.context], style: { underline: true } }]));
    for (const r of group.rows) out.push(row(`  ${r.keys}`, [{ text: r.label }, ...(r.note ? [{ text: ` (${r.note})`, style: { dim: true } }] : [])], width));
  }
  return out;
}

export function helpView(entries: readonly CatalogEntry[], keymap: Keymap): Node {
  return box([...commandsHelp(entries), text(""), ...shortcutsHelp(keymap)]);
}
