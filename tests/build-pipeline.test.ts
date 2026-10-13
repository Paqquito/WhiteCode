import { expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { runToCompletion } from "../src/platform/process";
import { loadIdentity, ROOT, workspace } from "./helpers/env";
import { BUN, productEnv } from "./helpers/hooks";
import { resolveIdentityText, runtimeIdentity } from "../src/identity/resolver";

/** Builds execute in an ordinary isolated copy; no generation or deletion touches the calling checkout. */
function fixture() {
  const root = join(ROOT, "build", `pipeline-${process.pid}-${crypto.randomUUID()}`);
  const rel = relative(join(ROOT, "build"), resolve(root));
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Fixture path outside build");
  mkdirSync(root, { recursive: true });
  for (const name of ["src", "scripts", "docs", "prompts", "identity"]) cpSync(join(ROOT, name), join(root, name), { recursive: true });
  for (const name of ["package.json", "tsconfig.json", "bun.lock"]) cpSync(join(ROOT, name), join(root, name));
  // Cross-platform local probes can use dependencies installed from the same frozen lock in an isolated cache.
  symlinkSync(realpathSync(process.env["WC_BUILD_TEST_DEPENDENCIES"] ?? join(ROOT, "node_modules")), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const ws = workspace();
  const build = (args: string[] = []) => {
    const target = resolve(root, "dist");
    if (target !== join(root, "dist") || (existsSync(target) && lstatSync(target).isSymbolicLink())) throw new Error("Unsafe build output");
    return runToCompletion(BUN, [join(root, "scripts/build.ts"), ...args], { cwd: root, env: productEnv(ws), timeoutMs: 120_000 });
  };
  const manifest = () => JSON.parse(readFileSync(join(root, "dist/manifest.json"), "utf8"));
  const run = (file: string, args: string[]) => runToCompletion(join(root, "dist", file), args, { cwd: ws.project, env: productEnv(ws), timeoutMs: 10_000 });
  return { root, ws, build, manifest, run };
}

test("SPEC-CAD-002/CA-10 — an unknown variable in a product resource rejects the actual strict build with ERR-06 and a spelling suggestion", async () => {
  const f = fixture(), entry = join(f.root, "src/main.ts");
  writeFileSync(join(f.root, "unknown-template.txt"), "{{PRODCT}}");
  writeFileSync(entry, readFileSync(entry, "utf8") + '\nimport resource from "../unknown-template.txt" with { type: "text" }; console.log(resource);\n');
  const result = await f.build();
  expect(result.code).not.toBe(0);
  expect(result.stderr).toContain("ERR-06");
  expect(result.stderr).toContain("PRODUCT");
  expect(existsSync(join(f.root, "dist/manifest.json"))).toBe(false);
  writeFileSync(join(f.root, "unknown-template.txt"), "{{MISSING_VAR}}");
  const distant = await f.build();
  expect(distant.code).not.toBe(0);
  expect(distant.stderr).toContain("Variable inconnue");
  expect(distant.stderr).toContain("Vouliez-vous dire");
  expect(existsSync(join(f.root, "dist/manifest.json"))).toBe(false);
}, 150_000);

test("SPEC-CAD-002/CA-11 — without a marketplace service, the built executable hides the official catalogue and its build report lists the disabled feature", async () => {
  const f = fixture();
  expect(loadIdentity().has("SERVICE_MARKETPLACE")).toBe(false);
  expect((await f.build()).code).toBe(0);
  const report = f.manifest();
  expect(report.build.disabledFeatures).toContainEqual({ service: "SERVICE_MARKETPLACE", feature: "Catalogue officiel d'extensions", reason: "service non configuré" });
  const binary = report.deliverables.find((d: { target: string }) => d.target === "current").file;
  const output = await f.run(binary, ["--help"]);
  expect(output.code).toBe(0);
  expect(output.stdout).not.toMatch(/catalogue officiel|official.catalog|marketplace/i);
}, 150_000);

test("SPEC-BLD-001/CA-01, SPEC-BLD-003/CA-02, SPEC-BLD-007/CA-02 — two stable builds and two actual identities: fingerprints match and a new name replaces the original in executable output", async () => {
  const f = fixture();
  const first = await f.build(["--identity", "identity/test-omega.identity.json"]);
  expect(first.code).toBe(0);
  const before = f.manifest();
  expect(before.deliverables.some((d: { target: string }) => d.target === "bundle")).toBe(true);
  for (const d of before.deliverables) expect(createHash("sha256").update(readFileSync(join(f.root, "dist", d.file))).digest("hex")).toBe(d.sha256);
  expect((await f.build(["--identity", "identity/test-omega.identity.json"])).code).toBe(0);
  expect(f.manifest().deliverables).toEqual(before.deliverables);
  const binary = before.deliverables.find((d: { target: string }) => d.target === "current").file;
  const omega = loadIdentity("identity/test-omega.identity.json"), original = loadIdentity();
  for (const args of [["--version"], ["--help"]]) {
    const output = await f.run(binary, args);
    expect(output.code).toBe(0); expect(output.stdout).toContain(omega.get("PRODUCT")); expect(output.stdout).not.toContain(original.get("PRODUCT")); expect(output.stdout).not.toContain(original.get("SOCIETY"));
  }
  expect((await f.build()).code).toBe(0);
  const dev = f.manifest().deliverables.find((d: { target: string }) => d.target === "current").file;
  expect((await f.run(dev, ["--version"])).stdout).toContain(original.get("PRODUCT"));
  expect((await f.build(["--profile", "unknown_test_profile"])).code).not.toBe(0);
  expect(existsSync(join(f.root, "dist/manifest.json"))).toBe(false);
}, 240_000);

test("SPEC-BLD-002/CA-01 — disabled automatic approval: classifier code and its prompt are absent from the product bundle and executable", async () => {
  const f = fixture(), options = f.ws.write("options.json", JSON.stringify({ permission_auto_approve: false, agent_explorer_planner: false, agent_verifier: false, stream_compact_profile: false }));
  const result = await f.build(["--build-options", options]);
  expect(result.code).toBe(0);
  const manifest = f.manifest();
  expect(manifest.build.options.permission_auto_approve).toBe(false);
  expect(manifest.build.options.agent_explorer_planner).toBe(false);
  expect(manifest.build.options.agent_verifier).toBe(false);
  expect(manifest.build.options.stream_compact_profile).toBe(false);
  for (const d of manifest.deliverables.filter((d: { target: string }) => ["bundle", "current"].includes(d.target))) {
    const contents = readFileSync(join(f.root, "dist", d.file)).toString("latin1");
    expect(contents).not.toContain("You are the approval classifier for a coding session");
    expect(contents).not.toContain("The complete action is too large for an approval decision");
    expect(contents).not.toContain("You are the repository explorer");
    expect(contents).not.toContain("You are the implementation planner");
    expect(contents).not.toContain("You are the independent feature verifier");
    expect(contents).not.toContain("tool_summary");
  }
}, 150_000);

test("SPEC-BLD-002/CA-02 — an unknown literal flag makes actual compilation fail", async () => {
  const f = fixture();
  writeFileSync(join(f.root, "src/unknown-flag.ts"), '// Supports: SPEC-BLD-002\nimport { buildFlag } from "./extension-points/build-flags" with { type: "macro" }; export const invalid = buildFlag("unknown_test_flag");\n');
  const result = await f.build();
  expect(result.code).not.toBe(0); expect(result.stderr + result.stdout).toContain("unknown_test_flag"); expect(existsSync(join(f.root, "dist/manifest.json"))).toBe(false);
  const compiled = await runToCompletion(BUN, ["build", join(f.root, "src/unknown-flag.ts"), "--target=bun", "--outfile", join(f.root, "unknown.js")], { cwd: f.root, env: productEnv(f.ws), timeoutMs: 10_000 });
  expect(compiled.code).not.toBe(0); expect(compiled.stderr).toContain("unknown_test_flag"); expect(existsSync(join(f.root, "unknown.js"))).toBe(false);
}, 150_000);

test("SPEC-BLD-001/CA-02, SPEC-BLD-003/CA-01 — an injected internal command detected by an external private list prevents a validated build", async () => {
  const f = fixture(), terms = f.ws.write("forbidden.txt", "/private-analysis-probe\n");
  const entry = join(f.root, "src/main.ts");
  writeFileSync(join(f.root, "build-private-probe.txt"), "/private-analysis-probe");
  writeFileSync(entry, readFileSync(entry, "utf8") + '\nimport probe from "../build-private-probe.txt" with { type: "text" }; console.log(probe);\n');
  const data = JSON.parse(readFileSync(join(f.root, "identity/dev.identity.json"), "utf8"));
  const cli = loadIdentity().get("PRODUCT_CLI");
  data.compatibility = { scanExceptions: [`${cli}.js`, `${cli}${process.platform === "win32" ? ".exe" : ""}`].map((contexte) => ({ terme: "/PRIVATE_ANALYSIS_PROBE", contexte, justification: "Synthetic migration exception" })) };
  writeFileSync(join(f.root, "identity/private-exception.identity.json"), JSON.stringify(data));
  const result = await f.build(["--identity", "identity/private-exception.identity.json", "--forbidden-terms", terms]);
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("/private-analysis-probe"); expect(existsSync(join(f.root, "dist/manifest.json"))).toBe(false);
  expect(readFileSync(join(ROOT, "src/main.ts"), "utf8")).not.toContain("/private-analysis-probe");
}, 150_000);

test("TECH — build metadata stays outside the executable and runtime identity hashes its actual content", async () => {
  const f = fixture(), term = "private-metadata-only-probe", data = JSON.parse(readFileSync(join(f.root, "identity/dev.identity.json"), "utf8"));
  data.compatibility = { forbiddenTerms: [term], scanExceptions: [{ terme: term, contexte: "unused.txt", justification: "Synthetic metadata" }], allowLegacyReads: true };
  const source = JSON.stringify(data), identityFile = f.ws.write("identity.json", source);
  const original = resolveIdentityText(source, { version: "0.1.0", strict: true }).identity!, runtime = runtimeIdentity(original);
  expect(runtime.hash).not.toBe(original.hash); expect(runtime.compatibility).toEqual({ forbiddenTerms: [], allowLegacyReads: true });
  expect((await f.build(["--identity", identityFile])).code).toBe(0);
  expect(f.manifest().source.identity).toBe(original.hash); expect(f.manifest().identity).toBe(runtime.hash);
  for (const d of f.manifest().deliverables) expect(readFileSync(join(f.root, "dist", d.file)).toString("latin1")).not.toContain(term);
  const generated = await import(join(f.root, "src/identity/generated/build-data.ts"));
  expect(generated.RESOLVED_IDENTITY).toEqual(runtime);
  expect(runtimeIdentity(generated.RESOLVED_IDENTITY).hash).toBe(runtime.hash);
}, 150_000);

test("TECH — nonmacro feature reads fail before bundling and cannot retain a disabled branch", async () => {
  const f = fixture(), entry = join(f.root, "src/main.ts"), options = f.ws.write("options.json", JSON.stringify({ permission_auto_approve: false }));
  writeFileSync(entry, readFileSync(entry, "utf8") + '\nimport { buildFlag } from "./extension-points/build-flags"; if (buildFlag("permission_auto_approve")) console.log("nonmacro-branch-probe");\n');
  const result = await f.build(["--build-options", options]);
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("requires a macro import"); expect(existsSync(join(f.root, "dist/manifest.json"))).toBe(false);
}, 150_000);

test("TECH — a file asset which would depend on dist at runtime cannot receive a build receipt", async () => {
  const f = fixture(), entry = join(f.root, "src/main.ts");
  writeFileSync(join(f.root, "src/asset-probe.png"), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  writeFileSync(join(f.root, "src/asset-probe.d.ts"), '// Supports: SPEC-BLD-001\ndeclare module "*.png" { const path: string; export default path; }\n');
  writeFileSync(entry, readFileSync(entry, "utf8") + '\nimport asset from "./asset-probe.png" with { type: "file" }; console.log(asset);\n');
  const result = await f.build();
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("Ressource externe non embarquée"); expect(existsSync(join(f.root, "dist/manifest.json"))).toBe(false);
}, 150_000);
