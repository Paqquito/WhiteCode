// Implements: SPEC-BLD-001 (§ 5.1 steps 1 to 6, EF-03 stop at the first failing check, EF-04 fingerprint of each deliverable), SPEC-CAD-002 (EF-30 minimal leak control)
// Usage: bun scripts/build.ts [--target bun-<os>-<arch>[-musl] | --all] [--identity <file>] [--models <file>]

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { publishSettingsSchema } from "./settings-schema";

const root = join(import.meta.dir, "..");
const TARGETS = ["bun-windows-x64", "bun-windows-arm64", "bun-linux-x64", "bun-linux-arm64", "bun-linux-x64-musl", "bun-linux-arm64-musl", "bun-darwin-x64", "bun-darwin-arm64"];

async function step(name: string, cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) {
    console.error(`Build interrompu à l'étape « ${name} ».`);
    process.exit(1);
  }
}

const passthrough = ["--identity", "--models"].flatMap((o) => {
  const i = process.argv.indexOf(o);
  return i >= 0 && process.argv[i + 1] ? [o, process.argv[i + 1]!] : [];
});
await step("identité et constantes", ["bun", "scripts/generate.ts", ...passthrough]);
await step("vérification des types", ["bunx", "tsc", "--noEmit", "-p", "."]);
await step("contrôles statiques", ["bun", "scripts/check-static.ts"]);

// The generated identity is read once the first step has written it: a fresh checkout has none yet.
const { RESOLVED_IDENTITY } = await import("../src/identity/generated/build-data");
const cli = (RESOLVED_IDENTITY.values["PRODUCT_CLI"]?.value as string) ?? "cli";
const ti = process.argv.indexOf("--target");
const targets = process.argv.includes("--all") ? TARGETS : ti >= 0 ? [process.argv[ti + 1]!] : [undefined];
const outDir = join(root, "dist");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
const manifest: Array<{ target: string; file: string; sha256: string }> = [];

for (const target of targets) {
  const name = target ? `${cli}-${target.replace(/^bun-/, "")}` : cli;
  const outfile = join(outDir, target?.includes("windows") || (!target && process.platform === "win32") ? `${name}.exe` : name);
  const cmd = ["bun", "build", "src/main.ts", "--compile", "--minify", "--outfile", outfile, ...(target ? [`--target=${target}`] : [])];
  await step(`compilation ${target ?? "plateforme courante"}`, cmd);
  const bytes = readFileSync(outfile);
  // EF-30: no unresolved variable may remain in a deliverable.
  const leak = /\{\{[A-Z][A-Z0-9_]*(\|[a-z]+)*\}\}/.exec(bytes.toString("latin1"));
  if (leak) {
    console.error(`Variable non résolue dans ${outfile} : ${leak[0]}.`);
    process.exit(1);
  }
  manifest.push({ target: target ?? "current", file: outfile.slice(outDir.length + 1), sha256: createHash("sha256").update(bytes).digest("hex") });
}
const editorSchema = publishSettingsSchema(root, outDir, { cli, version: RESOLVED_IDENTITY.version });
const schemaBytes = readFileSync(editorSchema.file);
if (/\{\{[A-Z][A-Z0-9_]*(\|[a-z]+)*\}\}/.test(schemaBytes.toString("utf8"))) {
  console.error("Variable non résolue dans le schéma des paramètres.");
  process.exit(1);
}
manifest.push({ target: "settings-schema", file: "config.schema.json", sha256: createHash("sha256").update(schemaBytes).digest("hex") });
writeFileSync(join(outDir, "manifest.json"), `${JSON.stringify({ identity: RESOLVED_IDENTITY.hash, version: RESOLVED_IDENTITY.version, deliverables: manifest }, null, 2)}\n`);
console.error(`Livrables : ${manifest.map((m) => m.file).join(", ")}`);
