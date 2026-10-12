// Implements: SPEC-BLD-006 (§ 5.1 static analysis rules, EF-02), SPEC-CAD-002 (RG-02 no brand value in the code), rule 4 (traceability headers)
// Usage: bun scripts/check-static.ts [--forbidden-terms <private file>]   (the list stays outside the repository, decision E-015)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveIdentityText } from "../src/identity/resolver";
import { specIndex as specs } from "./spec-index";
import { BUILD_OPTIONS } from "../src/extension-points/build-options";

const root = join(import.meta.dir, "..");
const problems: string[] = [];
const rel = (p: string) => relative(root, p).split("\\").join("/");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const sources = walk(join(root, "src")).filter((p) => p.endsWith(".ts") && !rel(p).startsWith("src/identity/generated/"));
const buildReads = new Set<string>();

for (const file of sources) {
  const text = readFileSync(file, "utf8");
  const r = rel(file);
  if (r !== "src/extension-points/build-flags.ts") {
    if (/\bbuildFlag\s+as\b/.test(text)) problems.push(`${r}: buildFlag must keep its canonical import name`);
    if (/\bbuildFlag\s*\(/.test(text) && !/import\s*\{[^}]*\bbuildFlag\b[^}]*\}\s*from\s*["'][^"']*\/build-flags["']\s*with\s*\{\s*type\s*:\s*["']macro["']\s*\}/.test(text)) problems.push(`${r}: buildFlag requires a macro import`);
    for (const call of text.matchAll(/\bbuildFlag\s*\(([^)]*)\)/g)) {
      const literal = /^\s*["']([a-z][a-z0-9_]*)["']\s*$/.exec(call[1]!);
      if (!literal || !Object.hasOwn(BUILD_OPTIONS, literal[1]!)) problems.push(`${r}: buildFlag requires a known literal name`);
      else buildReads.add(literal[1]!);
    }
  }
  // Rule 4: every module states the sheets it implements or supports.
  if (!/^\/\/ (Implements|Supports): /.test(text)) problems.push(`${r}: missing "// Implements:" or "// Supports:" header`);
  for (const m of text.matchAll(/SPEC-[A-Z]{3}-\d{3}/g)) {
    const sheet = specs.get(m[0]);
    if (!sheet) problems.push(`${r}: unknown sheet ${m[0]}`);
    else if (sheet.obsolete) problems.push(`${r}: obsolete sheet cited ${m[0]}`);
  }
  // P-07 and SPEC-BLD-006: environment, process exit and runtime-specific APIs are confined.
  if (/process\.env/.test(text) && r !== "src/platform/environment.ts") problems.push(`${r}: process.env outside src/platform/environment.ts`);
  if (/process\.exit\(/.test(text) && r !== "src/platform/io.ts") problems.push(`${r}: process.exit outside src/platform/io.ts`);
  if (/\bBun\./.test(text) && !r.startsWith("src/platform/")) problems.push(`${r}: runtime-specific API outside src/platform/`);
  if (/from "\.\.\/platform\/environment"|from "\.\.\/\.\.\/platform\/environment"/.test(text) && !r.startsWith("src/config/") && r !== "src/main.ts") {
    problems.push(`${r}: only the config module reads the process environment`);
  }
}

// RG-02: no value of the build identities may appear in the code or in the model texts.
const brandFiles = [...sources, ...walk(join(root, "prompts"))];
for (const idFile of ["identity/dev.identity.json", "identity/test-omega.identity.json"]) {
  const identity = resolveIdentityText(readFileSync(join(root, idFile), "utf8"), { version: "0.0.0" }).identity;
  if (!identity) {
    problems.push(`${idFile}: invalid identity`);
    continue;
  }
  const values = new Set<string>();
  for (const name of ["SOCIETY", "PRODUCT", "SOCIETY_DOMAIN", "PRODUCT_SLUG", "PRODUCT_CLI", "ENV_PREFIX", "SOCIETY_SLUG"]) {
    const v = identity.values[name]?.value;
    for (const s of typeof v === "string" ? [v] : Object.values(v ?? {})) if (s.length >= 4) values.add(s.toLowerCase());
  }
  for (const file of brandFiles) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const v of values) if (text.includes(v)) problems.push(`${rel(file)}: identity value "${v}" hard-coded (${idFile})`);
  }
}

// Forbidden terms, from a private file given as an argument (E-015).
const i = process.argv.indexOf("--forbidden-terms");
if (i >= 0 && process.argv[i + 1]) {
  const terms = readFileSync(process.argv[i + 1]!, "utf8").split(/\r?\n/).map((t) => t.trim().toLowerCase()).filter((t) => t && !t.startsWith("#"));
  for (const file of [...brandFiles, ...walk(join(root, "docs"))]) {
    const text = readFileSync(file, "utf8").toLowerCase();
    for (const t of terms) if (text.includes(t)) problems.push(`${rel(file)}: forbidden term found`);
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`${problems.length} problem(s).`);
  process.exit(1);
}
const unusedBuildOptions = Object.keys(BUILD_OPTIONS).filter((name) => !buildReads.has(name));
if (unusedBuildOptions.length) console.error(`Options de build sans lecture dans cette version : ${unusedBuildOptions.join(", ")}.`);
console.error(`Static checks passed (${sources.length} modules).`);
