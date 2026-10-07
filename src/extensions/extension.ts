// Implements: SPEC-EXT-001 (§ 5.1 structure, § 5.2 manifest, § 5.3 variables, FA-01, EF-01 to EF-03, ERR-01 to ERR-03, CA-02, CA-03)
// An extension folder: its manifest validated against the published schema, its components found by convention or
// by the `components` field, never outside the folder.

import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { parse, type ParseError } from "jsonc-parser";
import { compileRaw, describeErrors } from "../shared/schema";

const SEMVER = "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\\+[0-9A-Za-z.-]+)?$";
const paths = () => Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())]));

/** Schema of `extension.json` (EF-01), published with the product documentation. */
export const EXTENSION_MANIFEST_SCHEMA = Type.Object(
  {
    $schema: Type.Optional(Type.String()),
    name: Type.String({ pattern: "^[a-z0-9]+(-[a-z0-9]+)*$", maxLength: 48 }),
    version: Type.String({ pattern: SEMVER }),
    description: Type.String({ minLength: 1, maxLength: 300 }),
    author: Type.Optional(Type.Object({ name: Type.Optional(Type.String()), contact: Type.Optional(Type.String()) })),
    homepage: Type.Optional(Type.String()),
    repository: Type.Optional(Type.String()),
    license: Type.Optional(Type.String()),
    keywords: Type.Optional(Type.Array(Type.String())),
    dependencies: Type.Optional(Type.Record(Type.String(), Type.String())),
    engine: Type.Optional(Type.String()),
    options: Type.Optional(Type.Object({}, { additionalProperties: true })),
    components: Type.Optional(
      Type.Object(
        { skills: paths(), commands: paths(), agents: paths(), hooks: Type.Optional(Type.String()), connectors: Type.Optional(Type.String()), languageServers: Type.Optional(Type.String()), responseStyles: paths() },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);
const validateManifest = compileRaw(EXTENSION_MANIFEST_SCHEMA);
export const MANIFEST_FILE = "extension.json";
export const RESERVED_NAMES = new Set(["project", "user"]);

export interface ExtensionProblem {
  readonly level: "error" | "warning" | "info";
  readonly file: string;
  readonly line?: number;
  readonly message: string;
}

export interface Extension {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly root: string;
  readonly manifest?: Record<string, unknown>;
  readonly skillsDirs: readonly string[];
  readonly commandsDirs: readonly string[];
  readonly hooksFile?: string;
  readonly connectorsFile?: string;
  /** Components present but not loaded by this version (agents, language servers, response styles). */
  readonly unsupported: readonly string[];
  /** JSON Schema of the options (SPEC-EXT-015). */
  readonly optionsSchema?: Record<string, unknown>;
  readonly problems: readonly ExtensionProblem[];
  /** False when the extension cannot be loaded at all (invalid manifest, reserved name). */
  readonly usable: boolean;
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** A JSON file of the extension, with the line of a syntax error (SPEC-EXT-012 EF-02). */
export function readJsonFile(file: string): { value?: unknown; error?: { line: number; message: string } } {
  const text = readFileSync(file, "utf8");
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) return { error: { line: lineOf(text, errors[0]!.offset), message: "JSON invalide" } };
  return { value };
}

/** EF-02: a component path stays inside the folder of the extension. */
function inside(root: string, p: string): string | undefined {
  if (isAbsolute(p)) return undefined;
  const full = resolve(root, p);
  const r = relative(root, full);
  return r.startsWith("..") || isAbsolute(r) ? undefined : full;
}

const asList = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? (v as string[]) : []);

/**
 * Reads the extension in `root`. In development (`--extension-dir`), a folder without manifest is accepted under a name
 * derived from the folder (FA-01); otherwise the manifest is required.
 */
export function describeExtension(root: string, development: boolean): Extension {
  const problems: ExtensionProblem[] = [];
  const manifestFile = join(root, MANIFEST_FILE);
  let manifest: Record<string, unknown> | undefined;
  let usable = true;
  if (existsSync(manifestFile)) {
    const read = readJsonFile(manifestFile);
    if (read.error) {
      problems.push({ level: "error", file: manifestFile, line: read.error.line, message: `Manifeste d'extension invalide : ${read.error.message}.` });
      usable = false;
    } else if (!validateManifest(read.value)) {
      for (const d of describeErrors(validateManifest.errors)) problems.push({ level: "error", file: manifestFile, message: `Manifeste d'extension invalide : ${d}.` }); // ERR-01
      usable = false;
      if (typeof read.value === "object" && read.value !== null) manifest = read.value as Record<string, unknown>;
    } else manifest = read.value as Record<string, unknown>;
  } else if (development) {
    problems.push({ level: "warning", file: manifestFile, message: "Extension sans manifeste : nom dérivé du dossier (mode développement)." }); // FA-01
  } else {
    problems.push({ level: "error", file: manifestFile, message: "Manifeste d'extension absent." });
    usable = false;
  }
  const derived = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "extension";
  const name = typeof manifest?.["name"] === "string" ? manifest["name"] : derived;
  if (RESERVED_NAMES.has(name)) {
    problems.push({ level: "error", file: manifestFile, message: `Le nom ${name} est réservé au produit.` }); // ERR-03
    usable = false;
  }
  // § 5.1 by convention, plus the paths of `components` (EF-02, ERR-02).
  const components = (manifest?.["components"] ?? {}) as Record<string, unknown>;
  const declared = (kind: string): string[] => {
    const out: string[] = [];
    for (const p of asList(components[kind])) {
      const full = inside(root, p);
      if (full) out.push(full);
      else problems.push({ level: "error", file: manifestFile, message: `Chemin de composant non autorisé : ${p} (${kind}).` });
    }
    return out;
  };
  const existing = (dirs: string[]) => [...new Set(dirs)].filter((d) => existsSync(d) && statSync(d).isDirectory());
  const skillsDirs = existing([join(root, "skills"), ...declared("skills")]);
  const commandsDirs = existing([join(root, "commands"), ...declared("commands")]);
  const hooksFile = declared("hooks")[0] ?? join(root, "event-hooks.json");
  const connectorsFile = declared("connectors")[0] ?? join(root, "connectors.json");
  const unsupported: string[] = [];
  for (const [kind, conventional] of [["agents", "agent-profiles"], ["languageServers", "language-servers.json"], ["responseStyles", "response-styles"]] as const) {
    if (existsSync(join(root, conventional)) || declared(kind).length > 0) unsupported.push(kind);
  }
  return {
    name,
    version: typeof manifest?.["version"] === "string" ? manifest["version"] : "0.0.0-dev",
    description: typeof manifest?.["description"] === "string" ? manifest["description"] : "",
    root,
    manifest,
    skillsDirs,
    commandsDirs,
    hooksFile: existsSync(hooksFile) ? hooksFile : undefined,
    connectorsFile: existsSync(connectorsFile) ? connectorsFile : undefined,
    unsupported,
    optionsSchema: (manifest?.["options"] as Record<string, unknown> | undefined) ?? undefined,
    problems,
    usable,
  };
}

/** Substitutes the variables of an extension in every text of a component (EF-03); collects the options used but missing. */
export function substituteVariables(value: unknown, vars: { readonly root: string; readonly data: string; readonly options: Readonly<Record<string, unknown>> }, missing: Set<string>): unknown {
  if (typeof value === "string")
    return value.replace(/\$\{(EXTENSION_ROOT|EXTENSION_DATA)\}|\$\{OPTION:([A-Za-z0-9_.-]+)\}/g, (_, v: string | undefined, option: string | undefined) => {
      if (v === "EXTENSION_ROOT") return vars.root;
      if (v === "EXTENSION_DATA") return vars.data;
      const o = vars.options[option!];
      if (o === undefined) {
        missing.add(option!);
        return "";
      }
      return typeof o === "string" ? o : JSON.stringify(o);
    });
  if (Array.isArray(value)) return value.map((v) => substituteVariables(v, vars, missing));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteVariables(v, vars, missing)]));
  return value;
}
