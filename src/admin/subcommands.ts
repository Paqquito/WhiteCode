// Implements: SPEC-MOD-012 (§ 5.5, § 5.6 FA-04, EF-01, EF-02, EF-04 to EF-07, ERR-01, ERR-02, ERR-04, RG-03, CA-01, CA-02, CA-05, CA-07, CA-08, CA-12),
//             SPEC-API-006 (EF-03, EF-04, CA-03, CA-05), SPEC-CFG-002 (§ 5.2 `config validate`, CA-03)
// Supports: SPEC-CFG-003 (FA-02, CA-06, CA-08, independent enrolment, cache and authorised recovery), gaps E-066, E-120 to E-127. Administration operations never start a session nor contact the model service (EF-04).
// Supports: SPEC-CAD-002 (CA-12, CA-14: source and override warnings in standalone diagnostics), gap E-133.

import { lstatSync, readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { ExitCode } from "../cli/exit-codes";
import { familyHelp, FAMILY_BY_NAME, FAMILY_CATALOG, parseSubcommand, SubcommandUsageError } from "../cli/families";
import type { EnvironmentView } from "../config/environment";
import { loadConfiguration } from "../config/load";
import { readManagedPolicy, validateManagedPolicy } from "../config/managed-policy";
import { readPolicyEnrollment } from "../config/policy-enrollment";
import { readPolicySource } from "../config/protected-policy-source";
import { computeLocations } from "../config/locations";
import type { PolicyCacheSource } from "../config/policy-cache";
import type { RegistryPolicyReader } from "../platform/registry";
import type { ProfilePolicyReader } from "../platform/managed-profile";
import type { PolicyFileProtectionReader } from "../platform/policy-file";
import { Settings, type ConfigIssue } from "../config/settings";
import type { Scope } from "../config/settings-schema";
import type { Identity } from "../identity/identity";
import { identityFindings } from "../identity/diagnostic";
import { MODEL_TIERS } from "../identity/runtime-catalog";
import type { StandardStreams } from "../platform/io";
import { comparablePath, findExecutable, type SystemInfo } from "../platform/system";
import { renderDiagnostics, runDiagnostics, type DiagnosticInputs } from "./diagnostic";
import { effectiveCapabilities, isDeliveredProvider } from "../providers/adapters";
import { capabilitiesOf, isResolveFailure, type ModelCatalog, type ModelEntry } from "../providers/catalog";
import { suggest } from "../shared/suggest";
import { renderValidation, validateExtension } from "../extensions/validate";
import { catalogAdd, catalogList, catalogRemove, catalogUpdate, extensionAdd, extensionEnable, extensionList, extensionRemove, extensionUpdate, scopeOf, type ExtensionAdminContext } from "../extensions/admin";

export interface AdminDependencies {
  readonly streams: StandardStreams;
  readonly identity: Identity;
  readonly catalog: ModelCatalog;
  readonly env: EnvironmentView;
  readonly cwd: string;
  readonly system: SystemInfo;
  readonly managedDir?: string;
  readonly registryPolicyReader?: RegistryPolicyReader;
  readonly profilePolicyReader?: ProfilePolicyReader;
  readonly policyFileProtection?: PolicyFileProtectionReader;
  readonly cachePolicy?: PolicyCacheSource;
}

const TIER_ALIASES = ["large", "medium", "small"] as const;

/** First token is a family, or two leading words that can only be a sub-command (gap E-031). */
export function looksLikeSubcommand(argv: readonly string[]): boolean {
  const [first, second] = argv;
  if (first === undefined || first.startsWith("-")) return false;
  if (FAMILY_BY_NAME.has(first)) return true;
  return second !== undefined && !second.startsWith("-") && /^[a-z][a-z-]*$/.test(first) && suggest(first, [...FAMILY_BY_NAME.keys()]).length > 0;
}

export async function runSubcommand(argv: readonly string[], deps: AdminDependencies): Promise<number> {
  const out = (text: string) => deps.streams.writeOut(text.endsWith("\n") ? text : `${text}\n`);
  const err = (text: string) => deps.streams.writeErr(text.endsWith("\n") ? text : `${text}\n`);
  let parsed;
  try {
    parsed = parseSubcommand(argv);
  } catch (e) {
    if (e instanceof SubcommandUsageError) {
      err(e.message);
      return ExitCode.UsageOrConfiguration;
    }
    throw e;
  }
  const cli = deps.identity.get("PRODUCT_CLI");
  const family = FAMILY_BY_NAME.get(parsed.family);
  if (!family) {
    // ERR-01, EF-06, CA-05: unknown family, suggestion by closeness.
    const near = suggest(parsed.family, FAMILY_CATALOG.map((f) => f.name));
    err(`Commande inconnue : ${parsed.family}.${near[0] ? ` Vouliez-vous dire ${near[0]} ?` : ""}`);
    return ExitCode.UsageOrConfiguration;
  }
  // RN-G, CA-01, CA-07, CA-12: a family alone shows its help and does nothing.
  if (parsed.operation === undefined || parsed.options.has("help")) {
    out(familyHelp(cli, family));
    return ExitCode.Success;
  }
  const operation = family.operations.find((o) => o.name === parsed.operation);
  if (!operation) {
    // CA-08: not executed; close names of the catalogue are suggested.
    const all = FAMILY_CATALOG.flatMap((f) => f.operations.map((o) => `${f.name} ${o.name}`));
    const near = suggest(`${family.name} ${parsed.operation}`, all).slice(0, 3);
    err(`Commande inconnue : ${family.name} ${parsed.operation}.${near.length > 0 ? ` Vouliez-vous dire ${near.join(", ")} ?` : ""}`);
    return ExitCode.UsageOrConfiguration;
  }
  if (!operation.delivered) {
    err(`Opération non disponible dans cette version : ${family.name} ${operation.name}.`);
    return ExitCode.UsageOrConfiguration;
  }
  for (const name of parsed.options.keys()) {
    if (name === "verbose" || name === "help") continue;
    if (!(operation.options ?? []).includes(name)) {
      err(`Option non prise en charge par ${family.name} ${operation.name} : --${name}.`);
      return ExitCode.UsageOrConfiguration;
    }
  }
  const json = parsed.options.has("json");
  const write = (document: unknown, text: () => string) => out(json ? JSON.stringify(document) : text()); // FA-04, CA-02: only the document

  switch (`${family.name} ${operation.name}`) {
    case "model list":
      return modelList(deps, write);
    case "model show": {
      const name = parsed.args[0];
      if (!name) {
        err("Argument manquant : <nom>."); // ERR-02
        return ExitCode.UsageOrConfiguration;
      }
      return modelShow(deps, name, write, err);
    }
    case "config validate":
      return configValidate(deps, parsed.args[0], parsed.options.get("scope"), write, err);
    case "config recover-policy":
      if (parsed.args.length !== 1) { err("Usage : config recover-policy <fichier> [--json]."); return ExitCode.UsageOrConfiguration; }
      return policyRecovery(deps, parsed.args[0]!, write, err);
    case "diagnostic validate":
    case "diagnostic repair":
      return diagnostic(deps, operation.name === "repair", write, out);
    case "catalog add":
    case "catalog list":
    case "catalog update":
    case "catalog remove":
    case "extension add":
    case "extension list":
    case "extension enable":
    case "extension disable":
    case "extension remove":
    case "extension update": {
      const scopeOption = parsed.options.get("scope");
      const scope = scopeOf(scopeOption);
      if (!scope) {
        err(`Portée invalide : ${String(scopeOption)} (user, project ou local).`);
        return ExitCode.UsageOrConfiguration;
      }
      const needsArg = !["catalog list", "catalog update", "extension list", "extension update"].includes(`${family.name} ${operation.name}`);
      const arg = parsed.args[0];
      if (needsArg && !arg) {
        err(`Argument manquant : ${operation.args ?? "<nom>"}.`);
        return ExitCode.UsageOrConfiguration;
      }
      const ctx = extensionContext(deps, write, out, err);
      const lean = parsed.options.get("lean-context");
      const name = parsed.options.get("name");
      switch (`${family.name} ${operation.name}`) {
        case "catalog add":
          return catalogAdd(ctx, arg!, scope, typeof lean === "string" ? lean.split(",").map((p) => p.trim()).filter((p) => p !== "") : undefined, typeof name === "string" ? name : undefined);
        case "catalog list":
          return catalogList(ctx);
        case "catalog update":
          return catalogUpdate(ctx, arg);
        case "catalog remove":
          return catalogRemove(ctx, arg!, scopeOption === undefined ? undefined : scope, parsed.options.has("force"));
        case "extension add":
          return extensionAdd(ctx, arg!, scope, parsed.options.has("force"));
        case "extension list":
          return extensionList(ctx, parsed.options.has("installable"));
        case "extension update":
          return extensionUpdate(ctx, arg, parsed.options.has("force"));
        case "extension enable":
        case "extension disable":
          return extensionEnable(ctx, arg!, scope, operation.name === "enable");
        default:
          return extensionRemove(ctx, arg!, scopeOption === undefined ? undefined : scope, parsed.options.has("preserve-data"), parsed.options.has("force"));
      }
    }
    case "extension validate": {
      // SPEC-EXT-012: 0 without error, 1 with errors, 2 when the path does not exist (ERR-01).
      const path = parsed.args[0];
      if (!path) {
        err("Argument manquant : <chemin>.");
        return ExitCode.UsageOrConfiguration;
      }
      const report = validateExtension(resolvePath(deps.cwd, path));
      if (!report) {
        err("Chemin introuvable.");
        return ExitCode.UsageOrConfiguration;
      }
      write(report, () => renderValidation(report));
      return report.valid ? ExitCode.Success : ExitCode.ExecutionError;
    }
    default:
      err(`Opération non disponible dans cette version : ${family.name} ${operation.name}.`);
      return ExitCode.UsageOrConfiguration;
  }
}

type Writer = (document: unknown, text: () => string) => void;

/** What the `catalog` and `extension` operations need: settings, the files of the writable scopes, Git, a confirmation. */
function extensionContext(deps: AdminDependencies, write: Writer, out: (t: string) => void, err: (t: string) => void): ExtensionAdminContext {
  const { settings, locations } = loadConfiguration({ identity: deps.identity, env: deps.env, cwd: deps.cwd, system: deps.system, managedDir: deps.managedDir, registryPolicyReader: deps.registryPolicyReader, profilePolicyReader: deps.profilePolicyReader, policyFileProtection: deps.policyFileProtection, cachePolicy: deps.cachePolicy });
  return {
    configDir: locations.configDir,
    cwd: deps.cwd,
    platform: deps.system.platform,
    product: { name: deps.identity.get("PRODUCT"), version: deps.identity.version, cli: deps.identity.get("PRODUCT_CLI") },
    settings,
    files: { user: locations.userSettingsFile, project: locations.projectSettingsFile, local: locations.localSettingsFile },
    runner: { env: deps.env.childEnvironment(), timeoutMs: 300_000 },
    out,
    err,
    write,
    // SPEC-EXT-002 EF-01: asked on a terminal only; elsewhere `--force` stands for the confirmation.
    confirm: async (question) => {
      if (!deps.streams.stdinIsTTY) return false;
      deps.streams.writeErr(`${question} [o/N] `);
      for await (const line of deps.streams.stdinLines()) return /^(o|oui|y|yes)$/i.test(line.trim());
      return false;
    },
  };
}

/** The inputs of the checks, outside a session (SPEC-CMD-020 § 5.1). */
export function diagnosticInputs(o: {
  readonly sources: DiagnosticInputs["sources"];
  readonly settings: Settings;
  readonly configDir: string;
  readonly sessionsDir: string;
  readonly platform: SystemInfo["platform"];
}): DiagnosticInputs {
  return {
    sources: o.sources.filter((s) => s.scope !== "cli"),
    keybindings: o.settings.get<Record<string, unknown>>("ui.keybindings.bindings"),
    executables: [
      { name: "git", path: findExecutable("git"), purpose: "état du dépôt et catalogues d'extensions" },
      { name: "rg", path: findExecutable("rg"), purpose: "recherche rapide dans les fichiers" },
    ],
    writable: [
      { path: o.configDir, purpose: "dossier de configuration" },
      ...(o.sessionsDir.startsWith(o.configDir) ? [] : [{ path: o.sessionsDir, purpose: "dossier des sessions" }]),
    ],
    platform: o.platform,
  };
}

/**
 * `diagnostic validate` (the report, `--json` for the support, EF-02) and `diagnostic repair` (each correction applied
 * only after the agreement of the user, on a terminal; elsewhere nothing is changed, EF-01).
 */
async function diagnostic(deps: AdminDependencies, repair: boolean, write: Writer, out: (t: string) => void): Promise<number> {
  const { locations, sources, settings, systemPolicy, cachePolicy } = loadConfiguration({ identity: deps.identity, env: deps.env, cwd: deps.cwd, system: deps.system, managedDir: deps.managedDir, registryPolicyReader: deps.registryPolicyReader, profilePolicyReader: deps.profilePolicyReader, policyFileProtection: deps.policyFileProtection, cachePolicy: deps.cachePolicy });
  const findings = await runDiagnostics(diagnosticInputs({ sources, settings, configDir: locations.configDir, sessionsDir: locations.sessionsDir, platform: deps.system.platform }),
    [...identityFindings(deps.identity), ...readManagedPolicy(locations.managedSettingsFile, deps.identity.resolved.policyAnchor, undefined, deps.policyFileProtection).issues.map((issue) => ({ status: issue.severity, area: "Fichier de politique", message: issue.message, location: locations.managedSettingsFile })),
      ...(systemPolicy?.read().issues.map((issue) => ({ status: issue.severity, area: systemPolicy.kind === "registry" ? "Politique de registre" : "Politique de profil macOS", message: issue.message, location: systemPolicy.name })) ?? []),
      ...cachePolicy.read().issues.map((issue) => ({ status: issue.severity, area: "Cache de politique", message: issue.message, location: cachePolicy.name }))]);
  const title = `Diagnostic — ${deps.identity.get("PRODUCT")} ${deps.identity.version}`;
  const errors = findings.filter((f) => f.status === "error").length;
  if (!repair) {
    write({ findings: findings.map(({ fix, ...f }) => ({ ...f, ...(fix ? { fix: fix.description } : {}) })), errors }, () => renderDiagnostics(findings, title).join("\n"));
    return errors === 0 ? ExitCode.Success : ExitCode.UsageOrConfiguration;
  }
  out(renderDiagnostics(findings, title).join("\n"));
  const fixable = findings.filter((f) => f.fix?.apply);
  if (fixable.length === 0) {
    out("Aucune correction automatique à appliquer.");
    return errors === 0 ? ExitCode.Success : ExitCode.UsageOrConfiguration;
  }
  if (!deps.streams.stdinIsTTY) {
    out("Corrections non appliquées : l'accord de l'utilisateur est demandé sur un terminal.");
    return ExitCode.ConsentRequired;
  }
  let applied = 0;
  const lines = deps.streams.stdinLines()[Symbol.asyncIterator]();
  for (const f of fixable) {
    deps.streams.writeErr(`Appliquer : ${f.fix!.description} (${f.location}) ? [o/N] `);
    const answer = await lines.next();
    if (answer.done) break;
    if (!/^(o|oui|y|yes)$/i.test(answer.value.trim())) continue;
    f.fix!.apply!();
    applied++;
  }
  out(`${applied} correction${applied > 1 ? "s" : ""} appliquée${applied > 1 ? "s" : ""}.`);
  return ExitCode.Success;
}

function settingsOf(deps: AdminDependencies): Settings {
  return loadConfiguration({ identity: deps.identity, env: deps.env, cwd: deps.cwd, system: deps.system, managedDir: deps.managedDir, registryPolicyReader: deps.registryPolicyReader, profilePolicyReader: deps.profilePolicyReader, policyFileProtection: deps.policyFileProtection, cachePolicy: deps.cachePolicy }).settings;
}

/** Stable structured form of a catalogue entry (RG-03): the model family is always present (CA-05). */
function modelDocument(entry: ModelEntry, source: "distribution" | "extra", currency: string) {
  const provider = entry.provider;
  const declared = capabilitiesOf(entry);
  const adapter = isDeliveredProvider(provider) ? effectiveCapabilities(declared, provider) : undefined;
  return {
    id: entry.id,
    provider,
    family: entry.family,
    label: entry.label,
    aliases: entry.aliases ?? [],
    contextWindow: entry.contextWindow,
    maxOutputTokens: entry.maxOutputTokens,
    capabilities: adapter?.capabilities ?? declared,
    degradations: adapter?.degradations ?? [],
    pricing: entry.pricing ? { currency, ...entry.pricing } : null,
    source,
    providerDelivered: adapter !== undefined,
  };
}

function capabilityWords(c: ReturnType<typeof modelDocument>["capabilities"]): string {
  const words: string[] = [];
  if (c.toolCalling) words.push("appels d'outils");
  if (c.thinking !== "none") words.push(`réflexion ${c.thinking === "always" ? "permanente" : "facultative"}`);
  if (c.effort.length > 0) words.push(`effort ${c.effort.join("/")}`);
  if (c.images) words.push("images");
  if (c.pdf) words.push("PDF");
  if (c.contextEditing) words.push("effacement côté service");
  if (c.appendOnlyHistory) words.push("historique en ajout seul");
  return words.length > 0 ? words.join(", ") : "texte seulement";
}

const n = (x: number) => x.toLocaleString("fr-FR").replace(/ | /g, " ");

/** `model list` (SPEC-API-006 EF-04, CA-03): tiers with their labels and models, then the catalogue with capabilities. */
function modelList(deps: AdminDependencies, write: Writer): number {
  const settings = settingsOf(deps);
  const provider = settings.get<string | undefined>("api.provider");
  const identifierMap = settings.get<Record<string, string>>("models.identifierMap");
  const local = deps.catalog.validateExtraEntries(settings.get<unknown[]>("models.extraCatalog"));
  const tiers = TIER_ALIASES.map((alias, i) => {
    const tier = MODEL_TIERS[i]!;
    const mapped = provider ? deps.catalog.resolve(alias, provider, deps.identity, { unknownContextWindow: 0, identifierMap, extraEntries: local.entries }) : undefined;
    return { alias, label: deps.identity.tierLabel(tier) ?? alias, model: mapped && !isResolveFailure(mapped) ? mapped.id : null };
  });
  const entries = [
    ...deps.catalog.entries.filter((e) => !provider || e.provider === provider).map((e) => modelDocument(e, "distribution", deps.catalog.currency)),
    ...local.entries.filter((e) => !provider || e.provider === provider).map((e) => modelDocument(e, "extra", deps.catalog.currency)),
  ];
  const document = { provider: provider ?? null, currency: deps.catalog.currency, tiers, models: entries };
  write(document, () => {
    const lines = [provider ? `Fournisseur : ${provider}` : "Aucun fournisseur configuré : tout le catalogue est listé.", "", "Gammes :"];
    for (const t of tiers) lines.push(`  ${t.alias.padEnd(7)} ${t.label.padEnd(12)} ${t.model ? `→ ${t.model}` : "(aucun modèle associé : models.identifierMap)"}`);
    lines.push("", "Modèles :");
    for (const m of entries) {
      const price = m.pricing ? `${m.pricing.inputPerMTok}/${m.pricing.outputPerMTok} ${m.pricing.currency} par million de jetons (entrée/sortie)` : "coût inconnu";
      lines.push(`  ${m.id} (${m.provider}${m.source === "extra" ? ", catalogue complémentaire" : ""}) — ${m.label}, famille ${m.family}`);
      lines.push(`      contexte ${n(m.contextWindow)}, sortie ${n(m.maxOutputTokens)} ; ${capabilityWords(m.capabilities)} ; ${price}`);
    }
    return lines.join("\n");
  });
  return ExitCode.Success;
}

/** `model show <nom>`: an alias or a full identifier (SPEC-API-006 EF-01). */
function modelShow(deps: AdminDependencies, name: string, write: Writer, err: (t: string) => void): number {
  const settings = settingsOf(deps);
  const provider = settings.get<string | undefined>("api.provider");
  const local = deps.catalog.validateExtraEntries(settings.get<unknown[]>("models.extraCatalog")).entries;
  let entry: { entry: ModelEntry; source: "distribution" | "extra" } | undefined;
  if (provider) {
    const r = deps.catalog.resolve(name, provider, deps.identity, { unknownContextWindow: 0, identifierMap: settings.get<Record<string, string>>("models.identifierMap"), extraEntries: local });
    if (!isResolveFailure(r) && r.source !== "none") {
      const found = r.source === "distribution" ? deps.catalog.find(provider, r.id) : local.find((e) => e.provider === provider && e.id === r.id);
      if (found) entry = { entry: found, source: r.source };
    }
  }
  if (!entry) {
    const any = deps.catalog.entries.find((e) => e.id === name || (e.aliases ?? []).includes(name));
    const anyLocal = local.find((e) => e.id === name);
    entry = any ? { entry: any, source: "distribution" } : anyLocal ? { entry: anyLocal, source: "extra" } : undefined;
  }
  if (!entry) {
    err(`Modèle introuvable : ${name}.`); // ERR-04
    return ExitCode.ExecutionError;
  }
  const doc = modelDocument(entry.entry, entry.source, deps.catalog.currency);
  write(doc, () =>
    [
      `${doc.id} — ${doc.label}`,
      `  fournisseur : ${doc.provider}${doc.providerDelivered ? "" : " (adaptateur non disponible dans cette version)"}`,
      `  famille : ${doc.family}`,
      `  contexte : ${n(doc.contextWindow)} jetons ; sortie : ${n(doc.maxOutputTokens)} jetons`,
      `  capacités : ${capabilityWords(doc.capabilities)}`,
      ...(doc.degradations.length > 0 ? [`  dégradations : ${doc.degradations.join(" ; ")}`] : []),
      `  tarif : ${doc.pricing ? `${doc.pricing.inputPerMTok} (entrée), ${doc.pricing.outputPerMTok} (sortie), ${doc.pricing.cacheReadPerMTok} (lecture de cache), ${doc.pricing.cacheWritePerMTok} (écriture de cache) ${doc.pricing.currency} par million de jetons, au ${doc.pricing.effectiveDate}` : "coût inconnu"}`,
      `  origine : ${doc.source === "extra" ? "catalogue complémentaire (models.extraCatalog)" : "catalogue de la distribution"}`,
    ].join("\n"),
  );
  return ExitCode.Success;
}

/** SPEC-CFG-003 CA-06: only bytes authorised independently of the candidate may enter the recovery path. */
function policyRecovery(deps: AdminDependencies, file: string, write: Writer, err: (t: string) => void): number {
  const locations = computeLocations(deps.identity, deps.env, deps.cwd, deps.system, deps.managedDir);
  const enrollment = readPolicyEnrollment(locations.managedSettingsFile, deps.identity.resolved.policyAnchor, deps.policyFileProtection);
  if (enrollment.issues.length > 0) { err(enrollment.issues.map((issue) => issue.message).join("\n")); return ExitCode.BlockedByPolicy; }
  const authority = enrollment.anchor ?? deps.identity.resolved.policyAnchor;
  if (!authority) { err("Aucune version autorisée par une inscription protégée ou la distribution : contactez votre administrateur."); return ExitCode.BlockedByPolicy; }
  const source = readPolicySource(resolvePath(deps.cwd, file), authority, () => ({ writable: false }));
  // Candidate bytes may be user-owned: their authority is the independently protected hash, never their location.
  if (source.issue) { err(source.issue.message); return ExitCode.BlockedByPolicy; }
  const validated = validateManagedPolicy(source.text);
  if (validated.issues.some((issue) => issue.severity === "error")) { err(validated.issues.map((issue) => issue.message).join("\n")); return ExitCode.BlockedByPolicy; }
  const report = { organizationId: authority.organizationId, verified: true, requiresAdministrativeInstall: true, destination: locations.managedSettingsFile, sha256: authority.policySha256 };
  write(report, () => `Version autorisée pour l'organisation ${authority.organizationId}.\nFaites remettre ce fichier en place par votre administrateur : ${locations.managedSettingsFile}\nPuis redémarrez la session. Aucun fichier système n'a été modifié.`);
  return ExitCode.Success;
}

/** `config validate [<fichier>]` (SPEC-CFG-002 CA-03): every error listed, a non-zero exit code when there is one. */
function configValidate(deps: AdminDependencies, file: string | undefined, scopeOption: string | true | undefined, write: Writer, err: (t: string) => void): number {
  const { locations, sources, systemPolicy, cachePolicy } = loadConfiguration({ identity: deps.identity, env: deps.env, cwd: deps.cwd, system: deps.system, managedDir: deps.managedDir, registryPolicyReader: deps.registryPolicyReader, profilePolicyReader: deps.profilePolicyReader, policyFileProtection: deps.policyFileProtection, cachePolicy: deps.cachePolicy });
  let targets: Array<{ scope: Scope; name: string; text: string | undefined }>;
  if (file !== undefined) {
    const path = resolvePath(deps.cwd, file);
    let text: string;
    try {
      if (scopeOption === "managed" || comparablePath(path, deps.system.platform) === comparablePath(locations.managedSettingsFile, deps.system.platform)) {
        lstatSync(path); // The managed reader below performs the bounded, protected read.
        text = "";
      } else text = readFileSync(path, "utf8");
    } catch {
      err(`Fichier introuvable : ${path}.`); // ERR-04
      return ExitCode.ExecutionError;
    }
    const known: Array<[string, Scope]> = [
      [locations.managedSettingsFile, "managed"],
      [cachePolicy.name, "managed"],
      [locations.userSettingsFile, "user"],
      [locations.projectSettingsFile, "project"],
      [locations.localSettingsFile, "local"],
    ];
    const guessed = known.find(([p]) => comparablePath(p, deps.system.platform) === comparablePath(path, deps.system.platform))?.[1];
    const scope = (typeof scopeOption === "string" ? scopeOption : guessed ?? "user") as Scope;
    if (!["user", "project", "local", "managed"].includes(scope)) {
      err("Valeur invalide pour --scope : attendu user, project, local ou managed.");
      return ExitCode.UsageOrConfiguration;
    }
    targets = [{ scope, name: path, text }];
  } else targets = sources.filter((s) => s.scope !== "cli").map((s) => ({ scope: s.scope, name: s.name, text: s.text }));

  const reports = targets.map((t) => {
    // Each file is checked alone, in its scope, as if the project were trusted: every key is examined.
    const systemPolicyValue = t.name === systemPolicy?.name ? systemPolicy.read() : undefined;
    const cacheValue = t.name === cachePolicy.name ? cachePolicy.read() : undefined;
    const filePolicy = t.scope === "managed" && !systemPolicyValue && !cacheValue ? readManagedPolicy(t.name, deps.identity.resolved.policyAnchor, undefined, deps.policyFileProtection) : undefined;
    const text = cacheValue ? cacheValue.settingsText : systemPolicyValue ? systemPolicyValue.settingsText : filePolicy ? filePolicy.settingsText : t.text;
    const issues: ConfigIssue[] = text === undefined ? [] : Settings.load({ sources: [{ scope: t.scope, name: t.name, text }], projectTrusted: true }).issues;
    if (cacheValue) issues.push(...cacheValue.issues);
    else if (systemPolicyValue) issues.push(...systemPolicyValue.issues);
    else if (filePolicy) issues.push(...filePolicy.issues);
    // File validation remains strict; the protection warning on an optional system source stays a warning (FA-02).
    const severity = (i: ConfigIssue): "error" | "warning" => t.scope === "managed" && i.kind === "policy" ? i.severity : i.kind === "unknown-key" || i.kind === "untrusted" ? "warning" : "error";
    return { path: t.name, scope: t.scope, exists: text !== undefined, issues: issues.map((i) => ({ severity: severity(i), code: i.code, message: i.message, ...(i.kind ? { kind: i.kind } : {}), ...(i.key ? { key: i.key } : {}) })) };
  });
  const errors = reports.reduce((k, r) => k + r.issues.filter((i) => i.severity === "error").length, 0);
  write({ valid: errors === 0, files: reports }, () => {
    const lines: string[] = [];
    for (const r of reports) {
      if (!r.exists) {
        lines.push(`${r.path} (${r.scope}) : absent`);
      } else lines.push(`${r.path} (${r.scope}) : ${r.issues.length === 0 ? "valide" : `${r.issues.length} problème${r.issues.length > 1 ? "s" : ""}`}`);
      for (const i of r.issues) lines.push(`  ${i.severity === "error" ? "erreur" : "avertissement"} : ${i.message}`);
    }
    lines.push("", errors === 0 ? "Configuration valide." : `${errors} erreur${errors > 1 ? "s" : ""}.`);
    return lines.join("\n");
  });
  return errors === 0 ? ExitCode.Success : ExitCode.UsageOrConfiguration;
}
