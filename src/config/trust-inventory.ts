// Implements: SPEC-PER-016 (§ 5.1, EF-03 inventory of the active elements of the project)
// What a project would run or widen once trusted: hooks, connectors, commands and skills, permission rules and widening
// settings. Read without executing anything (EF-01).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";

export interface InventorySources {
  readonly projectDir: string;
  /** Settings files of the project scopes (`config.json`, `config.local.json`). */
  readonly settingsFiles: readonly string[];
  readonly connectorsFile: string;
}

function readJson(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const v = parseJsonc(readFileSync(path, "utf8"), [], { allowTrailingComma: true }) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function entries(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

const get = (o: Record<string, unknown>, path: string): unknown => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), o);

/** One line per kind of active element; empty when the project holds none. */
export function projectInventory(s: InventorySources): string[] {
  const out: string[] = [];
  const hooks = new Set<string>();
  const rules: string[] = [];
  const sensitive = new Set<string>();
  for (const file of s.settingsFiles) {
    const o = readJson(file);
    if (!o) continue;
    const h = get(o, "hooks");
    if (h && typeof h === "object") for (const [event, list] of Object.entries(h)) if (Array.isArray(list) && list.length > 0) hooks.add(event);
    const allow = get(o, "permissions.allowRules");
    if (Array.isArray(allow)) rules.push(...allow.filter((r): r is string => typeof r === "string"));
    for (const key of ["permissions.initialMode", "permissions.extraDirectories", "environment.variables", "sandbox", "mcp.enableProjectServers", "mcp.enabledProjectServers"]) {
      if (get(o, key) !== undefined) sensitive.add(key);
    }
  }
  if (hooks.size > 0) out.push(`Crochets : ${[...hooks].sort().join(", ")}`);
  const connectors = readJson(s.connectorsFile);
  const declared = connectors?.["servers"];
  const servers = declared && typeof declared === "object" && !Array.isArray(declared) ? Object.keys(declared) : [];
  if (servers.length > 0) out.push(`Connecteurs : ${servers.sort().join(", ")}`);
  const commands = entries(join(s.projectDir, "commands"));
  if (commands.length > 0) out.push(`Commandes : ${commands.length}`);
  const skills = entries(join(s.projectDir, "skills"));
  if (skills.length > 0) out.push(`Compétences : ${skills.length}`);
  if (rules.length > 0) out.push(`Règles d'autorisation : ${rules.slice(0, 5).join(", ")}${rules.length > 5 ? ` (+${rules.length - 5})` : ""}`);
  if (sensitive.size > 0) out.push(`Paramètres sensibles : ${[...sensitive].sort().join(", ")}`);
  return out;
}
