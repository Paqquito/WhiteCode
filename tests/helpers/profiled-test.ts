// Re-executes the unchanged scenario in a real isolated build profile; no environment can override a macro.
// Supports: SPEC-BLD-007 (profile validation preserves the unchanged inner scenario timeout), gap E-326.
import { beforeAll, test as bunTest } from "bun:test";
import { cpSync, mkdirSync, realpathSync, symlinkSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { buildProfile } from "../../src/extension-points/build-flags" with { type: "macro" };
import { ROOT, workspace } from "./env";
import { BUN, productEnv } from "./hooks";
import { runToCompletion } from "../../src/platform/process";

const profiles = new Map<string, string>();
export function profileFixture(profile: "public" | "internal" | "test", overrides: Record<string, boolean> = {}): { root: string; environment: Record<string, string> } {
  const key = profile + JSON.stringify(overrides), previous = profiles.get(key), ws = workspace(), environment = productEnv(ws);
  if (previous) return { root: previous, environment };
  const root = join(ROOT, "build", "activation-probe-" + process.pid + "-" + crypto.randomUUID()); mkdirSync(root, { recursive: true });
  for (const name of ["src", "scripts", "docs", "prompts", "identity", "tests"]) cpSync(join(ROOT, name), join(root, name), { recursive: true });
  for (const name of ["package.json", "tsconfig.json", "bun.lock"]) cpSync(join(ROOT, name), join(root, name));
  symlinkSync(realpathSync(process.env["WC_BUILD_TEST_DEPENDENCIES"] ?? join(ROOT, "node_modules")), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const options = join(root, "build-options.json"); writeFileSync(options, JSON.stringify(overrides));
  const generated = runToCompletion(BUN, ["--no-env-file", "scripts/generate.ts", "--profile", profile, "--build-options", options], { cwd: root, env: environment, timeoutMs: 15000 });
  if (generated.code !== 0) throw Error(generated.stderr + generated.stdout);
  profiles.set(key, root); return { root, environment };
}
export function compileProfileProbe(profile: "public" | "internal" | "test", file: string, overrides: Record<string, boolean> = {}) {
  const f = profileFixture(profile, overrides), entry = join(f.root, relative(ROOT, file)), output = join(f.root, "tests", "compiled", basename(file).replace(/\.ts$/, ".js"));
  mkdirSync(dirname(output), { recursive: true });
  const built = runToCompletion(BUN, ["--no-env-file", "build", entry, "--target=bun", "--minify", "--external=bun:test", "--outfile", output], { cwd: f.root, env: f.environment, timeoutMs: 25000 });
  if (built.code !== 0) throw Error(built.stderr + built.stdout);
  const source = readFileSync(output, "utf8").replace(/\\x([a-f0-9]{2})|\\u([a-f0-9]{4})/gi, (_match, hex, unicode) => String.fromCharCode(parseInt(hex ?? unicode, 16)));
  return { ...f, output, source };
}
export function profiledTest(file: string, profile: "public" | "internal" | "test" = "test") {
  let compiled: ReturnType<typeof compileProfileProbe> | undefined, setup = false;
  const register = (name: string, body: () => unknown | Promise<unknown>, timeout?: number) => {
    const inProfile = buildProfile() === profile;
    const outerTimeout = inProfile ? timeout : (timeout ?? 5000) + 5000;
    if (!setup && file.endsWith(".ts") && buildProfile() !== profile) {
      setup = true;
      // Building the fixture is setup; every scenario keeps its original execution timeout below.
      beforeAll(() => { compiled = compileProfileProbe(profile, file); }, 30000);
    }
    return bunTest(name, async () => {
    if (buildProfile() === profile) { await body(); return; }
    if (!compiled) throw Error("Profiled fixture was not compiled.");
    const pattern = "^" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
    const result = runToCompletion(BUN, ["--no-env-file", "test", compiled.output, "--test-name-pattern", pattern], { cwd: compiled.root, env: compiled.environment, timeoutMs: outerTimeout! });
    const proof = { profile, file: relative(ROOT, file), name, code: result.code, stdout: result.stdout, stderr: result.stderr };
    writeFileSync(join(dirname(compiled.output), "verdict-" + crypto.randomUUID() + ".json"), JSON.stringify(proof, null, 2));
    const output = result.stderr + result.stdout;
    if (result.code !== 0 || !/^\s*1 pass\s*$/m.test(output) || !/^\s*0 fail\s*$/m.test(output) || !output.includes("(pass) " + name)) throw Error("Profiled scenario failed: " + JSON.stringify(proof));
  }, outerTimeout);
  };
  register.skipIf = (condition: boolean) => condition ? bunTest.skip : register;
  return register;
}
