// Implements: SPEC-EXT-011 (§ 5.1, § 5.3 steps 1 to 4, FA-03, EF-01 to EF-03, ERR-01, ERR-03, CA-01 to CA-03), SPEC-EXT-014 (§ 5.1, § 5.3, EF-01, ERR-01),
//             SPEC-EXT-015 (§ 5.1, § 5.3 step 3, FA-01, EF-01, EF-02, ERR-01, CA-02), SPEC-EXT-001 (EF-03)
// The components of the active extensions, each under the namespace of its extension: skills and commands, hooks
// (scope `extension`), connectors (`<extension>-<name>`), with the variables of the extension substituted.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectorSource } from "../connectors/declarations";
import type { SkillLocation } from "../skills/registry";
import { parseAgent, type AgentDefinition } from "../agents/definitions";
import { compileRaw, describeErrors } from "../shared/schema";
import { describeExtension, readJsonFile, substituteVariables, type Extension } from "./extension";

export interface ActiveExtension {
  readonly root: string;
  /** Where it comes from: `session` for `--extension-dir` (SPEC-EXT-014 § 5.1), `installed` for a copy of a catalogue. */
  readonly origin: "session" | "installed";
  /** Identifier shown: `<name>@session`, or `<name>@<catalogue>` for an installed one. */
  readonly id?: string;
}

export interface ExtensionContributions {
  readonly loaded: ReadonlyArray<{ readonly id: string; readonly extension: Extension }>;
  readonly skillLocations: readonly SkillLocation[];
  readonly agents: readonly AgentDefinition[];
  readonly hookSources: ReadonlyArray<{ readonly origin: "extension"; readonly value: unknown; readonly file: string; readonly labelScope: string }>;
  readonly connectorSources: readonly ConnectorSource[];
  readonly languageSources?: ReadonlyArray<{ readonly name: string; readonly servers: Record<string, unknown> }>;
  /** Load report: one line per extension (step 4)… */
  readonly summaries: ReadonlyArray<{ readonly origin: ActiveExtension["origin"]; readonly text: string }>;
  /** …and the problems, by component (EF-03). */
  readonly report: readonly string[];
}

export interface LoadInputs {
  readonly secretOptions?: Readonly<Record<string,Readonly<Record<string,string>>>>;
  /** `extensions.options`: values by extension, then by option. */
  readonly options: Readonly<Record<string, unknown>>;
  /** Persistent data folder of an extension (`${EXTENSION_DATA}`). */
  readonly dataDir: (name: string) => string;
}

interface OptionValues {
  readonly values: Record<string, unknown>;
  /** Required options without a usable value (FA-01). */
  readonly missingRequired: ReadonlySet<string>;
  readonly notes: string[];
}

/** SPEC-EXT-015: defaults of the schema, then the settings; invalid values refused (ERR-01); secret options never read from a file (EF-01). */
function optionValues(ext: Extension, given: unknown, secrets:Readonly<Record<string,string>>={}): OptionValues {
  const notes: string[] = [];
  const schema = ext.optionsSchema ?? {};
  const properties = (schema["properties"] ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema["required"]) ? (schema["required"] as string[]) : []);
  const values: Record<string, unknown> = {};
  const input = (typeof given === "object" && given !== null ? given : {}) as Record<string, unknown>;
  for (const [name, def] of Object.entries(properties)) {
    if(def["secret"]===true){if(input[name]!==undefined)notes.push(`option secrète ${name} ignorée : jamais lue d'un fichier de paramètres.`);const{secret:_secret,default:_default,...plain}=def;if(secrets[name]!==undefined&&compileRaw(plain)(secrets[name]))values[name]=secrets[name];continue;}
    if (def["default"] !== undefined) values[name] = def["default"];
    if (input[name] === undefined) continue;
    const { secret: _secret, ...plain } = def;
    const validate = compileRaw(plain);
    if (validate(input[name])) values[name] = input[name];
    else notes.push(`Valeur invalide pour ${name} : ${describeErrors(validate.errors).join(" ; ")}.`);
  }
  const missingRequired = new Set([...required].filter((n) => values[n] === undefined));
  return { values, missingRequired, notes };
}

function countEntries(dirs: readonly string[], skills: boolean): number {
  let n = 0;
  for (const d of dirs) {
    try {
      for (const e of readdirSync(d)) n += skills ? (existsSync(join(d, e, "definition.md")) ? 1 : 0) : e.endsWith(".md") ? 1 : 0;
    } catch {
      // unreadable folder: nothing counted
    }
  }
  return n;
}

/** Steps 1 to 4 for the active extensions; FA-03: two of the same name are both left out. */
export function loadExtensions(active: readonly ActiveExtension[], inputs: LoadInputs): ExtensionContributions {
  const report: string[] = [];
  const summaries: Array<{ origin: ActiveExtension["origin"]; text: string }> = [];
  const described = active.map((a) => ({ a, ext: describeExtension(a.root, a.origin === "session") }));
  // SPEC-EXT-014 § 5.1: a session extension takes the place of an installed one of the same name.
  const sessionNames = new Set(described.filter((d) => d.a.origin === "session").map((d) => d.ext.name));
  const kept = described.filter((d) => d.a.origin === "session" || !sessionNames.has(d.ext.name));
  const byName = new Map<string, string[]>();
  for (const { a, ext } of kept) byName.set(ext.name, [...(byName.get(ext.name) ?? []), a.root]);
  const loaded: Array<{ id: string; extension: Extension }> = [];
  const skillLocations: SkillLocation[] = [];
  const agents: AgentDefinition[] = [];
  const hookSources: Array<{ origin: "extension"; value: unknown; file: string; labelScope: string }> = [];
  const connectorSources: ConnectorSource[] = [];
  const languageSources: Array<{ name: string; servers: Record<string, unknown> }> = [];
  for (const { a, ext } of [...kept].sort((x, y) => (x.ext.name < y.ext.name ? -1 : 1))) {
    const id = a.id ?? `${ext.name}@${a.origin}`;
    const origins = byName.get(ext.name)!;
    if (origins.length > 1) {
      if (origins[0] === a.root) report.push(`Deux extensions actives portent le nom ${ext.name} (${origins.join(", ")}) ; désactivez-en une.`); // ERR-03
      continue;
    }
    for (const p of ext.problems.filter((x) => x.level !== "info")) report.push(`Extension ${id} : ${p.message}${p.line ? ` (${p.file}, ligne ${p.line})` : ""}`);
    if (!ext.usable) {
      report.push(`Extension ${id} non chargée.`);
      continue;
    }
    const opts = optionValues(ext, inputs.options[ext.name],inputs.secretOptions?.[id]);
    for (const n of opts.notes) report.push(`Extension ${id} : ${n}`);
    const vars = { root: ext.root, data: inputs.dataDir(ext.name), options: opts.values };
    const secretNames=new Set(Object.entries((ext.optionsSchema?.["properties"]??{})as Record<string,Record<string,unknown>>).filter(([,def])=>def["secret"]===true).map(([name])=>name));
    const promptVars={...vars,options:Object.fromEntries(Object.entries(opts.values).filter(([name])=>!secretNames.has(name)))};
    /** A component that needs a required option without value is disabled (FA-01, CA-02). */
    const blockedBy = (missing: Set<string>) => [...missing].filter((m) => opts.missingRequired.has(m));
    // Skills and commands (namespace `<extension>:`).
    for (const d of ext.skillsDirs) skillLocations.push({ scope: "extension", skillsDir: d, namespace: ext.name });
    for (const d of ext.commandsDirs) skillLocations.push({ scope: "extension", commandsDir: d, namespace: ext.name });
    for (const dir of ext.agentsDirs) {
      let files: string[];
      try { files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { continue; }
      for (const name of files) {
        const file = join(dir, name);
        try {
          const missing = new Set<string>();
          const text = substituteVariables(readFileSync(file, "utf8"), promptVars, missing) as string;
          const blocked = [...missing].filter(name=>secretNames.has(name)||opts.missingRequired.has(name));
          if (blocked.length) { report.push(`Extension ${id} : agent ${file} désactivé : option requise ${blocked.join(", ")} non renseignée.`); continue; }
          const def = parseAgent(text, file, "extension", (m) => report.push(`Extension ${id} : ${m}`));
          if (typeof def === "string") report.push(`Extension ${id} : agent invalide (${file}) : ${def}.`);
          else agents.push({ ...def, name: `${ext.name}:${def.name}` });
        } catch { report.push(`Extension ${id} : agent illisible (${file}).`); }
      }
    }
    // Hooks (format of SPEC-HOK-002), one declaration at a time.
    let hookCount = 0;
    if (ext.hooksFile) {
      const read = readJsonFile(ext.hooksFile);
      const raw = read.value as Record<string, unknown> | undefined;
      const events = (raw && typeof raw["hooks"] === "object" ? raw["hooks"] : raw) as Record<string, unknown> | undefined;
      if (read.error || typeof events !== "object" || events === null || Array.isArray(events)) report.push(`Extension ${id} : composant ${ext.hooksFile} ignoré (${read.error ? `JSON invalide, ligne ${read.error.line}` : "objet d'événements attendu"}).`); // ERR-01
      else {
        const kept: Record<string, unknown[]> = {};
        for (const [event, list] of Object.entries(events)) {
          (Array.isArray(list) ? list : []).forEach((decl, i) => {
            const missing = new Set<string>();
            const value = substituteVariables(decl, vars, missing);
            const blocked = blockedBy(missing);
            if (blocked.length > 0) report.push(`Extension ${id} : crochet ${event} #${i + 1} désactivé : option requise ${blocked.join(", ")} non renseignée.`);
            else (kept[event] ??= []).push(value);
          });
        }
        hookCount = Object.values(kept).reduce((n, l) => n + l.length, 0);
        hookSources.push({ origin: "extension", value: kept, file: ext.hooksFile, labelScope: id });
      }
    }
    // Connectors (format of SPEC-MCP-001), named `<extension>-<name>`.
    let connectorCount = 0;
    if (ext.connectorsFile) {
      const read = readJsonFile(ext.connectorsFile);
      const servers = (read.value as { servers?: unknown } | undefined)?.servers;
      if (read.error || typeof servers !== "object" || servers === null || Array.isArray(servers)) report.push(`Extension ${id} : composant ${ext.connectorsFile} ignoré (${read.error ? `JSON invalide, ligne ${read.error.line}` : "objet servers attendu"}).`);
      else {
        const kept: Record<string, unknown> = {};
        for (const [name, decl] of Object.entries(servers)) {
          const missing = new Set<string>();
          const value = substituteVariables(decl, vars, missing);
          const blocked = blockedBy(missing);
          if (blocked.length > 0) report.push(`Extension ${id} : connecteur ${name} désactivé : option requise ${blocked.join(", ")} non renseignée.`);
          else kept[name] = value;
        }
        connectorCount = Object.keys(kept).length;
        connectorSources.push({ scope: "extension", source: ext.connectorsFile, content: { servers: kept }, prefix: ext.name });
      }
    }
    if (ext.unsupported.length > 0) report.push(`Extension ${id} : composants non chargés dans cette version : ${ext.unsupported.join(", ")}.`);
    if (ext.languageServersFile) {
      try {
        const read = readJsonFile(ext.languageServersFile), servers = (read.value as { servers?: unknown } | undefined)?.servers;
        if (read.error || !servers || typeof servers !== "object" || Array.isArray(servers)) report.push(`Extension ${id} : serveurs de langage ignorés (objet servers attendu).`);
        else {
          const kept: Record<string, unknown> = {};
          for (const [name, decl] of Object.entries(servers)) {
            const missing = new Set<string>(), value = substituteVariables(decl, vars, missing), blocked = blockedBy(missing);
            if (blocked.length) report.push(`Extension ${id} : serveur de langage ${name} désactivé : option requise ${blocked.join(", ")} non renseignée.`);
            else kept[`${ext.name}-${name}`] = value;
          }
          languageSources.push({ name: ext.name, servers: kept });
        }
      } catch { report.push(`Extension ${id} : déclaration de serveurs de langage illisible.`); }
    }
    const skills = countEntries(ext.skillsDirs, true);
    const commands = countEntries(ext.commandsDirs, false);
    summaries.push({ origin: a.origin, text: `${a.origin === "session" ? "Extension de développement active" : "Extension active"} : ${id} (${ext.version}) — ${skills} compétence(s), ${commands} commande(s), ${hookCount} crochet(s), ${connectorCount} connecteur(s).` });
    loaded.push({ id, extension: ext });
  }
  return { loaded, skillLocations, agents, hookSources, connectorSources, languageSources, summaries, report };
}
