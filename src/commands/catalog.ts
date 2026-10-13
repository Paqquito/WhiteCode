// Implements: SPEC-CMD-001 (§ 5.3 sources and priority, § 5.4 qualified names, § 5.5 kinds and widening commands, FA-01, FA-05, EF-01, EF-02, EF-07, EF-08, EF-10, EF-11, EF-13, ERR-01, ERR-04, ERR-06, CA-03, CA-04, CA-08, CA-09),
//             SPEC-CMD-030 (§ 5.1, EF-01, CA-01), SPEC-MCP-011 (EF-02, EF-04)
// The catalogue of the commands of a session and the resolution of a name. Internal commands always win; a command of
// the project masks the one of the user; a short name claimed by several third-party contributions (extensions,
// connectors) belongs to none. The result never depends on the loading order.

import type { McpPromptInfo } from "../connectors/stdio-client";
import { suggest } from "../shared/suggest";
import type { Skill, SkillSet } from "../skills/registry";

export type CommandKind = "display" | "prompt" | "action" | "mixed";

export interface InternalCommand {
  readonly name: string;
  readonly description: string;
  readonly kind: CommandKind;
  /** EF-13: a command able to extend what the agent does without asking. */
  readonly widening: boolean;
  readonly usage?: string;
  /** FA-04: refused in an automated run, with an explanation. */
  readonly interactiveOnly?: boolean;
  readonly hidden?: boolean;
}

export interface ConnectorPromptCommand {
  readonly command: string;
  readonly server: string;
  readonly prompt: McpPromptInfo;
  readonly available: boolean;
}

export type CommandSource = "internal" | "managed" | "project" | "user" | "extension" | "connector";

export interface CatalogEntry {
  /** Name to type, without the slash: the short name when available, otherwise the qualified one. */
  readonly name: string;
  readonly source: CommandSource;
  readonly description: string;
  readonly usage?: string;
}

export type Resolution =
  | { readonly kind: "internal"; readonly command: InternalCommand }
  | { readonly kind: "skill"; readonly skill: Skill; readonly name: string }
  | { readonly kind: "connector"; readonly entry: ConnectorPromptCommand }
  | { readonly kind: "ambiguous"; readonly message: string }
  | { readonly kind: "disabled"; readonly message: string }
  | { readonly kind: "unknown"; readonly message: string };

/** Usage of a prompt of a connector: its arguments in the declared order, the optional ones in brackets. */
export function promptUsage(p: McpPromptInfo): string {
  return (p.arguments ?? []).map((a) => (a.required ? `<${a.name}>` : `[${a.name}]`)).join(" ");
}

export class CommandCatalog {
  readonly warnings: string[] = [];
  readonly #internal: ReadonlyMap<string, InternalCommand>;
  readonly #skills: SkillSet;
  readonly #connectors: ReadonlyMap<string, ConnectorPromptCommand>;
  readonly #disabled: ReadonlySet<string>;
  /** Automated run: the commands of the interface are neither listed nor suggested (FA-04). */
  readonly #automated: boolean;
  /** Third-party short names: short name → qualified names (extension commands and connector prompts). */
  readonly #claims = new Map<string, string[]>();
  readonly #thirdParty = new Map<string, { kind: "skill"; skill: Skill } | { kind: "connector"; entry: ConnectorPromptCommand }>();

  constructor(o: {
    readonly internal: readonly InternalCommand[];
    readonly skills: SkillSet;
    readonly connectors: readonly ConnectorPromptCommand[];
    readonly disabled: readonly string[];
    readonly automated?: boolean;
  }) {
    this.#automated = o.automated ?? false;
    this.#internal = new Map(o.internal.map((c) => [c.name, c]));
    this.#skills = o.skills;
    this.#connectors = new Map(o.connectors.map((c) => [c.command, c]));
    this.#disabled = new Set(o.disabled.map((n) => n.replace(/^\//, "")));
    // EF-01, EF-07, CA-03: an internal command masks any command of the same name, which stays reachable when qualified.
    for (const s of o.skills.skills.values()) {
      if (s.extension || !this.#internal.has(s.name)) continue;
      const reach = s.scope === "project" || s.scope === "user" ? ` ; elle reste joignable par /${s.scope}:${s.name}` : "";
      this.warnings.push(`La commande /${s.name} de portée ${s.scope} est masquée par la commande interne du même nom${reach}.`);
    }
    // § 5.3 points 3 and 4: the short names of third-party contributions, unless an internal or local command holds them.
    for (const s of o.skills.skills.values()) {
      if (!s.extension || !s.command) continue;
      this.#claim(s.name.slice(s.extension.length + 1), s.name, { kind: "skill", skill: s });
    }
    for (const c of o.connectors) this.#claim(c.prompt.name, c.command, { kind: "connector", entry: c });
  }

  #claim(short: string, qualified: string, target: { kind: "skill"; skill: Skill } | { kind: "connector"; entry: ConnectorPromptCommand }): void {
    if (this.#internal.has(short) || this.#localSkill(short)) return;
    this.#claims.set(short, [...(this.#claims.get(short) ?? []), qualified].sort());
    this.#thirdParty.set(qualified, target);
  }

  /** A skill or command of the managed, project or user scope, invocable by the user. */
  #localSkill(name: string): Skill | undefined {
    const s = this.#skills.skills.get(name);
    return s && !s.extension && s.invocation !== "model" ? s : undefined;
  }

  #isDisabled(...names: string[]): boolean {
    return names.some((n) => this.#disabled.has(n));
  }

  resolve(name: string): Resolution {
    const disabled: Resolution = { kind: "disabled", message: "Cette commande est désactivée par la politique en vigueur." }; // ERR-06
    const internal = this.#internal.get(name);
    if (internal) return this.#isDisabled(name) ? disabled : { kind: "internal", command: internal };
    // Qualified forms (§ 5.4): `project:<name>`, `user:<name>`, `<extension>:<name>`, `cnx_<server>_<prompt>`.
    const qualified = this.#skills.qualified.get(name);
    if (qualified) return this.#isDisabled(name, qualified.name) ? disabled : { kind: "skill", skill: qualified, name };
    const local = this.#localSkill(name);
    if (local) return this.#isDisabled(name) ? disabled : { kind: "skill", skill: local, name };
    const extension = this.#skills.skills.get(name);
    if (extension && extension.extension && extension.invocation !== "model") return this.#isDisabled(name) ? disabled : { kind: "skill", skill: extension, name };
    const connector = this.#connectors.get(name);
    if (connector) return this.#isDisabled(name) ? disabled : { kind: "connector", entry: connector };
    const claims = this.#claims.get(name);
    if (claims && claims.length > 1) {
      return { kind: "ambiguous", message: `Plusieurs commandes portent le nom ${name} : utilisez ${claims.map((n) => `/${n}`).join(" ou ")}.` }; // ERR-04, CA-04, CA-08
    }
    if (claims && claims.length === 1) {
      const target = this.#thirdParty.get(claims[0]!)!;
      if (this.#isDisabled(name, claims[0]!)) return disabled;
      return target.kind === "skill" ? { kind: "skill", skill: target.skill, name: claims[0]! } : { kind: "connector", entry: target.entry };
    }
    const near = suggest(name, this.entries().map((e) => e.name), 3);
    return { kind: "unknown", message: `Commande inconnue : /${name}.${near.length > 0 ? ` Noms proches : ${near.map((n) => `/${n}`).join(", ")}.` : ""}` }; // FA-01, ERR-01
  }

  /** EF-08: the catalogue, by source then by name; disabled commands are left out (SPEC-CMD-030 EF-01). */
  entries(): CatalogEntry[] {
    const out: CatalogEntry[] = [];
    for (const c of this.#internal.values()) if (!c.hidden && !this.#isDisabled(c.name) && !(this.#automated && c.interactiveOnly)) out.push({ name: c.name, source: "internal", description: c.description, usage: c.usage });
    for (const s of this.#skills.skills.values()) {
      if (s.extension || s.invocation === "model" || this.#internal.has(s.name) || this.#isDisabled(s.name)) continue;
      out.push({ name: s.name, source: s.scope === "product" ? "internal" : s.scope, description: s.description, usage: s.argumentsHelp });
    }
    for (const [key, s] of this.#skills.qualified) {
      // A masked command is listed under its qualified form only.
      if (this.#skills.skills.get(s.name) === s && !this.#internal.has(s.name)) continue;
      if (!this.#isDisabled(key)) out.push({ name: key, source: s.scope === "product" ? "internal" : s.scope, description: s.description, usage: s.argumentsHelp });
    }
    const shortOf = new Map<string, string>();
    for (const [short, names] of this.#claims) if (names.length === 1) shortOf.set(names[0]!, short);
    for (const s of this.#skills.skills.values()) {
      if (!s.extension || s.invocation === "model") continue;
      const name = shortOf.get(s.name) ?? s.name;
      if (!this.#isDisabled(name, s.name)) out.push({ name, source: "extension", description: s.description, usage: s.argumentsHelp });
    }
    for (const c of this.#connectors.values()) {
      const name = shortOf.get(c.command) ?? c.command;
      if (!this.#isDisabled(name, c.command)) out.push({ name, source: "connector", description: `${c.prompt.description ?? c.prompt.name} (connecteur ${c.server}${c.available ? "" : ", indisponible"})`, usage: promptUsage(c.prompt) || undefined });
    }
    return out;
  }
}
