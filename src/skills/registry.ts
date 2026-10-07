// Implements: SPEC-EXT-019 (§ 5.1 header, § 5.2 locations and priority, § 5.4 steps 1, 2 and 4, FA-01, FA-02, EF-01, EF-03 to EF-05, ERR-01, ERR-02, CA-02 to CA-04),
//             SPEC-EXT-011 (§ 5.1 names of the skills and commands of an extension, FA-01, EF-01, EF-02)
// The skills of a session: folders holding a `definition.md` (a YAML header, then Markdown instructions), and the
// simple commands (`commands/*.md`, invoked by the user only). Only the headers are read before an invocation.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseYaml } from "../platform/yaml";

export type SkillScope = "managed" | "project" | "user" | "extension";
export type Invocation = "user" | "model" | "both";

export interface Skill {
  readonly name: string;
  readonly description: string;
  readonly invocation: Invocation;
  readonly argumentsHelp?: string;
  /** Rules allowed without request while the skill is active (§ 5.1 `tools`). */
  readonly tools: readonly string[];
  readonly model?: string;
  readonly context: "inline" | "agent";
  readonly scope: SkillScope;
  /** Folder of the skill (`${SKILL_ROOT}`), or the folder of a command file. */
  readonly root: string;
  /** File holding the header and the instructions. */
  readonly file: string;
  /** A simple command (FA-02) rather than a skill folder. */
  readonly command: boolean;
  /** Extension providing it: its name is then `<extension>:<name>` (SPEC-EXT-011 EF-01). */
  readonly extension?: string;
}

export interface SkillLocation {
  readonly scope: SkillScope;
  /** Folder of skill folders. */
  readonly skillsDir?: string;
  /** Folder of simple commands, when the scope has one (FA-02). */
  readonly commandsDir?: string;
  /** Name of the extension that provides the location (scope `extension`). */
  readonly namespace?: string;
}

export interface SkillSet {
  /** Effective skills by name, after priority (EF-03). */
  readonly skills: ReadonlyMap<string, Skill>;
  /** Short names of extension commands, when available (SPEC-EXT-011 FA-01): short name → qualified name. */
  readonly aliases: ReadonlyMap<string, string>;
  /** Short names claimed by several extensions: available to none, their qualified names listed. */
  readonly ambiguous: ReadonlyMap<string, readonly string[]>;
  /** Qualified forms `project:<name>` and `user:<name>`, masked or not (SPEC-CMD-001 § 5.4, CA-09). */
  readonly qualified: ReadonlyMap<string, Skill>;
  readonly warnings: readonly string[];
}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PRIORITY: readonly SkillScope[] = ["managed", "project", "user", "extension"];
export const DEFINITION_FILE = "definition.md";

/** Header and body of a Markdown file with a `---` YAML header; the whole text is the body without header. */
export function splitHeader(text: string): { header: Record<string, unknown> | undefined; body: string; invalid?: string } {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { header: undefined, body: text };
  try {
    const data = parseYaml(m[1]!);
    if (data !== null && data !== undefined && (typeof data !== "object" || Array.isArray(data))) return { header: undefined, body: text.slice(m[0].length), invalid: "l'en-tête n'est pas un objet" };
    return { header: (data ?? {}) as Record<string, unknown>, body: text.slice(m[0].length) };
  } catch (e) {
    return { header: undefined, body: text.slice(m[0].length), invalid: e instanceof Error ? e.message.split("\n")[0] : "YAML invalide" };
  }
}

/** Steps 1 and 2 for one file: the header validated (ERR-01, ERR-02). */
function readSkill(file: string, folderName: string, scope: SkillScope, command: boolean, warnings: string[]): Skill | undefined {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const { header, body, invalid } = splitHeader(text);
  const what = command ? `Commande ${file}` : `Compétence ${folderName}`;
  if (invalid) {
    warnings.push(`${what} ignorée : en-tête invalide (${invalid}).`);
    return undefined;
  }
  const h = header ?? {};
  const problems: string[] = [];
  const name = h["name"] === undefined ? folderName : h["name"];
  if (typeof name !== "string" || !NAME.test(name)) problems.push(`nom invalide (${String(name)}), attendu en kebab-case`);
  let description = h["description"];
  // FA-02: a simple command without description takes the first line of its text.
  if (description === undefined && command) description = body.trim().split(/\r?\n/)[0]?.replace(/^#+\s*/, "").slice(0, 200) || folderName;
  if (typeof description !== "string" || description.trim() === "") problems.push("description absente"); // ERR-02
  else if (description.length > 1_024) problems.push("description de plus de 1 024 caractères");
  const invocation = command ? "user" : (h["invocation"] ?? "both");
  if (!["user", "model", "both"].includes(String(invocation))) problems.push(`invocation inconnue (${String(invocation)})`);
  const context = h["context"] ?? "inline";
  if (context !== "inline" && context !== "agent") problems.push(`contexte inconnu (${String(context)})`);
  const tools = h["tools"] ?? [];
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== "string")) problems.push("tools doit être une liste de règles");
  if (h["argumentsHelp"] !== undefined && typeof h["argumentsHelp"] !== "string") problems.push("argumentsHelp doit être un texte");
  if (h["model"] !== undefined && typeof h["model"] !== "string") problems.push("model doit être un texte");
  if (problems.length > 0) {
    warnings.push(`${what} ignorée : en-tête invalide : ${problems.join(" ; ")}.`); // ERR-01
    return undefined;
  }
  return {
    name: name as string,
    description: (description as string).trim(),
    invocation: invocation as Invocation,
    argumentsHelp: h["argumentsHelp"] as string | undefined,
    tools: tools as string[],
    model: h["model"] as string | undefined,
    context: context as "inline" | "agent",
    scope,
    root: dirname(file),
    file,
    command,
  };
}

function listDir(dir: string | undefined): string[] {
  if (dir === undefined) return [];
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Skills of one location: folders with a definition, then the simple commands. */
function readLocation(loc: SkillLocation, warnings: string[]): Skill[] {
  const out: Skill[] = [];
  for (const entry of listDir(loc.skillsDir)) {
    const file = join(loc.skillsDir!, entry, DEFINITION_FILE);
    if (!existsSync(file)) continue;
    const s = readSkill(file, entry, loc.scope, false, warnings);
    if (s) out.push(s);
  }
  if (loc.commandsDir)
    for (const entry of listDir(loc.commandsDir)) {
      if (!entry.endsWith(".md")) continue;
      const s = readSkill(join(loc.commandsDir, entry), basename(entry, ".md"), loc.scope, true, warnings);
      if (s && !out.some((x) => x.name === s.name)) out.push(s);
    }
  // SPEC-EXT-011 EF-01: the namespace of the extension.
  return loc.namespace ? out.map((s) => ({ ...s, name: `${loc.namespace}:${s.name}`, extension: loc.namespace })) : out;
}

/** § 5.2: managed, then project, then user; the first of a name wins (EF-03, CA-04). */
export function loadSkills(locations: readonly SkillLocation[]): SkillSet {
  const warnings: string[] = [];
  const skills = new Map<string, Skill>();
  const qualified = new Map<string, Skill>();
  for (const scope of PRIORITY)
    for (const loc of locations.filter((l) => l.scope === scope))
      for (const s of readLocation(loc, warnings)) {
        if ((s.scope === "project" || s.scope === "user") && !qualified.has(`${s.scope}:${s.name}`)) qualified.set(`${s.scope}:${s.name}`, s);
        const current = skills.get(s.name);
        if (!current) skills.set(s.name, s);
        else if (current.scope !== s.scope) {
          const reach = s.scope === "project" || s.scope === "user" ? ` ; elle reste joignable par /${s.scope}:${s.name}` : "";
          warnings.push(`La compétence ${s.name} de portée ${s.scope} est masquée par celle de portée ${current.scope}${reach}.`);
        }
      }
  // SPEC-EXT-011 FA-01, SPEC-CMD-001 § 5.3: the short name of an extension command, unless a skill or command of the
  // product, project or user holds it, or another extension claims it too; never dependent on the loading order.
  const claims = new Map<string, string[]>();
  for (const s of skills.values()) {
    if (!s.extension || !s.command) continue;
    const short = s.name.slice(s.extension.length + 1);
    claims.set(short, [...(claims.get(short) ?? []), s.name].sort());
  }
  const aliases = new Map<string, string>();
  const ambiguous = new Map<string, readonly string[]>();
  for (const [short, names] of [...claims].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (skills.has(short)) continue;
    if (names.length === 1) aliases.set(short, names[0]!);
    else ambiguous.set(short, names);
  }
  return { skills: new Map([...skills].sort(([a], [b]) => (a < b ? -1 : 1))), aliases, ambiguous, qualified, warnings };
}

/** Signature of the locations (folders, definitions and their times), to detect a change during the session (EF-04). */
export function skillsSignature(locations: readonly SkillLocation[]): string {
  const parts: string[] = [];
  const stamp = (f: string) => {
    try {
      const s = statSync(f);
      return `${s.mtimeMs}:${s.size}`;
    } catch {
      return "-";
    }
  };
  for (const loc of locations) {
    for (const entry of listDir(loc.skillsDir)) parts.push(`${loc.skillsDir}/${entry}:${stamp(join(loc.skillsDir!, entry, DEFINITION_FILE))}`);
    if (loc.commandsDir) for (const entry of listDir(loc.commandsDir)) parts.push(`${loc.commandsDir}/${entry}:${stamp(join(loc.commandsDir, entry))}`);
  }
  return parts.join("|");
}

/** Skills the model may invoke (EF-05). */
export function modelSkills(set: SkillSet): Skill[] {
  return [...set.skills.values()].filter((s) => s.invocation !== "user");
}

/**
 * Section 8 of the system instructions (SPEC-MOT-003): name and description of each skill the model may invoke, the
 * descriptions shortened to stay within `skills.maxDescriptionsTokens` (EF-01: never the content).
 */
export function skillsSection(skills: readonly Skill[], maxTokens: number, estimate: (text: string) => number): string | undefined {
  if (skills.length === 0) return undefined;
  const head = "# Skills\nSkills are instructions prepared for a kind of task. When the task matches a skill, load it with use_skill before you start, then follow it.";
  let limit = 1_024;
  for (;;) {
    const lines = skills.map((s) => `- ${s.name}: ${s.description.length > limit ? `${s.description.slice(0, limit)}…` : s.description}`);
    const text = `${head}\n${lines.join("\n")}`;
    if (estimate(text) <= maxTokens || limit <= 40) return text;
    limit = Math.floor(limit / 2);
  }
}
