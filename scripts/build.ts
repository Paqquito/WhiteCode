// Supports: SPEC-BLD-008 (CA-01, versioned extension documentation in the manifest), gap E-161.
// Supports: SPEC-BLD-006 (identity-specific package manifest), gap E-160.
// Implements: SPEC-BLD-001 (ordered gates, reproducibility, fingerprints), SPEC-BLD-002 (macro constants and inventory),
//             SPEC-BLD-003 (mandatory deliverable scan), SPEC-CAD-002 (strict unresolved-variable control, EF-04/ERR-10 brand icon).
// Supports: gap E-144. Usage: bun scripts/build.ts [--target <target> | --all] [--identity <file>] [--models <file>]
//           [--profile public|internal|development|test] [--build-options <file>] [--forbidden-terms <private external file>]
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { Identity } from "../src/identity/identity";
import { resolveIdentityText, runtimeIdentity } from "../src/identity/resolver";
import { scanDirectory, type ScanCache } from "../src/identity/files";
import { loadIcon } from "../src/identity/resources";
import { VARIABLE_BY_NAME } from "../src/identity/catalog";
import { suggest } from "../src/shared/suggest";
import { BUILD_OPTIONS, resolveBuildOptions } from "../src/extension-points/build-options";
import { publishSettingsSchema } from "./settings-schema";
import { bootstrapScript } from "../src/installation/bootstrap";
import { BUILD_TARGETS, hostBuildTarget } from "../src/platform/build-target";

const root = resolve(import.meta.dir, "..");
const outDir = resolve(root, "dist");
// Before invalidating a receipt or recursively deleting output, check the exact target and physical ancestors.
if (dirname(outDir) !== root || outDir !== join(root, "dist")) throw new Error("Sortie de build inattendue.");
const physicalKey = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
function checkOutput(): void {
  for (let path = outDir; ; path = dirname(path)) {
    if (existsSync(path) && (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory() || physicalKey(realpathSync(path)) !== physicalKey(resolve(path)))) throw new Error(`Lien ou dossier de build non ordinaire : ${path}.`);
    if (path === root) break;
  }
}
checkOutput();
try {
  const receipt = join(outDir, "manifest.json"), stat = lstatSync(receipt);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Manifeste de build non ordinaire.");
  unlinkSync(receipt);
} catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
if (Bun.version !== "1.4.2") throw new Error("La construction exige Bun 1.4.2.");
const TARGETS: readonly string[] = BUILD_TARGETS;
const options = new Map<string, string>(); let all = false;
for (let i = 2; i < process.argv.length; i++) {
  const name = process.argv[i]!;
  if (name === "--all") { all = true; continue; }
  if (!["--target", "--identity", "--models", "--profile", "--build-options", "--forbidden-terms"].includes(name) || !process.argv[i + 1] || process.argv[i + 1]!.startsWith("--") || options.has(name)) throw new Error(`Option de build invalide : ${name}.`);
  options.set(name, process.argv[++i]!);
}
if ((all && options.has("--target")) || (options.has("--target") && !TARGETS.includes(options.get("--target")!))) throw new Error("Cible de build invalide.");
const profile = options.get("--profile") ?? "public";
const primaryTarget = options.get("--target") ?? hostBuildTarget();
const overrides: unknown = options.has("--build-options") ? JSON.parse(readFileSync(resolve(root, options.get("--build-options")!), "utf8")) : {};
const values = resolveBuildOptions(profile, overrides, primaryTarget);
const targets = all ? TARGETS : [options.get("--target")];
// Reject incompatible target overrides before generation or any compilation.
const targetValues = Object.fromEntries(targets.map(target => [target ?? "current", resolveBuildOptions(profile, overrides, target ?? primaryTarget)]));
let privateTerms: string[] = [];
if (options.has("--forbidden-terms")) {
  const file = realpathSync(resolve(root, options.get("--forbidden-terms")!)), rel = relative(realpathSync(root), file);
  if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)) throw new Error("La liste privée des termes interdits doit rester hors du dépôt.");
  privateTerms = readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
} else console.error("Liste privée de termes non fournie : contrôle limité aux marqueurs d’options et à l’identité.");

async function step(name: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) { console.error(`Build interrompu à l’étape « ${name} ».`); process.exit(1); }
}
const passthrough = [...options].filter(([name]) => ["--identity", "--models", "--profile", "--build-options"].includes(name)).flat();
let generatedIdentity: Buffer | undefined;
async function generate(target: string): Promise<void> {
  await step("identité et constantes", [process.execPath, "--no-env-file", "scripts/generate.ts", ...passthrough, "--target", target]);
  // Read the output, not a cached module import, after every target generation.
  const flags = readFileSync(join(root, "src/identity/generated/build-flags.ts"), "utf8");
  const constant = (name: string): unknown => {
    const value = new RegExp(`^export const ${name} = (.*?)(?: as const)?;$`, "m").exec(flags)?.[1];
    if (value === undefined) throw new Error("Constantes de build générées invalides.");
    return JSON.parse(value);
  };
  if (constant("BUILD_PROFILE") !== profile || constant("BUILD_TARGET") !== target || JSON.stringify(constant("BUILD_VALUES")) !== JSON.stringify(resolveBuildOptions(profile, overrides, target))) throw new Error("Options de build changées pendant la génération.");
  const identity = readFileSync(join(root, "src/identity/generated/build-data.ts"));
  if (generatedIdentity && !generatedIdentity.equals(identity)) throw new Error("Identité ou catalogue de modèles changé pendant la génération.");
  generatedIdentity ??= identity;
}
await generate(primaryTarget);
await step("vérification des types", [process.execPath, "x", "--no-install", "--bun", "tsc", "--noEmit", "-p", "."]);
await step("contrôles statiques", [process.execPath, "scripts/check-static.ts"]);
const { RESOLVED_IDENTITY, SOURCE_IDENTITY_HASH } = await import("../src/identity/generated/build-data");
const { BUILD_PROFILE, BUILD_TARGET, BUILD_VALUES } = await import("../src/identity/generated/build-flags");
if (BUILD_PROFILE !== profile || BUILD_TARGET !== primaryTarget || Object.entries(values).some(([name, value]) => BUILD_VALUES[name as keyof typeof BUILD_VALUES] !== value)) throw new Error("Options de build changées pendant la génération.");
const identityFile = resolve(root, options.get("--identity") ?? "identity/dev.identity.json");
const original = resolveIdentityText(readFileSync(identityFile, "utf8"), { version: RESOLVED_IDENTITY.version, strict: true }).identity;
if (!original || original.hash !== SOURCE_IDENTITY_HASH || runtimeIdentity(original).hash !== RESOLVED_IDENTITY.hash) throw new Error("Identité changée pendant la construction.");
// SPEC-CAD-002 EF-04 / ERR-10: the brand icon (or the neutral default) is checked before any deliverable is written.
const brandIcon = loadIcon(original, identityFile);
if (!brandIcon.icon) throw new Error(`[ERR-10] ${brandIcon.issues.map((issue) => issue.message).join(" ")}`);
const cli = RESOLVED_IDENTITY.values["PRODUCT_CLI"]!.value as string;
checkOutput();
rmSync(outDir, { recursive: true, force: true }); mkdirSync(outDir, { recursive: true });
const mandatoryTerms = [...privateTerms, ...Object.entries(BUILD_OPTIONS).filter(([name]) => !values[name as keyof typeof values]).flatMap(([, definition]) => definition.absentMarkers)];
const normalize = (term: string) => term.normalize("NFD").replace(/\p{M}/gu, "").toUpperCase().replace(/[_\-\s]/gu, "");
const mandatoryKeys = new Set(mandatoryTerms.map(normalize));
const forbiddenTerms = [...new Set([...original.compatibility.forbiddenTerms, ...mandatoryTerms])];
const scanExceptions = original.compatibility.scanExceptions?.filter((e) => !mandatoryKeys.has(normalize(e.terme)));
const scanIdentity = new Identity({ ...original, compatibility: { ...original.compatibility, forbiddenTerms, scanExceptions } });
const manifest: Array<{ target: string; file: string; sha256: string }> = [];
const scanCache: ScanCache = new Map();
function control(extraFiles: string[] = []): void {
  const issues = scanDirectory(outDir, scanIdentity, scanCache);
  for (const issue of issues) console.error(`Chaîne interdite « ${issue.term} » : ${issue.file}:${issue.line}:${issue.column}.`);
  if (issues.length) throw new Error("Contrôle anti-fuite refusé.");
  for (const file of [...manifest.map((d) => d.file), ...extraFiles]) {
    const leak = /\{\{\s*([A-Z][A-Z0-9_]*)\s*(\|\s*[a-z]+\s*)*\}\}/.exec(readFileSync(join(outDir, file)).toString("latin1"));
    if (leak) {
      const name = leak[1]!, unknown = !VARIABLE_BY_NAME.has(name), near = unknown ? suggest(name.slice(0, 256), VARIABLE_BY_NAME.keys(), 256)[0] : undefined;
      throw new Error(`[ERR-06] Variable ${unknown ? "inconnue" : "non résolue"} dans ${file} : ${leak[0].slice(0, 300)}.${near ? ` Vouliez-vous dire ${near} ?` : " Vérifiez l'injection des ressources."}`);
    }
  }
}
const record = (target: string, file: string) => manifest.push({ target, file, sha256: createHash("sha256").update(readFileSync(join(outDir, file))).digest("hex") });
const bundleName = `${cli}.js`;
async function bundle(file: string): Promise<void> {
  const before = new Set(readdirSync(outDir));
  // Each target needs a fresh macro process; cached imports would reuse the first target's constants.
  // Let the compiler emit assets so the single-file check can report its precise refusal.
  await step("regroupement", [process.execPath, "--no-env-file", "build", join(root, "src/main.ts"), "--target=bun", "--format=esm", "--minify", "--outdir", outDir, "--entry-naming", file]);
  if (!existsSync(join(outDir, file)) || readdirSync(outDir).some(name => !before.has(name) && name !== file)) throw new Error("Ressource externe non embarquée : construction refusée.");
  control([file]);
}
await bundle(bundleName);
record("bundle", bundleName); control();
for (const target of targets) {
  const effectiveTarget = target ?? primaryTarget;
  const temporaryBundle = effectiveTarget !== primaryTarget ? `${cli}-${effectiveTarget}.js` : undefined;
  if (temporaryBundle) { await generate(effectiveTarget); await bundle(temporaryBundle); }
  const name = target ? `${cli}-${target.replace(/^bun-/, "")}` : cli;
  const file = target?.includes("windows") || (!target && process.platform === "win32") ? `${name}.exe` : name;
  await step(`compilation ${target ?? "plateforme courante"}`, [process.execPath, "--no-env-file", "build", join(outDir, temporaryBundle ?? bundleName), "--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--minify", "--outfile", join(outDir, file), ...(target ? [`--target=${target}`] : [])]);
  if (temporaryBundle) unlinkSync(join(outDir, temporaryBundle));
  record(target ?? "current", file); control();
}
if (all) await generate(primaryTarget);
publishSettingsSchema(root, outDir, { cli, version: RESOLVED_IDENTITY.version }); record("settings-schema", "config.schema.json");
writeFileSync(join(outDir, "package.json"), readFileSync(join(root, "src/identity/generated/package.json"))); record("package-manifest", "package.json");
writeFileSync(join(outDir, "extension-authors.html"), readFileSync(join(root, "src/identity/generated/extension-authors.html"))); record("extension-documentation", "extension-authors.html");
for (const [name, shell] of [["install.ps1", "powershell"], ["install.sh", "sh"]] as const) {
  writeFileSync(join(outDir, name), bootstrapScript(new Identity(RESOLVED_IDENTITY), shell)); record("installer", name);
}
const inventory = Object.fromEntries(Object.entries(BUILD_OPTIONS).map(([name, definition]) => [name, { enabled: values[name as keyof typeof values], description: definition.description, specs: definition.specs }]));
// Supports: SPEC-CAD-002 (CA-11, FA-04); the official catalogue remains unavailable in this version.
const disabledFeatures = [{ service: "SERVICE_MARKETPLACE", feature: "Catalogue officiel d'extensions", reason: RESOLVED_IDENTITY.values["SERVICE_MARKETPLACE"] ? "fonction non livrée" : "service non configuré" }];
writeFileSync(join(outDir, "build-options.json"), JSON.stringify({ profile, options: inventory, disabledFeatures }, null, 2) + "\n"); record("build-options", "build-options.json"); control();
const iconName = `icon.${brandIcon.icon.format}`;
writeFileSync(join(outDir, iconName), brandIcon.icon.data); record("brand-icon", iconName); control();
const git = Bun.spawn(["git", "rev-parse", "HEAD"], { cwd: root, stdout: "pipe", stderr: "ignore" });
const commitText = (await new Response(git.stdout).text()).trim(), commit = await git.exited === 0 && /^[a-f0-9]{40}$/.test(commitText) ? commitText : null;
const receipt = join(outDir, "manifest.json");
writeFileSync(receipt, JSON.stringify({ identity: RESOLVED_IDENTITY.hash, version: RESOLVED_IDENTITY.version, source: { commit, identity: SOURCE_IDENTITY_HASH }, build: { profile, target: primaryTarget, options: values, targets: targetValues, disabledFeatures, privateTermsLoaded: options.has("--forbidden-terms") }, deliverables: manifest }, null, 2) + "\n");
try {
  control();
  for (const d of manifest) if (createHash("sha256").update(readFileSync(join(outDir, d.file))).digest("hex") !== d.sha256) throw new Error(`Livrable modifié pendant la construction : ${d.file}.`);
} catch (error) { unlinkSync(receipt); throw error; }
console.error(`Livrables contrôlés : ${manifest.map((m) => m.file).join(", ")}`);
