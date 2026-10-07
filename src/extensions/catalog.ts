// Implements: SPEC-EXT-004 (§ 5.1 format, § 5.3 steps 1 to 5, FA-02, FA-03, EF-02 to EF-04, ERR-01, ERR-02, ERR-04, CA-01 to CA-03)
// Catalogues of extensions: a `catalog.json` in a local folder or a Git repository, fetched into a cache of the
// configuration folder; the extensions are then installed from it.

import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { parse, type ParseError } from "jsonc-parser";
import { runToCompletion } from "../platform/process";
import { findExecutable } from "../platform/system";
import { compileRaw, describeErrors } from "../shared/schema";

const NAME = { pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 48 };
const GIT_SOURCE = Type.Object({ git: Type.String({ minLength: 1 }), ref: Type.Optional(Type.String()), path: Type.Optional(Type.String()) }, { additionalProperties: false });

/** Schema of `catalog.json` (EF-02). */
export const CATALOG_SCHEMA = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    name: Type.String(NAME),
    owner: Type.Optional(Type.Object({ name: Type.Optional(Type.String()), contact: Type.Optional(Type.String()) })),
    extensions: Type.Array(
      Type.Object(
        { name: Type.String(NAME), source: Type.Union([Type.String({ minLength: 1 }), GIT_SOURCE]), description: Type.Optional(Type.String()), version: Type.Optional(Type.String()) },
        { additionalProperties: false },
      ),
    ),
    /** Extensions flagged by the catalogue (SPEC-EXT-010). */
    flagged: Type.Optional(
      Type.Array(
        Type.Object(
          { name: Type.String(), versions: Type.Optional(Type.String()), severity: Type.Union([Type.Literal("critical"), Type.Literal("warning")]), reason: Type.String() },
          { additionalProperties: false },
        ),
      ),
    ),
  },
  { additionalProperties: false },
);
const validateCatalog = compileRaw(CATALOG_SCHEMA);

export type GitSource = { readonly git: string; readonly ref?: string; readonly path?: string };

export interface CatalogEntry {
  readonly name: string;
  readonly source: string | GitSource;
  readonly description?: string;
  readonly version?: string;
}

export interface Catalog {
  readonly name: string;
  readonly extensions: readonly CatalogEntry[];
  readonly flagged: ReadonlyArray<{ readonly name: string; readonly versions?: string; readonly severity: "critical" | "warning"; readonly reason: string }>;
}

/** Registration of a catalogue in `extensions.catalogs` (§ 11). */
export interface CatalogRegistration {
  readonly source: string;
  readonly ref?: string;
  readonly leanContext?: readonly string[];
}

export type SourceKind = { readonly kind: "folder"; readonly path: string } | { readonly kind: "git"; readonly url: string } | { readonly kind: "url" | "archive"; readonly value: string };

export const CATALOG_FILE = "catalog.json";
export const catalogsDir = (configDir: string) => join(configDir, "catalogs");

/** Step 1: `owner/repo`, a Git URL, an archive, a web address or a local path. */
export function parseSource(input: string, cwd: string): SourceKind {
  const v = input.trim();
  if (/\.(zip|tar|tgz|tar\.gz)$/i.test(v)) return { kind: "archive", value: v };
  if (/^(git@|ssh:\/\/|git:\/\/|file:\/\/)/.test(v) || /^https?:\/\/.+\.git\/?$/i.test(v)) return { kind: "git", url: v };
  if (/^https?:\/\//i.test(v)) return { kind: "url", value: v };
  const path = isAbsolute(v) ? v : resolve(cwd, v);
  if (existsSync(path)) return existsSync(join(path, ".git")) ? { kind: "git", url: path } : { kind: "folder", path };
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(v)) return { kind: "git", url: `https://github.com/${v}.git` };
  return { kind: "folder", path };
}

export interface GitRunner {
  /** Environment of the Git processes: the user's own credentials, never stored by the product (FA-03). */
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** Runs Git; the message of its failure, or undefined. ERR-04 when Git is absent. */
export function git(args: readonly string[], cwd: string, runner: GitRunner): string | undefined {
  if (!findExecutable("git")) return "Git est nécessaire pour cette source : installez-le ou choisissez une autre source.";
  const r = runToCompletion("git", args, { cwd, env: { ...runner.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: runner.timeoutMs });
  return r.code === 0 ? undefined : (r.stderr.trim().split("\n").pop() ?? `git ${args[0]} a échoué`);
}

/** Step 2: a shallow clone, limited to `lean` paths when given (EF-04, CA-02). */
export function cloneGit(url: string, dest: string, o: { ref?: string; lean?: readonly string[] }, runner: GitRunner): string | undefined {
  const clone = ["clone", "--depth", "1", "--quiet", ...(o.lean && o.lean.length > 0 ? ["--no-checkout"] : []), ...(o.ref ? ["--branch", o.ref] : []), url, dest];
  const failed = git(clone, resolve(dest, ".."), runner);
  if (failed) return failed;
  if (o.lean && o.lean.length > 0) {
    // Cone mode: the files of the root (the catalogue) and the folders named.
    return git(["sparse-checkout", "set", ...o.lean.map((p) => p.replace(/\/+$/, ""))], dest, runner) ?? git(["checkout", "--quiet"], dest, runner);
  }
  return undefined;
}

/** Step 2 for any source, into `dest` (which must not exist). */
export function fetchSource(source: SourceKind, dest: string, o: { ref?: string; lean?: readonly string[] }, runner: GitRunner): string | undefined {
  mkdirSync(resolve(dest, ".."), { recursive: true });
  if (source.kind === "folder") {
    if (!existsSync(source.path)) return "Aucun catalogue valide à cette adresse.";
    cpSync(source.path, dest, { recursive: true, filter: (p) => !relative(source.path, p).split(/[\\/]/).includes(".git") });
    return undefined;
  }
  if (source.kind === "git") return cloneGit(source.url, dest, o, runner);
  return `Type de source non disponible dans cette version : ${source.kind === "url" ? "adresse web" : "archive"} (${source.value}).`;
}

/** Step 3: `catalog.json` validated (ERR-01). */
export function readCatalog(dir: string): { catalog?: Catalog; error?: string } {
  const file = join(dir, CATALOG_FILE);
  if (!existsSync(file)) return { error: "Aucun catalogue valide à cette adresse." };
  const errors: ParseError[] = [];
  const data: unknown = parse(readFileSync(file, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length > 0) return { error: "Aucun catalogue valide à cette adresse : catalog.json n'est pas du JSON valide." };
  if (!validateCatalog(data)) return { error: `Aucun catalogue valide à cette adresse : ${describeErrors(validateCatalog.errors).join(" ; ")}.` };
  const c = data as { name: string; extensions: CatalogEntry[]; flagged?: Catalog["flagged"] };
  // EF-03: relative sources stay inside the catalogue.
  for (const e of c.extensions) {
    if (typeof e.source !== "string") continue;
    const r = relative(dir, resolve(dir, e.source));
    if (isAbsolute(e.source) || r.startsWith("..") || isAbsolute(r)) return { error: `Aucun catalogue valide à cette adresse : la source de ${e.name} sort du catalogue.` };
  }
  const names = c.extensions.map((e) => e.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) return { error: `Aucun catalogue valide à cette adresse : ${twice} figure deux fois.` };
  return { catalog: { name: c.name, extensions: c.extensions, flagged: c.flagged ?? [] } };
}

/** The cached catalogue `name`, when present. */
export function cachedCatalog(configDir: string, name: string): Catalog | undefined {
  const dir = join(catalogsDir(configDir), name);
  return existsSync(dir) ? readCatalog(dir).catalog : undefined;
}

/** Replaces the cache of a catalogue by a fetched copy; the previous cache stays when the new one is invalid (FA-02). */
export function refreshCatalog(configDir: string, name: string, registration: CatalogRegistration, cwd: string, runner: GitRunner): { catalog?: Catalog; error?: string } {
  const root = catalogsDir(configDir);
  const temp = join(root, `.tmp-${name}-${randomUUID()}`);
  const failed = fetchSource(parseSource(registration.source, cwd), temp, { ref: registration.ref, lean: registration.leanContext }, runner);
  const read = failed ? { error: failed } : readCatalog(temp);
  if (read.error || !read.catalog || read.catalog.name !== name) {
    rmSync(temp, { recursive: true, force: true });
    return { error: read.error ?? `le catalogue récupéré s'appelle ${read.catalog?.name}, et non ${name}` };
  }
  const final = join(root, name);
  rmSync(final, { recursive: true, force: true });
  renameSync(temp, final);
  return { catalog: read.catalog };
}
