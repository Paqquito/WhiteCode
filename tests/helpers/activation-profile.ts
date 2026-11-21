// A source profile copy that never imports run.ts or evaluates macros in the calling checkout.
import { cpSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { BuildProfile } from "../../src/extension-points/build-options";
const root = resolve(import.meta.dir, "../.."), copies = new Map<string, {root: string; environment: Record<string, string>}>();
export function activationProfile(profile: BuildProfile, overrides: Record<string, boolean> = {}) {
  const key = profile + JSON.stringify(overrides), previous = copies.get(key); if (previous) return previous;
  const parent = join(root, "build/activation-thirty-one63/profiles"); mkdirSync(parent, {recursive: true});
  const copy = mkdtempSync(join(parent, profile + "-"));
  for (const directory of ["src", "scripts", "docs", "prompts", "identity", "tests"]) cpSync(join(root, directory), join(copy, directory), {recursive: true});
  for (const file of ["package.json", "tsconfig.json", "bun.lock", "LICENSE", "THIRD_PARTY_NOTICES.txt"]) cpSync(join(root, file), join(copy, file));
  symlinkSync(realpathSync(join(root, "node_modules")), join(copy, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const environment = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "PATHEXT", "COMSPEC"].flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]!]]));
  const options = join(copy, "build-options.json"); writeFileSync(options, JSON.stringify(overrides));
  const generated = spawnSync(process.execPath, ["--no-env-file", "scripts/generate.ts", "--profile", profile, "--build-options", options], {cwd: copy, env: environment, encoding: "utf8", windowsHide: true, timeout: 15000});
  if (generated.status !== 0) throw Error(generated.stderr || String(generated.error));
  const fixture = {root: copy, environment}; copies.set(key, fixture); return fixture;
}
