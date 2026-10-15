// Implements: SPEC-MCP-019 (standalone add/list/show/remove/validate/reset-choices, policy and scopes, CA-01 to CA-03).
// Supports: SPEC-MOD-012 (no model/session), gap E-155.
import { lstatSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, applyEdits, modify, type ParseError } from "jsonc-parser";
import type { AdminDependencies } from "../admin/subcommands";
import type { ParsedSubcommand } from "../cli/families";
import { loadConfiguration } from "../config/load";
import { readUserState, updateUserState } from "../config/trust";
import { writeAtomic } from "../tools/text-file";
import { tryFileLock } from "../platform/file-lock";
import { configuredNetwork, configuredNetworkSettings } from "../config/network";
import { connectNetworkWebSocket } from "../platform/socket-network";
import { detectPosixShell, detectPowerShell } from "../tools/shell-runtime";
import { activeInstalled } from "../extensions/active";
import { loadExtensions } from "../extensions/load";
import { resolveConnectors, expand, type ConnectorDeclaration, type ConnectorSource } from "./declarations";
import { connectorSources, projectChoice, projectStateKey, type ProjectState } from "./session";
import { ConnectorManager } from "./manager";
import { ConnectorOAuth } from "./oauth";
import { nativeCredentialVault } from "../platform/credential-vault";
import { maskSecrets } from "../shared/secrets";
import { registryReport, searchConnectorRegistry } from "./registry";

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function document(text: string): Record<string, unknown> {
  const errors: ParseError[] = [], value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length || !object(value) || value.servers !== undefined && !object(value.servers)) throw new Error("Déclaration structurée invalide."); return value;
}
function contents(file: string): string {
  try { const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1 || stat.size > 1048576) throw new Error("Fichier de connecteurs non ordinaire, lié ou trop volumineux."); return readFileSync(file, "utf8"); }
  catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "{}\n"; throw cause; }
}
async function changeFile(file: string, name: string, value: unknown, force: boolean, deps: AdminDependencies): Promise<void> {
  mkdirSync(dirname(file), { recursive: true }); let release: (() => void) | undefined; const until = Date.now() + 30000;
  while (!(release = tryFileLock(file + ".lock"))) { deps.signal?.throwIfAborted(); if (Date.now() > until) throw new Error("Configuration verrouillée."); await new Promise(r => setTimeout(r, 25)); }
  try { deps.assertPolicy?.(); const text = contents(file), previous = document(text); if (value !== undefined && object(previous.servers) && previous.servers[name] !== undefined && !force) throw new Error("Nom déjà présent dans cette portée ; utilisez --force.");
    const next = applyEdits(text, modify(text, ["servers", name], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } })); writeAtomic(file, Buffer.from(next), deps.system.platform, true);
  } finally { release(); }
}
function safeDeclaration(d: ConnectorDeclaration): Record<string, unknown> {
  const url = d.url ? (() => { try { const u = new URL(d.url); for (const name of u.searchParams.keys()) u.searchParams.set(name, "[masqué]"); return u.href; } catch { return "[masqué]"; } })() : undefined;
  return { name: d.name, scope: d.scope, source: d.source, transport: d.transport, command: d.command ? maskSecrets(d.command) : undefined, args: d.args.map(() => "[masqué]"), url, headers: Object.fromEntries(Object.keys(d.headers).map(k => [k, "[masqué]"])), env: Object.fromEntries(Object.keys(d.env).map(k => [k, "[masqué]"])), headersCommand: d.headersCommand ? "[masqué]" : undefined, oauth: d.oauth ? { clientId: d.oauth.clientId, clientSecret: d.oauth.clientSecret ? "[masqué]" : undefined, callbackPort: d.oauth.callbackPort, scopes: d.oauth.scopes } : undefined };
}
export async function runConnectorAdmin(deps: AdminDependencies, parsed: ParsedSubcommand, write: (value: unknown, text: () => string) => void, out: (text: string) => void, err: (text: string) => void): Promise<number> {
  try {
    deps.assertPolicy?.(); const configuration = loadConfiguration({ ...deps }), { locations, settings } = configuration;
    if (parsed.operation === "search") {
      if (parsed.args.length !== 1) { err("Usage : connector search <terme> [--json]."); return 2; }
      const rows = await searchConnectorRegistry(deps.identity.has("SERVICE_MCP_REGISTRY") ? deps.identity.get("SERVICE_MCP_REGISTRY") : undefined, parsed.args[0]!, configuredNetwork(deps.env), deps.signal ?? new AbortController().signal);
      write(rows, () => registryReport(rows)); return 0;
    }
    const key = projectStateKey(locations.projectRoot, deps.system.platform), state = readUserState(locations.userStateFile), projectState = state.projects?.[key] as ProjectState | undefined;
    const sources = connectorSources({ configDir: locations.configDir, managedDir: locations.managedDir, projectRoot: locations.projectRoot, projectDirName: deps.identity.get("PROJECT_DIR"), projectTrusted: configuration.trust.trusted, projectState, cliValues: [], cwd: deps.cwd });
    const installed = await activeInstalled({ settings, configDir: locations.configDir, product: { name: deps.identity.get("PRODUCT"), version: deps.identity.version, cli: deps.identity.get("PRODUCT_CLI") }, runner: { env: deps.env.childEnvironment(), timeoutMs: 30000 }, cwd: deps.cwd, userSettingsFile: locations.userSettingsFile, platform: deps.system.platform, installMissing: false });
    sources.push(...loadExtensions(installed.active, { options: settings.get("extensions.options"), dataDir: name => join(locations.configDir, "extension-data", name) }).connectorSources);
    const policy = { connectorsOnly: false, allowList: settings.get<unknown[] | undefined>("mcp.allowList"), denyList: settings.get<unknown[]>("mcp.denyList"), managedServersOnly: settings.get<boolean>("mcp.managedServersOnly"), projectChoice: projectChoice({ projectState, enableAll: settings.get("mcp.enableProjectServers"), enabled: settings.get("mcp.enabledProjectServers"), disabled: settings.get("mcp.disabledProjectServers") }) };
    const effective = resolveConnectors(sources.filter(s => !settings.get<boolean>("extensions.managedOnly") || s.scope === "managed" || s.scope === "extension"), policy);
    for (const warning of effective.warnings) err(warning);
    const name = parsed.args[0], scope = parsed.options.get("scope") ?? "local", valueOption = parsed.options.get("declaration");
    if (!["user", "project", "local"].includes(String(scope))) { err("Portée invalide : user, project ou local."); return 2; }
    const files: Record<string, string> = { user: join(locations.configDir, "connectors.json"), project: join(locations.projectRoot, deps.identity.get("PROJECT_DIR"), "connectors.json") };
    const mutate = async (target: string, value: unknown, force: boolean) => {
      if (target !== "local") return changeFile(files[target]!, name!, value, force, deps);
      await updateUserState(locations.userStateFile, current => { const entry = current.projects?.[key] as ProjectState | undefined, connectors = entry?.connectors ?? {}, servers = object(connectors.servers) ? { ...connectors.servers } : {};
        if (value !== undefined && servers[name!] !== undefined && !force) throw new Error("Nom déjà présent dans cette portée ; utilisez --force."); if (value === undefined) delete servers[name!]; else servers[name!] = value;
        return { ...current, projects: { ...current.projects, [key]: { ...entry, connectors: { ...connectors, servers } } } };
      }, deps.system.platform, err);
    };
    if (parsed.operation === "reset-choices") {
      if (parsed.args.length) return 2;
      await updateUserState(locations.userStateFile, current => { const entry = current.projects?.[key] as ProjectState | undefined; const { connectorChoices: _choices, ...keep } = entry ?? {}; return { ...current, projects: { ...current.projects, [key]: keep } }; }, deps.system.platform, err); out("Choix des connecteurs du projet réinitialisés."); return 0;
    }
    if (parsed.operation === "list") { if (parsed.args.length) return 2; const rows = effective.connectors.map(d => ({ name: d.name, scope: d.scope, source: d.source, state: projectState?.disabledConnectors?.includes(d.name) && !d.required ? "disabled" : "pending", transport: d.transport })); write({ version: 1, connectors: rows, excluded: effective.excluded }, () => rows.length ? rows.map(d => `${d.name} (${d.scope}) : ${d.state} — ${d.source}`).join("\n") : "Aucun connecteur."); return 0; }
    if (!name || !/^[a-z0-9][a-z0-9-]{1,47}$/.test(name)) { err("Nom de connecteur invalide."); return 2; }
    if (parsed.operation === "add") {
      let declaration: unknown;
      if (typeof valueOption === "string") { if (parsed.args.length !== 1) throw new Error("--declaration ne se combine pas avec une commande ou une URL."); const source = valueOption.trim().startsWith("{") ? valueOption : contents(resolve(deps.cwd, valueOption)); declaration = document(source); }
      else { const command = parsed.args[1]; if (!command) throw new Error("Commande ou URL manquante."); const transport = parsed.options.get("transport") ?? (/^https?:\/\//.test(command) ? "http" : /^wss?:\/\//.test(command) ? "ws" : "stdio");
        const env: Record<string, string> = {}, headers: Record<string, string> = {};
        for (const raw of parsed.repeatedOptions?.get("env") ?? []) { const index = raw.indexOf("="); if (index < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw.slice(0, index))) throw new Error("Option --env : NOM=valeur attendu."); env[raw.slice(0, index)] = raw.slice(index + 1); }
        for (const raw of parsed.repeatedOptions?.get("header") ?? []) { const index = raw.indexOf(":"); if (index < 1) throw new Error("Option --header : Nom: valeur attendu."); headers[raw.slice(0, index).trim()] = raw.slice(index + 1).trim(); } new Headers(headers);
        declaration = transport === "stdio" ? { transport, command, args: parsed.args.slice(2), env } : { transport, url: command, headers, env };
      }
      const proposal: ConnectorSource = { scope: scope as "user" | "project" | "local", source: "nouvelle déclaration", content: { servers: { [name]: declaration } } };
      const checked = resolveConnectors([...sources.filter(s => s.scope === "managed"), proposal], { ...policy, projectChoice: () => "approved" });
      if (checked.warnings.length) { err(checked.warnings.join("\n")); return 2; } if (!checked.connectors.some(d => d.name === name && d.scope === scope)) { err("Connecteur interdit ou masqué par votre organisation."); return 3; }
      await mutate(String(scope), declaration, parsed.options.has("force")); out(`Connecteur ${name} ajouté (${scope}). Test : ${deps.identity.get("PRODUCT_CLI")} connector validate ${name}`); return 0;
    }
    if (parsed.args.length !== 1) return 2;
    if (parsed.operation === "remove") {
      const found: string[] = [];
      for (const target of ["user", "project", "local"]) { const source = target === "local" ? projectState?.connectors : document(contents(files[target]!)); if (source && object(source.servers) && Object.hasOwn(source.servers, name)) found.push(target); }
      const target = parsed.options.has("scope") ? String(scope) : found.length === 1 ? found[0] : undefined;
      if (!target || !found.includes(target)) { err(found.length > 1 ? `Plusieurs portées : ${found.join(", ")}. Précisez --scope.` : "Connecteur introuvable dans cette portée."); return found.length > 1 ? 2 : 4; }
      await mutate(target, undefined, true); out(`Connecteur ${name} retiré (${target}).`); return 0;
    }
    const selected = effective.connectors.find(d => d.name === name); if (!selected) { const blocked = effective.excluded.find(d => d.name === name); err(blocked?.reason ?? "Connecteur introuvable."); return blocked ? 3 : 4; }
    if (parsed.operation === "show") { const safe = safeDeclaration(selected); write(safe, () => JSON.stringify(safe, null, 2)); return 0; }
    const network = configuredNetwork(deps.env), environment = deps.env.childEnvironment(settings.get("environment.variables"));
    const posix = detectPosixShell(settings.get("tools.shell.default"), environment, deps.system.platform), ps = detectPowerShell(settings.get("tools.powershell.path"), deps.system.platform);
    const variables: Record<string, string | undefined> = { ...environment, PROJECT_ROOT: locations.projectRoot };
    for (const match of JSON.stringify(selected).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) variables[match[1]!] ??= deps.env.public(match[1]!);
    const manager = new ConnectorManager({ connectors: [selected], projectRoot: locations.projectRoot, platform: deps.system.platform, environment: declared => ({ ...environment, ...declared }), variables, connectTimeoutMs: settings.get("mcp.connectTimeout"), toolTimeoutMs: settings.get("mcp.toolTimeout"), maxParallel: 1, maxReconnects: 0, descriptionMax: settings.get("mcp.toolDescriptionMax"), outputInlineLimit: settings.get("mcp.outputInlineLimit"), clientInfo: { name: deps.identity.get("PRODUCT_SLUG"), version: deps.identity.version }, estimateTokens: text => Math.ceil(text.length / 4), store: () => { throw new Error("Résultats non disponibles pendant la validation."); }, report: err, changed: () => {}, fetch: network,
      wsConnect:(url,headers,handlers)=>connectNetworkWebSocket(url,headers,handlers,configuredNetworkSettings(deps.env)),wsPingIntervalMs:settings.get("mcp.wsPingInterval"),headerShell: deps.system.platform === "windows" && ps ? { path: ps.path, kind: "powershell" } : posix ? { path: posix.path, kind: "posix" } : undefined, headersTtlMs: settings.get("mcp.headersCommandTtl"), headersTimeoutMs: settings.get("mcp.headersCommandTimeout"), disabledConnectors: projectState?.disabledConnectors,
      oauth: (d, url) => { const missing = new Set<string>(), secret = d.oauth?.clientSecret ? expand(d.oauth.clientSecret, variables, missing) : undefined; if (missing.size) throw new Error("Variable OAuth non définie."); return new ConnectorOAuth({ name: d.name, url, configuration: { ...d.oauth, ...(secret ? { clientSecret: secret } : {}) }, configDir: locations.configDir, service: deps.identity.get("KEYCHAIN_SERVICE"), vault: deps.credentialVault ?? nativeCredentialVault({ environment }), fetch: network, timeoutMs: settings.get("mcp.authTimeout") }); },
    });
    try { manager.start(); await manager.waitAll(Math.min(selected.timeoutMs ?? settings.get<number>("mcp.connectTimeout"), 60000) + 500, deps.signal); const status = manager.status()[0]!;
      const result = { name, state: status.state, source: status.source, tools: manager.tools().map(t => t.name), resources: status.state === "connected" ? await manager.resources(name, deps.signal ?? new AbortController().signal) : [], prompts: manager.prompts().map(p => p.command), error: status.error };
      write(result, () => `${name} : ${status.state}\nOutils : ${result.tools.join(", ") || "aucun"}\nRessources : ${result.resources.length}\nPrompts : ${result.prompts.join(", ") || "aucun"}`); return status.state === "connected" ? 0 : 1;
    } finally { await manager.close(); }
  } catch (cause) { err(maskSecrets((cause as Error).message)); return 2; }
}
