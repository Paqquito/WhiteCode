// Implements: SPEC-MCP-014 (CA-01/02/03, allowlisted session metadata).
// Supports: SPEC-EXT-019/020, SPEC-PER-001, gap E-164.
import { splitHeader, type Skill, type SkillSet } from "./registry";
import { loadSkill, type Caller, type Loaded } from "./invoke";

export interface PublishedSkillsPort {
  resources(): readonly { server: string; uri: string }[];
  connected(server: string): boolean;
  read(server: string, uri: string, signal: AbortSignal): Promise<readonly { uri: string; text?: string }[]>;
}
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const DEFINITION = /^skill:\/\/([a-z0-9]+(?:-[a-z0-9]+)*)\/definition\.md$/;
const MAX_DEFINITION = 64 * 1024;

/** Only headers remain cached; bodies and associated resources stay at their connector. */
export class PublishedSkills {
  readonly #skills = new Map<string, Skill>();
  #generation = 0;
  constructor(readonly options: { readonly port: PublishedSkillsPort; readonly allowed: () => readonly string[]; readonly denied: (server: string) => boolean; readonly redact?: (text: string) => string; readonly report: (message: string) => void }) {}
  #admitted(server: string): boolean { return this.options.allowed().includes(server) && !this.options.denied(server) && this.options.port.connected(server); }
  #parse(server: string, uri: string, text: string): Skill | undefined {
    const match = DEFINITION.exec(uri); if (!match || Buffer.byteLength(text) > MAX_DEFINITION) return undefined;
    const parsed = splitHeader(text), h = parsed.header, name = match[1]!;
    if (parsed.invalid || !h || h["name"] !== undefined && h["name"] !== name || !NAME.test(name) || typeof h["description"] !== "string" || !h["description"].trim() || h["description"].length > 1024 || /[\u0000-\u001f\u007f]/.test(h["description"])) return undefined;
    const tools = h["tools"] ?? [], invocation = h["invocation"] ?? "both";
    if (!Array.isArray(tools) || tools.length > 64 || tools.some(tool => typeof tool !== "string" || tool.length > 512) || !["both", "user", "model"].includes(String(invocation))) return undefined;
    if ([h["description"], ...tools].some(value => this.options.redact && this.options.redact(String(value)) !== value)) return undefined;
    // Remote hooks and executable/context overrides are never installed from an untrusted header.
    return { name: `cnx_${server}_${name}`, description: h["description"].trim(), tools: tools as string[], invocation: invocation as Skill["invocation"], context: "inline", scope: "extension", root: `skill://${name}/`, file: uri, command: false, connector: { server, uri } };
  }
  async refresh(signal: AbortSignal): Promise<void> {
    const generation = ++this.#generation, next = new Map<string, Skill>();
    const resources = this.options.port.resources().filter(resource => this.#admitted(resource.server) && DEFINITION.test(resource.uri)).slice(0, 32);
    for (const resource of resources) {
      signal.throwIfAborted();
      try {
        const values = await this.options.port.read(resource.server, resource.uri, signal), text = values.find(value => value.uri === resource.uri)?.text;
        if (text === undefined || !this.#admitted(resource.server)) continue;
        const skill = this.#parse(resource.server, resource.uri, text); if (skill) next.set(skill.name, skill);
      } catch { this.options.report(`Compétence du connecteur ${resource.server} indisponible.`); }
    }
    if (generation !== this.#generation) return;
    this.#skills.clear(); for (const [name, skill] of next) this.#skills.set(name, skill);
  }
  merge(local: SkillSet): SkillSet {
    const skills = new Map(local.skills);
    for (const [name, skill] of this.#skills) if (!skills.has(name) && skill.connector && this.#admitted(skill.connector.server)) skills.set(name, skill);
    return { ...local, skills };
  }
  async load(set: SkillSet, name: string, args: string, caller: Caller, variables: Parameters<typeof loadSkill>[4], signal: AbortSignal): Promise<Loaded> {
    const selected = set.skills.get(name), remote = selected?.connector;
    if (!remote) return loadSkill(set, name, args, caller, variables);
    const unavailable = (): Loaded => ({ ok: false, kind: "unavailable", message: caller === "user" ? `Compétence distante indisponible : ${name}.` : `Remote skill unavailable: ${name}.` });
    if (!this.#admitted(remote.server) || selected!.invocation !== "both" && selected!.invocation !== caller) return unavailable();
    try {
      const values = await this.options.port.read(remote.server, remote.uri, signal), text = values.find(value => value.uri === remote.uri)?.text;
      signal.throwIfAborted(); if (!text || !this.#admitted(remote.server)) return unavailable();
      const current = this.#parse(remote.server, remote.uri, text); if (!current || current.description !== selected!.description || JSON.stringify(current.tools) !== JSON.stringify(selected!.tools) || current.invocation !== selected!.invocation) return unavailable();
      const body = splitHeader(text).body, skills = new Map(set.skills); skills.set(name, { ...selected!, content: this.options.redact?.(body) ?? body });
      return loadSkill({ ...set, skills }, name, args, caller, variables);
    } catch { return unavailable(); }
  }
}
