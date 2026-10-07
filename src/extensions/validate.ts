// Implements: SPEC-EXT-012 (§ 5.1 checks, § 5.3 steps 2 and 3, FA-01, EF-02, ERR-01, CA-01, CA-02), SPEC-EXT-001 (EF-01, EF-02, ERR-01 to ERR-03, CA-01 to CA-03)
// `extension validate <path>`: the checks of an extension, the same at installation, as a report and an exit code.

import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { resolveConnectors } from "../connectors/declarations";
import { buildSnapshot } from "../hooks/config";
import { isRule, parseRule } from "../permissions/rules";
import { loadSkills, type SkillLocation } from "../skills/registry";
import { describeExtension, readJsonFile, type ExtensionProblem } from "./extension";

const LARGE = 5 * 1024 * 1024;
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".ps1", ".bat", ".cmd", ".js", ".mjs", ".cjs", ".ts", ".py", ".rb", ".pl"]);

export interface ValidationReport {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly valid: boolean;
  readonly components: { readonly skills: readonly string[]; readonly commands: readonly string[]; readonly hooks: number; readonly connectors: readonly string[] };
  readonly problems: readonly ExtensionProblem[];
}

function walk(dir: string, visit: (file: string, size: number) => void, depth = 0): void {
  if (depth > 8) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === ".git" || e === "node_modules") continue;
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, visit, depth + 1);
    else visit(p, s.size);
  }
}

/** Steps 2 and 3: every check of § 5.1; undefined when the path does not exist (ERR-01). */
export function validateExtension(root: string): ValidationReport | undefined {
  if (!existsSync(root) || !statSync(root).isDirectory()) return undefined;
  const ext = describeExtension(root, false);
  const problems: ExtensionProblem[] = [...ext.problems];
  // Headers of the skills and commands; unknown tools in their rules.
  const locations: SkillLocation[] = [...ext.skillsDirs.map((d) => ({ scope: "extension" as const, skillsDir: d, namespace: ext.name })), ...ext.commandsDirs.map((d) => ({ scope: "extension" as const, commandsDir: d, namespace: ext.name }))];
  const skills = loadSkills(locations);
  for (const w of skills.warnings) problems.push({ level: "error", file: root, message: w });
  for (const s of skills.skills.values())
    for (const raw of s.tools) {
      const rule = parseRule(raw, "allow", "session", root);
      if (!isRule(rule)) problems.push({ level: "warning", file: s.file, message: rule.message });
    }
  // Hooks and connectors conform to their formats.
  let hooks = 0;
  if (ext.hooksFile) {
    const read = readJsonFile(ext.hooksFile);
    const raw = read.value as Record<string, unknown> | undefined;
    const events = raw && typeof raw["hooks"] === "object" ? raw["hooks"] : raw;
    if (read.error) problems.push({ level: "error", file: ext.hooksFile, line: read.error.line, message: read.error.message });
    else {
      const snapshot = buildSnapshot([{ origin: "extension", value: events, file: ext.hooksFile }], { managedOnly: false, noHooks: false, maxTimeoutMs: 600_000 });
      hooks = snapshot.declarations.length;
      for (const w of snapshot.warnings) problems.push({ level: "error", file: ext.hooksFile, message: w });
      for (const i of snapshot.ignored) problems.push({ level: "error", file: ext.hooksFile, message: `Crochet ${i.label} ignoré : ${i.reason}.` });
      for (const d of snapshot.declarations) for (const a of d.actions) if (a.type === "command") problems.push({ level: "info", file: ext.hooksFile, message: `Code exécutable : commande du crochet ${d.label} : ${a.command}` });
    }
  }
  let connectors: string[] = [];
  if (ext.connectorsFile) {
    const read = readJsonFile(ext.connectorsFile);
    if (read.error) problems.push({ level: "error", file: ext.connectorsFile, line: read.error.line, message: read.error.message });
    else {
      const set = resolveConnectors([{ scope: "extension", source: ext.connectorsFile, content: read.value as Record<string, unknown>, prefix: ext.name }], {
        connectorsOnly: false,
        denyList: [],
        managedServersOnly: false,
        projectChoice: () => "approved",
      });
      connectors = set.connectors.map((c) => c.name);
      for (const w of set.warnings) problems.push({ level: "error", file: ext.connectorsFile, message: w });
      for (const c of set.connectors) if (c.command) problems.push({ level: "info", file: ext.connectorsFile, message: `Code exécutable : connecteur ${c.name} : ${[c.command, ...c.args].join(" ")}` });
    }
  }
  if (ext.unsupported.length > 0) problems.push({ level: "info", file: root, message: `Composants non chargés par cette version : ${ext.unsupported.join(", ")}.` });
  walk(root, (file, size) => {
    if (size > LARGE) problems.push({ level: "warning", file, message: `Fichier volumineux (${Math.round(size / 1024 / 1024)} Mo).` });
    if (SCRIPT_EXTENSIONS.has(extname(file).toLowerCase())) problems.push({ level: "info", file, message: "Code exécutable : script." });
  });
  const all = [...skills.skills.values()];
  return {
    path: root,
    name: ext.name,
    version: ext.version,
    valid: !problems.some((p) => p.level === "error"),
    components: { skills: all.filter((s) => !s.command).map((s) => s.name), commands: all.filter((s) => s.command).map((s) => s.name), hooks, connectors },
    problems,
  };
}

const LEVEL = { error: "erreur", warning: "avertissement", info: "information" } as const;

/** Text form of the report (EF-02: file and position of each problem). */
export function renderValidation(r: ValidationReport): string {
  const c = r.components;
  const list = (names: readonly string[]) => (names.length > 0 ? names.join(", ") : "aucune");
  return [
    `Extension ${r.name} (${r.version}) : ${r.path}`,
    `Composants : compétences : ${list(c.skills)} ; commandes : ${list(c.commands)} ; crochets : ${c.hooks} ; connecteurs : ${c.connectors.length > 0 ? c.connectors.join(", ") : "aucun"}.`,
    ...r.problems.map((p) => `${LEVEL[p.level]} : ${p.file}${p.line ? `:${p.line}` : ""} : ${p.message}`),
    r.valid ? "Validation réussie." : `Validation échouée : ${r.problems.filter((p) => p.level === "error").length} erreur(s).`,
  ].join("\n");
}
