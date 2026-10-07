// Implements: SPEC-EXT-002 (§ 5.1 actions, § 5.3 steps 1 to 6, FA-01, FA-03, EF-01 to EF-03, ERR-01, CA-01, CA-03), SPEC-EXT-003 (EF-03),
//             SPEC-EXT-004 (§ 5.3, FA-02, EF-05, ERR-01 to ERR-03, CA-01 to CA-03), SPEC-EXT-008 (CA-01)
// The `catalog` and `extension` operations of the command line: no session, no model (SPEC-MOD-012 EF-04).

import { randomUUID } from "node:crypto";
import { existsSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Settings } from "../config/settings";
import { setValueInSettingsFile } from "../config/settings-writer";
import { satisfies } from "../platform/semver";
import type { PlatformName } from "../platform/system";
import { parseRef } from "./ref";
import { cachedCatalog, catalogsDir, fetchSource, parseSource, readCatalog, refreshCatalog, type Catalog, type CatalogRegistration, type GitRunner } from "./catalog";
import { describeExtension } from "./extension";
import { engineProblem, installedVersions, listInstalled, uninstall } from "./store";
import { installExtension, type InstallInputs } from "./install";
import { blockedReason, flagOf } from "./policy";
import { compareVersions } from "../platform/semver";

export type WritableScope = "user" | "project" | "local";

export interface ExtensionAdminContext {
  readonly configDir: string;
  readonly cwd: string;
  readonly platform: PlatformName;
  readonly product: { readonly name: string; readonly version: string; readonly cli: string };
  readonly settings: Settings;
  /** Settings file of each scope the user may write. */
  readonly files: Readonly<Record<WritableScope, string>>;
  readonly runner: GitRunner;
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  readonly write: (document: unknown, text: () => string) => void;
  /** Asks the user; false when nobody can answer (no terminal). */
  readonly confirm: (question: string) => Promise<boolean>;
}

const OK = 0;
const FAILED = 1;
const USAGE = 2;
const CONSENT = 5;

export function scopeOf(value: string | true | undefined): WritableScope | undefined {
  if (value === undefined) return "user";
  return value === "user" || value === "project" || value === "local" ? value : undefined;
}

const registrations = (s: Settings) => s.get<Record<string, CatalogRegistration>>("extensions.catalogs");

/** ERR-03 of SPEC-EXT-004: catalogues outside `extensions.strictCatalogs`, or in `extensions.blockedCatalogs` (by name or source). */
export function catalogRefused(s: Settings, name: string, source: string): string | undefined {
  const strict = s.get<string[] | undefined>("extensions.strictCatalogs");
  const blocked = s.get<string[]>("extensions.blockedCatalogs");
  if (blocked.includes(name) || blocked.includes(source) || (strict !== undefined && !strict.includes(name) && !strict.includes(source))) return "Catalogue non autorisé par votre organisation.";
  return undefined;
}

/** `catalog add <source> [--scope] [--lean-context <paths>] [--name <name>]` (§ 5.3 steps 1 to 5). */
export function catalogAdd(ctx: ExtensionAdminContext, input: string, scope: WritableScope, lean: readonly string[] | undefined, rename: string | undefined): number {
  const source = parseSource(input, ctx.cwd);
  const temp = join(catalogsDir(ctx.configDir), `.tmp-${randomUUID()}`);
  const failed = fetchSource(source, temp, { lean }, ctx.runner);
  const read = failed ? { error: failed } : readCatalog(temp);
  const discard = (message: string, code = FAILED) => {
    rmSync(temp, { recursive: true, force: true });
    ctx.err(message);
    return code;
  };
  if (read.error || !read.catalog) return discard(read.error ?? "Aucun catalogue valide à cette adresse."); // ERR-01, ERR-04
  const name = rename ?? read.catalog.name;
  const stored = source.kind === "folder" ? source.path : source.kind === "git" ? source.url : source.value;
  const refused = catalogRefused(ctx.settings, name, stored);
  if (refused) return discard(refused); // ERR-03
  if (registrations(ctx.settings)[name] !== undefined || existsSync(join(catalogsDir(ctx.configDir), name))) return discard(`Un catalogue porte déjà ce nom : ${name} (--name pour l'enregistrer sous un autre nom).`); // ERR-02
  renameSync(temp, join(catalogsDir(ctx.configDir), name));
  const registration: CatalogRegistration = { source: stored, ...(lean && lean.length > 0 ? { leanContext: lean } : {}) };
  setValueInSettingsFile(ctx.files[scope], ["extensions", "catalogs", name], registration, ctx.platform);
  const names = read.catalog.extensions.map((e) => e.name);
  ctx.write({ name, scope, extensions: names }, () => `Catalogue ${name} ajouté en portée ${scope} : ${names.length} extension(s)${names.length > 0 ? ` (${names.join(", ")})` : ""}.`);
  return OK;
}

/** `catalog list`: the registered catalogues, their cache and their extensions. */
export function catalogList(ctx: ExtensionAdminContext): number {
  const docs = Object.entries(registrations(ctx.settings))
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, r]) => {
      const c = cachedCatalog(ctx.configDir, name);
      return { name, source: r.source, cached: c !== undefined, extensions: c?.extensions.map((e) => e.name) ?? [] };
    });
  ctx.write(docs, () => (docs.length === 0 ? "Aucun catalogue configuré." : docs.map((d) => `${d.name} — ${d.source}${d.cached ? ` : ${d.extensions.join(", ") || "aucune extension"}` : " (cache absent : catalog update)"}`).join("\n")));
  return OK;
}

/** `catalog update [<name>]`: a refresh that fails keeps the cache, with a warning (FA-02, CA-03). */
export function catalogUpdate(ctx: ExtensionAdminContext, only: string | undefined): number {
  const all = registrations(ctx.settings);
  const names = only ? [only] : Object.keys(all).sort();
  if (only && !all[only]) {
    ctx.err(`Catalogue inconnu : ${only}.`);
    return USAGE;
  }
  for (const name of names) {
    const r = refreshCatalog(ctx.configDir, name, all[name]!, ctx.cwd, ctx.runner);
    if (r.error) ctx.err(`avertissement : rafraîchissement impossible du catalogue ${name} (${r.error}) ; le cache est conservé.`);
    else {
      ctx.out(`Catalogue ${name} à jour : ${r.catalog!.extensions.length} extension(s).`);
      // SPEC-EXT-010 step 2, CA-01: the installed extensions it flags, with the reason.
      for (const i of listInstalled(ctx.configDir).filter((x) => x.catalog === name)) {
        const flag = flagOf(ctx.settings, ctx.configDir, i.name, name, i.versions[0]!);
        if (flag?.severity === "critical") ctx.err(`Extension ${i.name}@${name} désactivée : signalée critique par son catalogue : ${flag.reason}`);
        else if (flag) ctx.err(`avertissement : extension ${i.name}@${name} signalée par son catalogue : ${flag.reason}`);
      }
    }
  }
  return OK;
}

/** `catalog remove <name> [--scope]`; the extensions installed from it are listed for removal (EF-05). */
export async function catalogRemove(ctx: ExtensionAdminContext, name: string, scope: WritableScope | undefined, force: boolean): Promise<number> {
  const scopes = ctx.settings.valuesByScope("extensions.catalogs").filter((v) => (v.value as Record<string, unknown>)[name] !== undefined).map((v) => v.origin);
  if (scopes.length === 0) {
    ctx.err(`Catalogue inconnu : ${name}.`);
    return USAGE;
  }
  if (scopes.includes("managed")) {
    ctx.err("Ce catalogue est ajouté par votre organisation : il ne peut pas être retiré.");
    return FAILED;
  }
  // SPEC-MOD-012 EF-03, CA-03: a destructive operation is confirmed; without a terminal, only `--force` allows it.
  if (!(force || (await ctx.confirm(`Retirer le catalogue ${name} ?`)))) {
    ctx.err("Opération non confirmée : relancez avec --force pour retirer le catalogue sans terminal.");
    return CONSENT;
  }
  for (const s of scope ? [scope] : (scopes as WritableScope[])) if (ctx.files[s]) setValueInSettingsFile(ctx.files[s], ["extensions", "catalogs", name], undefined, ctx.platform);
  rmSync(join(catalogsDir(ctx.configDir), name), { recursive: true, force: true });
  ctx.out(`Catalogue ${name} retiré.`);
  const installed = listInstalled(ctx.configDir).filter((i) => i.catalog === name);
  if (installed.length > 0) ctx.out(`Extensions installées depuis ce catalogue : ${installed.map((i) => i.name).join(", ")}. Pour les désinstaller : ${installed.map((i) => `${ctx.product.cli} extension remove ${i.name}@${name}`).join(" ; ")}.`);
  return OK;
}

/** The catalogue of an extension reference: given, or the only registered catalogue that lists it. */
function locate(ctx: ExtensionAdminContext, ref: string): { name: string; catalog: Catalog } | string {
  const { name, catalog } = parseRef(ref);
  const all = registrations(ctx.settings);
  const candidates = catalog ? [catalog] : Object.keys(all).filter((c) => cachedCatalog(ctx.configDir, c)?.extensions.some((e) => e.name === name));
  if (candidates.length > 1) return `Extension ${name} présente dans plusieurs catalogues (${candidates.join(", ")}) : précisez ${name}@<catalogue>.`;
  const chosen = candidates[0];
  if (!chosen || !all[chosen]) return catalog ? `Catalogue inconnu : ${catalog}.` : "Extension introuvable dans le catalogue."; // ERR-01
  let c = cachedCatalog(ctx.configDir, chosen);
  if (!c) {
    const r = refreshCatalog(ctx.configDir, chosen, all[chosen]!, ctx.cwd, ctx.runner);
    if (r.error) return `Catalogue ${chosen} indisponible : ${r.error}.`;
    c = r.catalog!;
  }
  return { name, catalog: c };
}

/** `extension add <name>@<catalogue> [--scope] [--force]` (§ 5.3): with its dependencies (SPEC-EXT-007), activated in the scope. */
export async function extensionAdd(ctx: ExtensionAdminContext, ref: string, scope: WritableScope, force: boolean): Promise<number> {
  const found = locate(ctx, ref);
  if (typeof found === "string") {
    ctx.err(found);
    return FAILED;
  }
  const entry = found.catalog.extensions.find((e) => e.name === found.name);
  if (!entry) {
    ctx.err("Extension introuvable dans le catalogue."); // ERR-01
    return FAILED;
  }
  const key = `${entry.name}@${found.catalog.name}`;
  const outcome = await installExtension(installInputs(ctx), found.catalog, entry, async (summary) => {
    ctx.out(summary.join("\n")); // step 4, EF-01
    return force || ctx.confirm(`Installer ${key} et l'activer en portée ${scope} ?`);
  });
  if (!outcome.ok) {
    ctx.err(outcome.error);
    return outcome.consent ? CONSENT : FAILED;
  }
  // Step 6 and SPEC-EXT-007 step 4: the extension and its dependencies are activated in the same scope.
  for (const k of outcome.activate) setValueInSettingsFile(ctx.files[scope], ["extensions", "enabled", k], true, ctx.platform);
  for (const i of outcome.inactive) ctx.err(`Extension ${i.key} installée mais non activée : ${i.problem}`); // CA-01 of SPEC-EXT-008
  const target = outcome.steps.find((s) => s.key === key)!;
  if (outcome.inactive.some((i) => i.key === key)) return FAILED;
  const deps = outcome.steps.filter((s) => s.key !== key).map((s) => `${s.key} ${s.version}`);
  ctx.out(`Extension ${key} ${target.version} installée et activée en portée ${scope}${deps.length > 0 ? `, avec ${deps.join(", ")}` : ""} ; elle sera chargée par les prochaines sessions.`);
  return OK;
}

function installInputs(ctx: ExtensionAdminContext): InstallInputs {
  return { configDir: ctx.configDir, settings: ctx.settings, runner: ctx.runner, product: ctx.product };
}

/**
 * `extension update [<name>] [--force]`: the version of the catalogue when it is higher than the installed one; a
 * pre-release only with `extensions.allowPrerelease` (SPEC-EXT-008 FA-01, CA-02). The previous version stays installed (EF-03).
 */
export async function extensionUpdate(ctx: ExtensionAdminContext, ref: string | undefined, force: boolean): Promise<number> {
  const keys = ref ? [installedKey(ctx, ref)] : listInstalled(ctx.configDir).map((i) => `${i.name}@${i.catalog}`);
  let code = OK;
  for (const k of keys) {
    if (typeof k !== "string") {
      ctx.err(k.error);
      return FAILED;
    }
    const { name, catalog } = parseRef(k);
    const registration = ctx.settings.get<Record<string, CatalogRegistration>>("extensions.catalogs")[catalog!];
    const refreshed = registration ? refreshCatalog(ctx.configDir, catalog!, registration, ctx.cwd, ctx.runner) : { error: "catalogue non configuré" };
    if (refreshed.error) ctx.err(`avertissement : catalogue ${catalog} non rafraîchi (${refreshed.error}) ; dernière liste connue utilisée.`);
    const c = refreshed.catalog ?? cachedCatalog(ctx.configDir, catalog!);
    const entry = c?.extensions.find((e) => e.name === name);
    const current = installedVersions(ctx.configDir, catalog!, name)[0]!;
    if (!c || !entry) {
      ctx.err(`${k} : absente du catalogue ; aucune mise à jour.`);
      continue;
    }
    if (entry.version && compareVersions(entry.version, current) <= 0) {
      ctx.out(`${k} est à jour (${current}).`);
      continue;
    }
    if (entry.version && entry.version.includes("-") && !ctx.settings.get<boolean>("extensions.allowPrerelease")) {
      ctx.out(`${k} : la version ${entry.version} est une préversion ; ignorée (extensions.allowPrerelease).`);
      continue;
    }
    const outcome = await installExtension(installInputs(ctx), c, entry, async (summary) => {
      ctx.out(summary.join("\n"));
      return force || ctx.confirm(`Mettre à jour ${k} ?`);
    });
    if (!outcome.ok) {
      ctx.err(`${k} : ${outcome.error}`);
      code = outcome.consent ? CONSENT : FAILED;
      continue;
    }
    const target = outcome.steps.find((s) => s.key === k)!;
    if (compareVersions(target.version, current) <= 0) ctx.out(`${k} est à jour (${current}).`);
    else ctx.out(`${k} mise à jour : ${current} → ${target.version}.`);
  }
  return code;
}

/** The installed extension a reference designates: `<name>@<catalogue>`, or a name installed from one catalogue only. */
function installedKey(ctx: ExtensionAdminContext, ref: string): string | { error: string } {
  const { name, catalog } = parseRef(ref);
  const matches = listInstalled(ctx.configDir).filter((i) => i.name === name && (!catalog || i.catalog === catalog));
  if (matches.length === 0) return { error: `Extension non installée : ${ref}.` };
  if (matches.length > 1) return { error: `Extension ${name} installée depuis plusieurs catalogues : précisez ${matches.map((m) => `${name}@${m.catalog}`).join(" ou ")}.` };
  return `${name}@${matches[0]!.catalog}`;
}

/** `extension enable|disable <name> [--scope]`: `extensions.enabled` of the scope; an activation imposed by the managed scope stays (EF-03). */
export function extensionEnable(ctx: ExtensionAdminContext, ref: string, scope: WritableScope, value: boolean): number {
  const key = installedKey(ctx, ref);
  if (typeof key !== "string") {
    ctx.err(key.error);
    return FAILED;
  }
  const managed = ctx.settings.valuesByScope("extensions.enabled").find((v) => v.origin === "managed")?.value as Record<string, unknown> | undefined;
  if (!value && managed?.[key] === true) {
    ctx.err(`L'activation de ${key} est imposée par votre organisation : elle ne peut pas être désactivée.`);
    return FAILED;
  }
  if (value) {
    const { name, catalog } = parseRef(key);
    const version = installedVersions(ctx.configDir, catalog!, name)[0]!;
    const blocked = blockedReason(ctx.settings, name, catalog!);
    if (blocked) {
      ctx.err(blocked);
      return FAILED;
    }
    // SPEC-EXT-010 CA-02: never for an extension flagged critical.
    const flag = flagOf(ctx.settings, ctx.configDir, name, catalog!, version);
    if (flag?.severity === "critical") {
      ctx.err(`Extension ${key} signalée critique par son catalogue : ${flag.reason}. Activation refusée.`);
      return FAILED;
    }
    const problem = engineProblem(describeExtension(join(ctx.configDir, "extensions", catalog!, name, version), false), ctx.product.version, ctx.product.name);
    if (problem) {
      ctx.err(`Extension ${key} non activée : ${problem}`);
      return FAILED;
    }
  }
  setValueInSettingsFile(ctx.files[scope], ["extensions", "enabled", key], value, ctx.platform);
  ctx.out(`Extension ${key} ${value ? "activée" : "désactivée"} en portée ${scope}${scope === "user" ? "" : " (ce projet seulement)"}.`);
  return OK;
}

/** `extension remove <name> [--scope] [--preserve-data]`: deactivated, then the copy removed when no scope of this project uses it. */
export async function extensionRemove(ctx: ExtensionAdminContext, ref: string, scope: WritableScope | undefined, preserveData: boolean, force: boolean): Promise<number> {
  const key = installedKey(ctx, ref);
  if (typeof key !== "string") {
    ctx.err(key.error);
    return FAILED;
  }
  const byScope = ctx.settings.valuesByScope("extensions.enabled").filter((v) => (v.value as Record<string, unknown>)[key] !== undefined);
  if (byScope.some((v) => v.origin === "managed")) {
    ctx.err(`L'activation de ${key} est imposée par votre organisation : elle ne peut pas être désinstallée.`);
    return FAILED;
  }
  // SPEC-MOD-012 EF-03, CA-03: a destructive operation is confirmed; without a terminal, only `--force` allows it.
  if (!(force || (await ctx.confirm(`Désinstaller ${key} ?`)))) {
    ctx.err("Opération non confirmée : relancez avec --force pour désinstaller sans terminal.");
    return CONSENT;
  }
  const targets = scope ? [scope] : (byScope.map((v) => v.origin).filter((o) => o === "user" || o === "project" || o === "local") as WritableScope[]);
  for (const s of targets) setValueInSettingsFile(ctx.files[s], ["extensions", "enabled", key], undefined, ctx.platform);
  const still = byScope.filter((v) => !targets.includes(v.origin as WritableScope) && (v.value as Record<string, unknown>)[key] === true);
  const { name, catalog } = parseRef(key);
  if (still.length > 0) {
    ctx.out(`Extension ${key} désactivée en portée ${targets.join(", ")} ; encore activée en portée ${still.map((v) => v.origin).join(", ")}, la copie installée est conservée.`);
    return OK;
  }
  uninstall(ctx.configDir, catalog!, name, preserveData);
  ctx.out(`Extension ${key} désinstallée${preserveData ? " (données conservées)" : ""}.`);
  return OK;
}

/** `extension list [--installable]`: installed versions and activation in this project; or what the catalogues offer. */
export function extensionList(ctx: ExtensionAdminContext, installable: boolean): number {
  const enabled = ctx.settings.get<Record<string, unknown>>("extensions.enabled");
  const installed = listInstalled(ctx.configDir);
  if (installable) {
    const docs = Object.keys(registrations(ctx.settings))
      .sort()
      .flatMap((c) => (cachedCatalog(ctx.configDir, c)?.extensions ?? []).map((e) => ({ name: e.name, catalog: c, version: e.version, description: e.description, installed: installed.some((i) => i.name === e.name && i.catalog === c) })))
      .filter((d) => !d.installed);
    ctx.write(docs, () => (docs.length === 0 ? "Aucune extension installable." : docs.map((d) => `${d.name}@${d.catalog}${d.version ? ` ${d.version}` : ""}${d.description ? ` — ${d.description}` : ""}`).join("\n")));
    return OK;
  }
  const docs = installed.map((i) => ({ name: i.name, catalog: i.catalog, versions: i.versions, active: enabled[`${i.name}@${i.catalog}`] === true }));
  ctx.write(docs, () => (docs.length === 0 ? "Aucune extension installée." : docs.map((d) => `${d.name}@${d.catalog} ${d.versions[0]}${d.versions.length > 1 ? ` (aussi ${d.versions.slice(1).join(", ")})` : ""} — ${d.active ? "active" : "inactive"}`).join("\n")));
  return OK;
}
