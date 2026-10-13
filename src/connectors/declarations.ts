// Implements: SPEC-MCP-001 (§ 5.1 locations and format, § 5.3 steps 1 to 3, FA-01, EF-01, EF-04, ERR-01 to ERR-03, RG-01),
//             SPEC-MCP-021 (§ 5.1, § 5.3, EF-01 to EF-03, ERR-01), SPEC-PER-019 (§ 5.3, FA-01, FA-02, EF-01, EF-02, RG-01)
// Supports: SPEC-MCP-003 (CA-03, secure declarations and request timeout), gap E-146.
// The effective connectors of a session: declarations read by scope, validated, resolved by priority, then filtered by
// the managed lists and by the approval of the project connectors.

import { parse, type ParseError } from "jsonc-parser";
import { fingerprint } from "../shared/fingerprint";
import { secureConnectorUrl } from "./url";
import type { OAuthConfiguration } from "./oauth";
// Supports: SPEC-MCP-006, SPEC-MCP-008 (validated declarations and approval fingerprints), gap E-155.

export type ConnectorScope = "managed" | "cli" | "local" | "project" | "user" | "extension";

export interface ConnectorDeclaration {
  readonly name: string;
  readonly scope: ConnectorScope;
  /** File, option or state entry the declaration comes from (EF-05). */
  readonly source: string;
  readonly transport: string;
  readonly command?: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly url?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly headersCommand?: string;
  readonly oauth?: OAuthConfiguration;
  /** Supports: SPEC-MCP-003: declaration timeout in milliseconds, after scope resolution. */
  readonly timeoutMs?: number;
  /** Threshold of large outputs for this connector (SPEC-MCP-020 EF-03), in estimated tokens. */
  readonly maxOutputTokens?: number;
  /** Digest of the declaration as written (SPEC-PER-019 RG-01). */
  readonly fingerprint: string;
  /** Marked indispensable by the managed configuration (SPEC-MOD-009 FA-04); read in the managed scope only. */
  readonly required?: boolean;
}

export interface ConnectorSource {
  readonly scope: ConnectorScope;
  readonly source: string;
  /** Raw text of a file, or an already parsed object (state entry). */
  readonly content: string | Record<string, unknown> | undefined;
  /** Name of the extension: its connectors are named `<extension>-<name>` (SPEC-EXT-011 § 5.1). */
  readonly prefix?: string;
}

export interface Excluded {
  readonly name: string;
  readonly scope: ConnectorScope;
  readonly reason: string;
}

export interface ConnectorSet {
  readonly connectors: readonly ConnectorDeclaration[];
  readonly excluded: readonly Excluded[];
  readonly warnings: readonly string[];
}

export type ProjectChoice = "approved" | "refused" | "pending" | "modified";

export interface ResolveOptions {
  /** `--connectors-only` (FA-01). */
  readonly connectorsOnly: boolean;
  /** `mcp.allowList`: undefined when not defined (everything allowed but the refusals). */
  readonly allowList?: readonly unknown[];
  readonly denyList: readonly unknown[];
  readonly managedServersOnly: boolean;
  /** Approval of a project connector (SPEC-PER-019). */
  readonly projectChoice: (d: ConnectorDeclaration) => ProjectChoice;
}

export const TRANSPORTS = new Set(["stdio", "http", "sse", "ws"]);
const NAME = /^[a-z0-9][a-z0-9-]{1,47}$/;
/** Priority of the scopes on a name conflict (§ 5.3 step 2); `managed` is added on top and never hidden. */
const PRIORITY: readonly ConnectorScope[] = ["cli", "local", "project", "user", "extension"];

/** A name that satisfies EF-04, proposed for an invalid one (ERR-03). */
export function normalizedName(name: string): string {
  const n = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return n.length >= 2 ? n : `${n}-x`.replace(/^-/, "x");
}

const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const stringMap = (v: unknown): v is Record<string, string> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");

/** Step 1 for one source: the `servers` object, each entry validated (ERR-01 to ERR-03). */
function readSource(src: ConnectorSource, warnings: string[]): ConnectorDeclaration[] {
  let data: unknown = src.content;
  if (typeof src.content === "string") {
    const errors: ParseError[] = [];
    data = parse(src.content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      warnings.push(`Configuration des connecteurs invalide dans ${src.source}.`); // ERR-01
      return [];
    }
  }
  if (data === undefined) return [];
  const servers = (data as { servers?: unknown })?.servers;
  if (typeof data !== "object" || data === null || (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers)))) {
    warnings.push(`Configuration des connecteurs invalide dans ${src.source}.`);
    return [];
  }
  const out: ConnectorDeclaration[] = [];
  for (const [short, raw] of Object.entries((servers ?? {}) as Record<string, unknown>)) {
    const name = src.prefix ? `${src.prefix}-${short}` : short;
    if (!NAME.test(name)) {
      warnings.push(`Nom de connecteur invalide : ${name} (${src.source}) ; nom proposé : ${normalizedName(name)}.`); // ERR-03
      continue;
    }
    const d = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const transport = typeof d["transport"] === "string" ? d["transport"] : typeof d["command"] === "string" ? "stdio" : typeof d["url"] === "string" ? "http" : undefined;
    if (transport === undefined || !TRANSPORTS.has(transport)) {
      warnings.push(`Transport inconnu pour ${name} (${src.source}).`); // ERR-02
      continue;
    }
    const problems: string[] = [];
    if (transport === "stdio" && (typeof d["command"] !== "string" || d["command"].trim() === "")) problems.push("commande absente");
    if (transport !== "stdio" && typeof d["url"] !== "string") problems.push("URL absente");
    if ((transport === "http" || transport === "sse") && typeof d["url"] === "string" && !d["url"].startsWith("${")) {
      try { secureConnectorUrl(d["url"].replace(/\$\{[^}]+\}/g, "localhost")); } catch { problems.push("URL non sécurisée refusée"); }
    }
    if (d["timeout"] !== undefined && !(Number.isInteger(d["timeout"]) && (d["timeout"] as number) > 0 && (d["timeout"] as number) <= 86_400_000)) problems.push("timeout doit être un entier de 1 à 86400000 millisecondes");
    if (d["headersCommand"] !== undefined && (transport === "stdio" || typeof d["headersCommand"] !== "string" || d["headersCommand"].trim() === "" || d["headersCommand"].length > 8192)) problems.push("headersCommand doit être une commande de transport distant");
    if (d["oauth"] !== undefined) {
      const a = d["oauth"] as Record<string, unknown> | null;
      if (transport === "stdio" || !a || typeof a !== "object" || Array.isArray(a) ||
          a["clientId"] !== undefined && (typeof a["clientId"] !== "string" || !a["clientId"] || a["clientId"].length > 2048) ||
          a["clientSecret"] !== undefined && (typeof a["clientSecret"] !== "string" || !/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(a["clientSecret"])) ||
          a["callbackPort"] !== undefined && (!Number.isInteger(a["callbackPort"]) || Number(a["callbackPort"]) < 0 || Number(a["callbackPort"]) > 65535) ||
          a["scopes"] !== undefined && (!strings(a["scopes"]) || a["scopes"].length > 100 || a["scopes"].some(s => !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/.test(s))) ||
          Object.keys(a).some(k => !["clientId", "clientSecret", "callbackPort", "scopes"].includes(k))) problems.push("configuration oauth invalide (secret par variable uniquement)");
    }
    if (d["args"] !== undefined && !strings(d["args"])) problems.push("args doit être une liste de textes");
    if (d["env"] !== undefined && !stringMap(d["env"])) problems.push("env doit associer des noms à des textes");
    if (d["headers"] !== undefined && !stringMap(d["headers"])) problems.push("headers doit associer des noms à des textes");
    if (d["cwd"] !== undefined && typeof d["cwd"] !== "string") problems.push("cwd doit être un texte");
    if (d["maxOutputTokens"] !== undefined && !(Number.isInteger(d["maxOutputTokens"]) && (d["maxOutputTokens"] as number) > 0)) problems.push("maxOutputTokens doit être un entier positif");
    if (problems.length > 0) {
      warnings.push(`Connecteur ${name} ignoré (${src.source}) : ${problems.join(" ; ")}.`);
      continue;
    }
    out.push({
      name,
      scope: src.scope,
      source: src.source,
      transport,
      command: typeof d["command"] === "string" ? d["command"] : undefined,
      args: (d["args"] as string[] | undefined) ?? [],
      env: (d["env"] as Record<string, string> | undefined) ?? {},
      cwd: typeof d["cwd"] === "string" ? d["cwd"] : undefined,
      url: typeof d["url"] === "string" ? d["url"] : undefined,
      headers: (d["headers"] as Record<string, string> | undefined) ?? {},
      headersCommand: typeof d["headersCommand"] === "string" ? d["headersCommand"] : undefined,
      oauth: d["oauth"] as OAuthConfiguration | undefined,
      timeoutMs: typeof d["timeout"] === "number" ? d["timeout"] : undefined,
      maxOutputTokens: typeof d["maxOutputTokens"] === "number" ? d["maxOutputTokens"] : undefined,
      fingerprint: fingerprint({ name, declaration: raw }),
      ...(src.scope === "managed" && d["required"] === true ? { required: true } : {}),
    });
  }
  return out;
}

/** `*` stands for any run of characters, `/` included. */
function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, (c) => `\\${c}`).replace(/\*/g, ".*")}$`);
}

/** One criterion of the managed lists: `{ name }`, `{ command }` (command and exact arguments, EF-03) or `{ url }` (pattern). */
function matches(criterion: unknown, d: ConnectorDeclaration): boolean {
  if (typeof criterion !== "object" || criterion === null) return false;
  const c = criterion as Record<string, unknown>;
  if (typeof c["name"] === "string") return c["name"] === d.name;
  if (c["command"] !== undefined) {
    const wanted = typeof c["command"] === "string" ? [c["command"]] : strings(c["command"]) ? c["command"] : undefined;
    return wanted !== undefined && d.command !== undefined && JSON.stringify(wanted) === JSON.stringify([d.command, ...d.args]);
  }
  if (typeof c["url"] === "string") return d.url !== undefined && wildcard(c["url"]).test(d.url);
  return false;
}

/** Steps 1 to 3 of SPEC-MCP-001 § 5.3. */
export function resolveConnectors(sources: readonly ConnectorSource[], o: ResolveOptions): ConnectorSet {
  const warnings: string[] = [];
  const excluded: Excluded[] = [];
  const read = sources.filter((s) => !o.connectorsOnly || s.scope === "cli" || s.scope === "managed").map((s) => ({ s, list: readSource(s, warnings) }));
  // Step 2: managed connectors are added and never hidden; then cli > local > project > user.
  const chosen = new Map<string, ConnectorDeclaration>();
  for (const { list } of read.filter((r) => r.s.scope === "managed")) for (const d of list) chosen.set(d.name, d);
  for (const scope of PRIORITY)
    for (const { list } of read.filter((r) => r.s.scope === scope))
      for (const d of list) {
        const current = chosen.get(d.name);
        if (!current) chosen.set(d.name, d);
        else if (current.scope === "managed") excluded.push({ name: d.name, scope: d.scope, reason: "masqué par le connecteur géré du même nom" });
        else excluded.push({ name: d.name, scope: d.scope, reason: `remplacé par la déclaration de portée ${current.scope}` });
      }
  // Step 3: refusals > managed only > allow list (SPEC-MCP-021 § 5.1), then the approval of project connectors.
  const connectors: ConnectorDeclaration[] = [];
  for (const d of chosen.values()) {
    let reason: string | undefined;
    if (o.denyList.some((c) => matches(c, d))) reason = "Connecteur bloqué par votre organisation (mcp.denyList).";
    else if (o.managedServersOnly && d.scope !== "managed") reason = "Connecteur bloqué par votre organisation : seuls les connecteurs gérés sont admis (mcp.managedServersOnly).";
    else if (o.allowList !== undefined && !o.allowList.some((c) => matches(c, d))) reason = "Connecteur bloqué par votre organisation : absent de mcp.allowList.";
    else if (d.scope === "project") {
      const choice = o.projectChoice(d);
      if (choice === "refused") reason = "connecteur de projet refusé";
      else if (choice === "pending") reason = "connecteur de projet non approuvé (approbation requise avant tout démarrage)";
      else if (choice === "modified") reason = "connecteur de projet modifié depuis son approbation : nouvelle approbation requise";
    }
    if (reason) excluded.push({ name: d.name, scope: d.scope, reason });
    else connectors.push(d);
  }
  connectors.sort((a, b) => (a.name < b.name ? -1 : 1));
  return { connectors, excluded, warnings };
}

/** `${VAR}` and `${VAR:-default}` (SPEC-MCP-001 § 5.3 step 4, EF-02); the names of undefined variables without a default (FA-02). */
export function expand(text: string, vars: Readonly<Record<string, string | undefined>>, missing: Set<string>): string {
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback: string | undefined) => {
    const v = vars[name];
    if (fallback !== undefined) return v !== undefined && v !== "" ? v : fallback;
    if (v !== undefined) return v;
    missing.add(name);
    return "";
  });
}
