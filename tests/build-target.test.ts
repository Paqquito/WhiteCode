import { expect, test } from "bun:test";
import { BUILD_TARGETS, libcBuildValues } from "../src/platform/build-target";
import { BUILD_PROFILES, resolveBuildOptions } from "../src/extension-points/build-options";
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { runToCompletion } from "../src/platform/process";

test("TECH — each cross-compilation target has its own mutually exclusive libc constants", () => {
  for (const target of BUILD_TARGETS) {
    const flags = libcBuildValues(target);
    expect(flags.libc_variant_musl).toBe(target.includes("linux") && target.endsWith("-musl"));
    expect(flags.libc_variant_glibc).toBe(target.includes("linux") && !target.endsWith("-musl"));
    expect(Number(flags.libc_variant_musl) + Number(flags.libc_variant_glibc)).toBe(target.includes("linux") ? 1 : 0);
  }
  expect(() => libcBuildValues("bun-linux-x64-unknown")).toThrow("Cible de build invalide");
  expect(() => libcBuildValues("bun-linux-x64-musl ")).toThrow("Cible de build invalide");
});

test("TECH — fresh macro processes embed each target's actual libc constants and installation diagnostic", async () => {
  const source = resolve(import.meta.dir, ".."), root = join(source, "build", `libc-target-${randomUUID()}`);
  mkdirSync(root, { recursive: true });
  for (const name of ["src", "scripts", "identity", "prompts", "docs"]) cpSync(join(source, name), join(root, name), { recursive: true });
  for (const name of ["package.json", "tsconfig.json", "bun.lock", "LICENSE", "THIRD_PARTY_NOTICES.txt"]) cpSync(join(source, name), join(root, name));
  symlinkSync(realpathSync(join(source, "node_modules")), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const env = Object.fromEntries(["PATH", "Path", "SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]!])) as Record<string, string>;
  writeFileSync(join(root, "probe.ts"), 'import { buildInventory } from "./src/extension-points/build-flags" with { type: "macro" }; import { nativeTarget } from "./src/installation/runtime"; console.log(JSON.stringify({ flags: buildInventory(), linux: nativeTarget({platform:"linux",arch:"x64",release:"",home:"",tmp:""}) }));\n');
  for (const target of BUILD_TARGETS) {
    for (const args of [["scripts/generate.ts", "--target", target], ["build", "probe.ts", "--target=bun", "--minify", "--outfile", "probe.js"]]) {
      const result = await runToCompletion(process.execPath, ["--no-env-file", ...args], { cwd: root, env, timeoutMs: 15000 });
      if (result.code !== 0) throw new Error(result.stderr + result.stdout);
      expect(result.code).toBe(0);
    }
    const result = await runToCompletion(process.execPath, ["--no-env-file", "probe.js"], { cwd: root, env, timeoutMs: 10000 });
    expect(result.code).toBe(0);
    const actual = JSON.parse(result.stdout) as { flags: Record<string, boolean>; linux: string }, expected = libcBuildValues(target);
    expect(actual.flags.libc_variant_musl).toBe(expected.libc_variant_musl);
    expect(actual.flags.libc_variant_glibc).toBe(expected.libc_variant_glibc);
    if (target.includes("linux")) expect(actual.linux).toBe(`linux-x64-${target.endsWith("-musl") ? "musl" : "glibc"}`);
    expect(readFileSync(join(root, "src/identity/generated/build-flags.ts"), "utf8")).toContain(`BUILD_TARGET = "${target}"`);
  }
}, 60000);

test("TECH — libc flags follow the target in every profile and contradictory overrides fail before generation", () => {
  for (const profile of BUILD_PROFILES) for (const target of BUILD_TARGETS) {
    const expected = libcBuildValues(target), values = resolveBuildOptions(profile, {}, target);
    expect(values.libc_variant_musl).toBe(expected.libc_variant_musl);
    expect(values.libc_variant_glibc).toBe(expected.libc_variant_glibc);
    expect(resolveBuildOptions(profile, expected, target)).toEqual(values);
    expect(() => resolveBuildOptions(profile, { libc_variant_musl: !expected.libc_variant_musl }, target)).toThrow();
    expect(() => resolveBuildOptions(profile, { libc_variant_glibc: !expected.libc_variant_glibc }, target)).toThrow();
  }
});
