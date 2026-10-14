import { expect, test } from "bun:test";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { runToCompletion, startChild } from "../src/platform/process";
import { loadIdentity, ROOT, workspace } from "./helpers/env";
import { BUN, POSIX, productEnv } from "./helpers/hooks";
import { resolveIdentityText, runtimeIdentity } from "../src/identity/resolver";
import { bootstrapScript } from "../src/installation/bootstrap";
import { findExecutable } from "../src/platform/system";
import { Identity } from "../src/identity/identity";

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
  const run = async (file: string, args: string[], env: Record<string, string> = {}) => {
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    const child = startChild(join(root, "dist", file), args, { cwd: ws.project, env: productEnv(ws, { [`${loadIdentity().get("ENV_PREFIX")}CONFIG_HOME`]: ws.configHome, ...env }), onData: chunk => stdout.push(chunk), onErrorData: chunk => stderr.push(chunk) });
    const deadline = setTimeout(() => void child.killTree(50), 10_000);
    try { return { code: await child.exited, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }; }
    finally { clearTimeout(deadline); }
  };
  return { root, ws, build, manifest, run };
}

test("SPEC-CAD-002/CA-21 — apostrophes and quotes in the actual package manifest and both installer scripts remain syntactically valid", async () => {
  const f = fixture(), brand = `L'outil "Clair"`, input = JSON.parse(readFileSync(join(f.root, "identity/dev.identity.json"), "utf8"));
  input.identity.PRODUCT = brand;
  const source = join(f.root, "identity/quoted.identity.json"); writeFileSync(source, JSON.stringify(input));
  const generated = await runToCompletion(BUN, [join(f.root, "scripts/generate.ts"), "--identity", source], { cwd: f.root, env: productEnv(f.ws), timeoutMs: 10000 });
  expect(generated.code).toBe(0); expect(JSON.parse(readFileSync(join(f.root, "src/identity/generated/package.json"), "utf8")).description).toStartWith(brand);
  const resolved = resolveIdentityText(JSON.stringify(input), { version: "0.1.0" }); expect(resolved.identity).toBeDefined(); const identity = new Identity(resolved.identity!);
  const sh = join(f.root, "install.sh"), ps = join(f.root, "install.ps1"); writeFileSync(sh, bootstrapScript(identity, "sh")); writeFileSync(ps, bootstrapScript(identity, "powershell"));
  const shell = POSIX?.path;
  if (shell) { const parsed = await runToCompletion(shell, ["-n", sh.replace(/\\/g, "/")], { cwd: f.root, env: productEnv(f.ws), timeoutMs: 5000 }); expect(parsed.code).toBe(0); expect(readFileSync(sh, "utf8")).toContain(`L'\\''outil "Clair"`); }
  const powershell = findExecutable("pwsh") ?? findExecutable("powershell.exe");
  if (powershell) { const parsed = await runToCompletion(powershell, ["-NoProfile", "-NonInteractive", "-Command", `$t=$null; $e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${ps.replace(/'/g, "''")}',[ref]$t,[ref]$e); if ($e.Count) { $e | Out-String | Write-Error; exit 1 }`], { cwd: f.root, env: productEnv(f.ws), timeoutMs: 5000 }); expect(parsed.code).toBe(0); expect(readFileSync(ps, "utf8")).toContain(`L''outil "Clair"`); }
  expect(Boolean(shell || powershell)).toBe(true);
}, 20000);

test("SPEC-BLD-006/CA-01 — SPEC-BLD-008/CA-01 — two identities generate their package manifests and extension author documentation", async () => {
  const f = fixture();
  for (const file of ["identity/dev.identity.json", "identity/test-omega.identity.json"]) {
    const result = await runToCompletion(BUN, [join(f.root, "scripts/generate.ts"), "--identity", file], { cwd: f.root, env: productEnv(f.ws), timeoutMs: 10_000 });
    expect(result.code).toBe(0); const expected = loadIdentity(file);
    const pkg = JSON.parse(readFileSync(join(f.root, "src/identity/generated/package.json"), "utf8"));
    const documentation = readFileSync(join(f.root, "src/identity/generated/extension-authors.html"), "utf8");
    expect(documentation).toContain(expected.get("HINT_TAG")); expect(documentation).toContain(`${expected.get("ENV_PREFIX")}CHILD_PROCESS`); expect(documentation).not.toMatch(/\{\{[A-Z_]+\}\}/);
    expect(pkg.name).toBe(expected.get("PRODUCT_SLUG")); expect(pkg.author).toBe(expected.get("SOCIETY")); expect(pkg.bin).toEqual({ [expected.get("PRODUCT_SLUG")]: `${expected.get("PRODUCT_CLI")}.js` }); expect(pkg.engines.bun).toBe(">=1.4.2");
  }
}, 30_000);

test("SPEC-BLD-009/CA-01 — SPEC-BLD-009/CA-02 — the public executable ignores profile environment overrides and contains no internal feature markers", async () => {
  const f = fixture(); expect((await f.build()).code).toBe(0);
  const file = f.manifest().deliverables.find((d: { target: string }) => d.target === "current").file;
  const prefix = loadIdentity().get("ENV_PREFIX");
  const result = await runToCompletion(join(f.root, "dist", file), ["--strict-failure"], { cwd: f.ws.project, env: productEnv(f.ws, { [`${prefix}BUILD_PROFILE`]: "internal", [`${prefix}ORCHESTRATOR_ROLE`]: "relecteur", [`${prefix}FEATURE_OVERRIDES`]: '{"strict_failure":true}' }), timeoutMs: 10_000 });
  expect(result.code).not.toBe(0); expect(result.stderr).toContain("inconnue");
  for (const d of f.manifest().deliverables.filter((d: { target: string }) => ["bundle", "current"].includes(d.target))) {
    const content = readFileSync(join(f.root, "dist", d.file));
    for (const marker of ["STRICT-FAILURE:", "orchestrator.role", "Export non masqu", "Développement ·"]) expect(content.includes(Buffer.from(marker))).toBe(false);
  }
}, 150_000);

test("SPEC-OBS-019/CA-01 — the internal export includes project instructions without connecting to the model service", async () => {
  const f = fixture(), identity = loadIdentity();
  writeFileSync(join(f.ws.configHome, "config.json"), JSON.stringify({ api: { provider: "openai_compatible", baseUrl: "http://127.0.0.1:9/v1" }, models: { selected: "fixture-model" } }));
  writeFileSync(join(f.ws.project, identity.get("INSTRUCTIONS_FILE")), "PROJECT_INSTRUCTION_EXPORT_WITNESS\n");
  const built = await f.build(["--profile", "internal"]); if (built.code !== 0) throw new Error(built.stderr + built.stdout);
  const file = f.manifest().deliverables.find((d: { target: string }) => d.target === "current").file;
  const result = await f.run(file, ["--export-system-instructions", "--non-interactive", "--ephemeral", "--allow-project-trust"]);
  if (result.code !== 0) throw new Error(result.stderr + result.stdout);
  expect(result.code).toBe(0); expect(result.stdout).toContain("PROJECT_INSTRUCTION_EXPORT_WITNESS"); expect(result.stderr).toContain("Export non masqué"); expect(existsSync(join(f.ws.configHome, "sessions"))).toBe(false);
}, 150_000);

test("SPEC-OBS-014/CA-01 — the internal strict mode stops on a recoverable logged model error with exit code one", async () => {
  const f = fixture(), server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: { message: "fixture failure" } }, { status: 503 }) });
  writeFileSync(join(f.ws.configHome, "config.json"), JSON.stringify({ api: { provider: "openai_compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, maxRetries: 0 }, models: { selected: "fixture-model" } }));
  try {
    const built = await f.build(["--profile", "internal"]); if (built.code !== 0) throw new Error(built.stderr + built.stdout);
    const file = f.manifest().deliverables.find((d: { target: string }) => d.target === "current").file;
    const prefix = loadIdentity().get("ENV_PREFIX");
    const result = await f.run(file, ["--strict-failure", "--non-interactive", "--ephemeral", "go"], { [`${prefix}TELEMETRY`]: "1", [`${prefix}ORCHESTRATOR_ROLE`]: "relecteur", OTEL_LOGS_EXPORTER: "console", OTEL_METRICS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "none" });
    if (result.code !== 1) throw new Error(`Exit ${result.code}: ${result.stderr + result.stdout}`);
    expect(result.code).toBe(1); expect(result.stderr).toContain("STRICT-FAILURE:"); expect(result.stderr).toContain("Error");
    expect(result.stderr).toContain('"key":"orchestrator.role"'); expect(result.stderr).toContain('"stringValue":"relecteur"');
  } finally { server.stop(true); }
}, 150_000);

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
  const f = fixture(), options = f.ws.write("options.json", JSON.stringify({ permission_auto_approve: false, agent_explorer_planner: false, agent_verifier: false, stream_compact_profile: false, ui_fast_find: false, ui_history_browser: false, ui_message_menu: false, prompt_hints: false, mode_template_jobs: false, mode_background_sessions: false }));
  const result = await f.build(["--build-options", options]);
  if (result.code !== 0) throw new Error(result.stderr + result.stdout);
  expect(result.code).toBe(0);
  const manifest = f.manifest();
  expect(manifest.build.options.permission_auto_approve).toBe(false);
  expect(manifest.build.options.agent_explorer_planner).toBe(false);
  expect(manifest.build.options.agent_verifier).toBe(false);
  expect(manifest.build.options.stream_compact_profile).toBe(false);
  expect(manifest.build.options.ui_fast_find).toBe(false); expect(manifest.build.options.ui_history_browser).toBe(false); expect(manifest.build.options.ui_message_menu).toBe(false);
  expect(manifest.build.options.prompt_hints).toBe(false); expect(manifest.build.options.mode_template_jobs).toBe(false); expect(manifest.build.options.mode_background_sessions).toBe(false);
  for (const d of manifest.deliverables.filter((d: { target: string }) => ["bundle", "current"].includes(d.target))) {
    const contents = readFileSync(join(f.root, "dist", d.file)).toString("latin1");
    expect(contents).not.toContain("You are the approval classifier for a coding session");
    expect(contents).not.toContain("The complete action is too large for an approval decision");
    expect(contents).not.toContain("You are the repository explorer");
    expect(contents).not.toContain("You are the implementation planner");
    expect(contents).not.toContain("You are the independent feature verifier");
    expect(contents).not.toContain("tool_summary");
    expect(contents).not.toContain("Ouverture rapide"); expect(contents).not.toContain("Recherche globale"); expect(contents).not.toContain("Filtrer mes saisies"); expect(contents).not.toContain("Copier le bloc");
    expect(contents).not.toContain("Predict one short next user request"); expect(contents).not.toContain("Classify the whole main-agent turn");
    expect(contents).not.toContain("Job workspace must be an ordinary directory"); expect(contents).not.toContain("Summarize this session's task, current progress and next need");
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
