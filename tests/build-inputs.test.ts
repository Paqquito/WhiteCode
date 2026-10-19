import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runToCompletion } from "../src/platform/process";

test("TECH — an options file changed before a secondary target generation refuses the actual build without a manifest", async () => {
  const source = resolve(import.meta.dir, ".."), root = join(source, "build", `build-input-race-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  for (const name of ["src", "scripts", "identity", "prompts", "docs"]) cpSync(join(source, name), join(root, name), { recursive: true });
  for (const name of ["package.json", "tsconfig.json", "bun.lock"]) cpSync(join(source, name), join(root, name));
  symlinkSync(realpathSync(join(source, "node_modules")), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const options = join(root, "options.json"); writeFileSync(options, JSON.stringify({ project_init_v2: false }));
  const generator = join(root, "scripts/generate.ts"), original = readFileSync(generator, "utf8"), needle = "const options = resolveBuildOptions";
  expect(original.split(needle)).toHaveLength(2);
  writeFileSync(generator, original.replace(needle, 'const countFile = join(root, "generation-count.txt"); let count = 0; try { count = Number(readFileSync(countFile, "utf8")); } catch {} writeFileSync(countFile, String(++count)); if (count === 2) writeFileSync(resolve(root, optionsFile), JSON.stringify({project_init_v2:true}));\n' + needle));
  // Bound the fixture's target list only; generation, bundling, checks and compilation use the real script.
  const builder = join(root, "scripts/build.ts"), before = readFileSync(builder, "utf8"), targetNeedle = "const TARGETS: readonly string[] = BUILD_TARGETS;";
  expect(before.split(targetNeedle)).toHaveLength(2);
  writeFileSync(builder, before.replace(targetNeedle, 'const TARGETS: readonly string[] = [hostBuildTarget(), hostBuildTarget().endsWith("-musl") ? "bun-linux-x64" : "bun-linux-x64-musl"];'));
  const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!])) as Record<string, string>;
  const result = await runToCompletion(process.execPath, ["--no-env-file", "scripts/build.ts", "--all", "--build-options", options], { cwd: root, env, timeoutMs: 120000 });
  writeFileSync(join(root, "result.json"), JSON.stringify(result));
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("Options de build changées pendant la génération");
  expect(readFileSync(join(root, "generation-count.txt"), "utf8")).toBe("2");
  expect(existsSync(join(root, "dist/manifest.json"))).toBe(false);
}, 150000);
