// Implements: SPEC-MOD-011 (EF-05 help listing every option with default and incompatibilities, CA-07), SPEC-CAD-002 (EF-40 version output)

import type { Identity } from "../identity/identity";
import { CONFLICTS, OPTIONS, REQUIRES } from "./options";

export function versionText(identity: Identity): string {
  return `${identity.get("PRODUCT")} ${identity.version} — ${identity.get("SOCIETY")}\n`;
}

export function helpText(identity: Identity): string {
  const cli = identity.get("PRODUCT_CLI");
  const lines: string[] = [
    `${identity.get("PRODUCT")} ${identity.version} — ${identity.get("SOCIETY")}`,
    "",
    "Usage :",
    `  ${cli} --non-interactive [options] "<demande>"`,
    `  ${cli} <famille> <opération> [arguments] [options]`,
    "",
    "Une option à valeur facultative s'écrit --option=valeur. Un double tiret isolé termine les options.",
  ];
  const groups = new Map<string, typeof OPTIONS[number][]>();
  for (const o of OPTIONS) {
    if (o.hidden) continue;
    const list = groups.get(o.group) ?? [];
    list.push(o);
    groups.set(o.group, list);
  }
  for (const [group, options] of groups) {
    lines.push("", `${group} :`);
    for (const o of options) {
      const value = o.value === "none" ? "" : o.value === "optional" ? `[=<${o.type ?? "valeur"}>]` : ` <${o.enumValues ? o.enumValues.join("|") : o.type ?? "valeur"}>`;
      const extras: string[] = [];
      if (o.defaultText) extras.push(`défaut : ${o.defaultText}`);
      const conflicts = CONFLICTS.filter(([a, b]) => a === o.name || b === o.name).map(([a, b]) => `--${a === o.name ? b : a}`);
      if (conflicts.length > 0) extras.push(`incompatible avec ${conflicts.join(", ")}`);
      const requires = REQUIRES.filter(([a]) => a === o.name).map(([, b]) => `--${b}`);
      if (requires.length > 0) extras.push(`exige ${requires.join(", ")}`);
      if (o.danger) extras.push("lève une protection");
      if (!o.delivered) extras.push("non disponible dans cette version");
      lines.push(`  --${o.name}${value}`);
      lines.push(`      ${o.description}${extras.length > 0 ? ` (${extras.join(" ; ")})` : ""}`);
    }
  }
  lines.push("", `Documentation : ${identity.get("SERVICE_DOCS")}`, "");
  return lines.join("\n");
}
