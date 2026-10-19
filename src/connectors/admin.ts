// Implements: SPEC-MCP-019 (standalone add/list/show/remove/validate/reset-choices, policy and scopes, CA-01 to CA-03).
// Supports: SPEC-MCP-007 (delegated credentials and organization access in standalone validation).
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
import { ManagedIdentityProvider, identityProviderSecretVariables, type IdentityProviderConfiguration } from "../auth/identity-provider";
import { nativeCredentialVault } from "../platform/credential-vault";
import { maskSecrets } from "../shared/secrets";
import { registryReport, searchConnectorRegistry } from "./registry";
import { parseConnectorBundle, installConnectorBundle } from "./bundle";
import { authDialog } from "../interactive/auth-dialog";

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
  return changeFiles(file, [[name, value]], force, deps);
}
async function changeFiles(file: string, entries: ReadonlyArray<readonly [string, unknown]>, force: boolean, deps: AdminDependencies): Promise<void> {
  mkdirSync(dirname(file), { recursive: true }); let release: (() => void) | undefined; const until = Date.now() + 30000;
  while (!(release = tryFileLock(file + ".lock"))) { deps.signal?.throwIfAborted(); if (Date.now() > until) throw new Error("Configuration verrouillée."); await new Promise(r => setTimeout(r, 25)); }
  try { deps.assertPolicy?.(); const text = contents(file), previous = document(text); let next = text;
    for (const [name, value] of entries) { if (value !== undefined && object(previous.servers) && previous.servers[name] !== undefined && !force) throw new Error("Nom déjà présent dans cette portée ; utilisez --force."); next = applyEdits(next, modify(next, ["servers", name], value, { formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" } })); }
    writeAtomic(file, Buffer.from(next), deps.system.platform, true);
  } finally { release(); }
}
function safeDeclaration(d: ConnectorDeclaration): Record<string, unknown> {
  const url = d.url ? (() => { try { const u = new URL(d.url); for (const name of u.searchParams.keys()) u.searchParams.set(name, "[masqué]"); return u.href; } catch { return "[masqué]"; } })() : undefined;
  return { name: d.name, scope: d.scope, source: d.source, transport: d.transport, command: d.command ? maskSecrets(d.command) : undefined, args: d.args.map(() => "[masqué]"), url, headers: Object.fromEntries(Object.keys(d.headers).map(k => [k, "[masqué]"])), env: Object.fromEntries(Object.keys(d.env).map(k => [k, "[masqué]"])), headersCommand: d.headersCommand ? "[masqué]" : undefined, oauth: d.oauth ? { clientId: d.oauth.clientId, clientSecret: d.oauth.clientSecret ? "[masqué]" : undefined, callbackPort: d.oauth.callbackPort, scopes: d.oauth.scopes } : undefined };
}
export async function runConnectorAdmin(deps: AdminDependencies, parsed: ParsedSubcommand, write: (value: unknown, text: () => string) => void, out: (text: string) => void, err: (text: string) => void): Promise<number> {
  try {
    deps.assertPolicy?.(); const configuration = loadConfiguration({ ...deps }), { locations, settings } = configuration;
    const identityConfiguration = settings.isManaged("mcp.identityProvider") ? settings.get<IdentityProviderConfiguration | undefined>("mcp.identityProvider") : undefined;
    const secretNames = identityProviderSecretVariables(identityConfiguration); deps.env.protectVariables(secretNames);
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
    const confirm = async (summary: string) => { if (!deps.streams.stdinIsTTY || !deps.streams.stdoutIsTTY || !deps.streams.terminal) throw new Error("Cette opération exige une confirmation dans un terminal interactif."); return await authDialog(deps.streams.terminal, summary, false, deps.signal) === true; };
    const checkProposal = (entryName: string, declaration: unknown, target: "user" | "project" | "local") => {
      if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(entryName)) throw new Error("Nom de connecteur invalide.");
      const result = resolveConnectors([...sources.filter(source => source.scope === "managed"), { scope: target, source: "import confirmé", content: { servers: { [entryName]: declaration } } }], { ...policy, projectChoice: () => "approved" });
      if (result.warnings.length || !result.connectors.some(entry => entry.name === entryName && entry.scope === target)) throw new Error("Déclaration invalide ou interdite par votre organisation.");
    };
    if (parsed.operation === "install-archive") {
      if (parsed.args.length !== 1) throw new Error("Usage : connector install-archive <fichier.mcpb> [--scope user|project|local].");
      const path = resolve(deps.cwd, parsed.args[0]!), stat = lstatSync(path), maximum = settings.get<number>("extensions.archiveMaxSize");
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maximum) throw new Error("Archive non ordinaire ou trop volumineuse.");
      const bundle = parseConnectorBundle(readFileSync(path), maximum, deps.system.platform);
      checkProposal(bundle.name, bundle.server, scope as "user" | "project" | "local");
      const installed = await installConnectorBundle(bundle, { configDir: locations.configDir, confirm }); if (!installed) return 2;
      deps.assertPolicy?.(); checkProposal(installed.name, installed.declaration, scope as "user" | "project" | "local");
      if (scope === "local") await updateUserState(locations.userStateFile, current => { const entry = current.projects?.[key] as ProjectState | undefined, servers = object(entry?.connectors?.servers) ? { ...entry.connectors.servers } : {};
        if (servers[installed.name] !== undefined && !parsed.options.has("force")) throw new Error("Nom déjà présent ; utilisez --force."); servers[installed.name] = installed.declaration;
        return { ...current, projects: { ...current.projects, [key]: { ...entry, connectors: { ...entry?.connectors, servers } } } };
      }, deps.system.platform, err);
      else await changeFile(files[String(scope)]!, installed.name, installed.declaration, parsed.options.has("force"), deps);
      out(`Connecteur ${installed.name} installé et déclaré (${scope}).`); return 0;
    }
    if (parsed.operation === "import") {
      if (parsed.args[0] !== "desktop" || parsed.args.length !== 3) throw new Error("Usage : connector import desktop <fichier> <nom1,nom2>. Les autres connecteurs restent ignorés.");
      const source = document(contents(resolve(deps.cwd, parsed.args[1]!))), selected = parsed.args[2]!.split(","), entries: Array<readonly [string, unknown]> = [];
      if (!object(source.servers) || selected.length > 100 || new Set(selected).size !== selected.length) throw new Error("Configuration de bureau ou sélection invalide.");
      for (const entryName of selected) { const declaration = source.servers[entryName]; checkProposal(entryName, declaration, "user");
        if (object(declaration) && object(declaration.env) && Object.values(declaration.env).some(value => typeof value !== "string" || !/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))) throw new Error("Secret ou valeur d’environnement en clair : convertissez-la en référence ${VARIABLE} dans la configuration source avant l’import.");
        entries.push([entryName, declaration]); }
      if (!await confirm(`Importer en portée utilisateur : ${selected.join(", ")} ? Les noms déjà présents exigent --force.`)) return 2;
      await changeFiles(files.user!, entries, parsed.options.has("force"), deps); out(`${entries.length} connecteurs importés en portée utilisateur.`); return 0;
    }
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
    for (const name of secretNames) variables[name] = deps.env.public(name);
    for (const match of JSON.stringify(selected).matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g)) variables[match[1]!] ??= deps.env.public(match[1]!);
    const vault = deps.credentialVault ?? nativeCredentialVault({ environment }), secrets = new Set<string>(secretNames.map(name => variables[name]).filter((value): value is string => !!value));
    const remember = (value: string) => { secrets.add(value); secrets.add(encodeURIComponent(value)); secrets.add(JSON.stringify(value).slice(1, -1)); };
    const redact = (value: string) => [...secrets].sort((a, b) => b.length - a.length).reduce((safe, secret) => safe.split(secret).join("[masqué]"), value);
    const binding = JSON.stringify(identityConfiguration);
    const provider = identityConfiguration?.connectors.some(c => c.name === selected.name) ? new ManagedIdentityProvider({ configuration: identityConfiguration, configDir: locations.configDir, service: deps.identity.get("KEYCHAIN_SERVICE"), vault, fetch: network, variables, remember, timeoutMs: settings.get("mcp.authTimeout"), permitted: () => { deps.assertPolicy?.(); const current = loadConfiguration({ ...deps }).settings; return current.isManaged("mcp.identityProvider") && JSON.stringify(current.get("mcp.identityProvider")) === binding; } }) : undefined;
    const manager = new ConnectorManager({ connectors: [selected], projectRoot: locations.projectRoot, platform: deps.system.platform, environment: declared => deps.env.childEnvironment({ ...settings.get<Record<string, string>>("environment.variables"), ...declared }), variables, connectTimeoutMs: settings.get("mcp.connectTimeout"), toolTimeoutMs: settings.get("mcp.toolTimeout"), maxParallel: 1, maxReconnects: 0, descriptionMax: settings.get("mcp.toolDescriptionMax"), outputInlineLimit: settings.get("mcp.outputInlineLimit"), clientInfo: { name: deps.identity.get("PRODUCT_SLUG"), version: deps.identity.version }, estimateTokens: text => Math.ceil(text.length / 4), store: () => { throw new Error("Résultats non disponibles pendant la validation."); }, report: value => err(redact(value)), redact, changed: () => {}, fetch: network,
      wsConnect:(url,headers,handlers)=>connectNetworkWebSocket(url,headers,handlers,configuredNetworkSettings(deps.env)),wsPingIntervalMs:settings.get("mcp.wsPingInterval"),headerShell: deps.system.platform === "windows" && ps ? { path: ps.path, kind: "powershell" } : posix ? { path: posix.path, kind: "posix" } : undefined, headersTtlMs: settings.get("mcp.headersCommandTtl"), headersTimeoutMs: settings.get("mcp.headersCommandTimeout"), disabledConnectors: projectState?.disabledConnectors,
      oauth: (d, url) => { const missing = new Set<string>(), secret = d.oauth?.clientSecret ? expand(d.oauth.clientSecret, variables, missing) : undefined; if (missing.size) throw new Error("Variable OAuth non définie."); return new ConnectorOAuth({ name: d.name, url, configuration: { ...d.oauth, ...(secret ? { clientSecret: secret } : {}) }, configDir: locations.configDir, service: deps.identity.get("KEYCHAIN_SERVICE"), vault, fetch: network, remember, timeoutMs: settings.get("mcp.authTimeout"), ...provider?.connector(d.name, url) }); },
    });
    try { manager.start(); await manager.waitAll(Math.min(selected.timeoutMs ?? settings.get<number>("mcp.connectTimeout"), 60000) + 500, deps.signal); const status = manager.status()[0]!;
      const result = { name, state: status.state, source: status.source, tools: manager.tools().map(t => t.name), resources: status.state === "connected" ? await manager.resources(name, deps.signal ?? new AbortController().signal) : [], prompts: manager.prompts().map(p => p.command), error: status.error, ...(status.organizationAccess ? { organizationAccess: true } : {}) };
      write(result, () => `${name} : ${status.state}${status.organizationAccess ? " — accès via votre organisation" : ""}\nOutils : ${result.tools.join(", ") || "aucun"}\nRessources : ${result.resources.length}\nPrompts : ${result.prompts.join(", ") || "aucun"}`); return status.state === "connected" ? 0 : 1;
    } finally { await manager.close(); }
  } catch (cause) { err(maskSecrets((cause as Error).message)); return 2; }
}
