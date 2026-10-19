// Compile a small real-module probe using exact build-resolver values in a private copy.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { resolveBuildOptions } from "../../src/extension-points/build-options";
export async function capabilityProbe(file: string, overrides: Record<string, boolean>, profile: "public" | "internal" = "public") {
  const repository = resolve(import.meta.dir, "../.."), base = join(repository, "build", "activation-canonical-b", "probes"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "profile-"));
  for (const folder of ["src", "prompts"]) cpSync(join(repository, folder), join(root, folder), { recursive: true });
  mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
  const entry = join(root, "tests", "fixtures", basename(file)); cpSync(file, entry);
  cpSync(join(repository, "tsconfig.json"), join(root, "tsconfig.json"));
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, "src", "identity", "generated", "build-flags.ts"), "export const BUILD_PROFILE = " + JSON.stringify(profile) + ";\nexport const BUILD_VALUES = " + JSON.stringify(resolveBuildOptions(profile, overrides)) + " as const;\n");
  const result = await Bun.build({ entrypoints: [entry], target: "bun", minify: true, outdir: root, naming: "probe.js" });
  if (!result.success) throw Error(result.logs.join("\n"));
  const environment: Record<string, string> = { HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root };
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) if (process.env[name]) environment[name] = process.env[name]!;
  const run = Bun.spawnSync([process.execPath, "--no-env-file", join(root, "probe.js")], { cwd: root, env: environment, timeout: 20000 });
  const stdout = run.stdout.toString(), stderr = run.stderr.toString(); writeFileSync(join(root, "observations.json"), JSON.stringify({ profile, overrides, code: run.exitCode, stdout, stderr }, null, 2));
  if (run.exitCode !== 0) throw Error(stderr + stdout);
  return { root, source: readFileSync(join(root, "probe.js"), "utf8"), data: JSON.parse(stdout.trim()) as Record<string, unknown> };
}
