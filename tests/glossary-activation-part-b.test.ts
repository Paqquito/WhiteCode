// Compile only the capability probe in private copies; never regenerate the integration checkout.
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveBuildOptions } from "../src/extension-points/build-options";

const ROOT = resolve(import.meta.dir, ".."), FLAGS = ["model_fast_output", "engine_tool_summaries", "engine_control_channel", "browser_user_control", "storage_encryption"];
const MARKERS = ["Mode rapide en refroidissement", "Summarize the completed tool batch", "sdkServers exige", "native-reconnect", "Control the user's explicitly authorized browser extension tabs", "Migration des copies locales en cours."];
async function probe(overrides: Record<string, boolean>) {
  const base = join(ROOT, "build", "activation-thirty-one63", "part-b", "probes"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "profile-"));
  cpSync(join(ROOT, "src"), join(root, "src"), { recursive: true });
  mkdirSync(join(root, "tests", "fixtures"), { recursive: true });
  cpSync(join(ROOT, "tests", "fixtures", "activation-part-b-probe.ts"), join(root, "tests", "fixtures", "activation-part-b-probe.ts"));
  cpSync(join(ROOT, "tsconfig.json"), join(root, "tsconfig.json"));
  symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const values = resolveBuildOptions("public", overrides);
  writeFileSync(join(root, "src", "identity", "generated", "build-flags.ts"), "export const BUILD_PROFILE = \"public\";\nexport const BUILD_VALUES = " + JSON.stringify(values) + " as const;\n");
  const output = join(root, "probe.js");
  const built = await Bun.build({ entrypoints: [join(root, "tests", "fixtures", "activation-part-b-probe.ts")], target: "bun", minify: true, outdir: root, naming: "probe.js" });
  if (!built.success) throw Error(built.logs.join("\n"));
  const environment: Record<string, string> = { HOME: root, USERPROFILE: root, TMPDIR: root, TMP: root, TEMP: root };
  for (const name of ["PATH", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT"]) if (process.env[name]) environment[name] = process.env[name]!;
  const run = Bun.spawnSync([process.execPath, "--no-env-file", output], { cwd: root, env: environment, timeout: 20000 });
  const stdout = run.stdout.toString(), stderr = run.stderr.toString();
  writeFileSync(join(root, "observations.json"), JSON.stringify({ overrides, code: run.exitCode, stdout, stderr }, null, 2));
  if (run.exitCode !== 0) throw Error(stderr + stdout);
  return { data: JSON.parse(stdout.trim()) as Record<string, unknown> & { sent: Record<string, unknown>[]; parsed: Record<string, unknown> }, source: readFileSync(output, "utf8") };
}

test("TECH — excluded C/D capabilities refuse explicit entry points before credentials or browser writes", async () => {
  const { data, source } = await probe(Object.fromEntries(FLAGS.map(name => [name, false])));
  expect(data.fastResult).toContain("unavailable in this build"); expect(data.fastState).toBe("off"); expect(data.eligibility).toBe(0); expect(data.serviceOptions).toBeUndefined();
  expect(data.purposes).toEqual([]); expect(data.summaries).toEqual([]);
  expect(data.channelError).toContain("unavailable in this build"); expect(data.sessionError).toContain("unavailable in this build"); expect(data.sent).toEqual([]); expect(data.parsed.error).toContain("unavailable in this build");
  for (const key of ["bridgeError", "browserFilesError", "browserWriteError", "nativeHostError"]) expect(data[key]).toContain("unavailable in this build"); expect(data.remembered).toBe(0);
  expect(data.storageError).toContain("unavailable in this build"); expect(data.vaultReads).toBe(0); expect(data.vaultWrites).toBe(0); expect(data.storageFiles).toEqual(["input-history.jsonl"]); expect(data.plaintext).toBe("private-probe\n"); expect(data.decrypted).toBeUndefined();
  expect(data.existingError).toContain("archives chiffrées");
  for (const marker of MARKERS) expect(source).not.toContain(marker);
}, 30000);

test("TECH — default public capabilities remain explicit and preserve encrypted storage and negotiated control", async () => {
  const { data, source } = await probe({});
  expect(data.fastState).toBe("active"); expect(data.eligibility).toBe(1); expect(data.serviceOptions).toEqual({ service_tier: "priority" });
  expect(data.purposes).toEqual(["tool_progress"]); expect(data.summaries).toEqual(["Inspecter les fichiers."]);
  expect(data.channelError).toBeUndefined(); expect(data.sessionError).toBeUndefined(); expect(data.sent[0]?.type).toBe("control_init"); expect(data.parsed.type).toBe("control_init");
  expect(data.bridgeError).toBeUndefined(); expect(data.browserFilesError).toBeUndefined(); expect(data.browserWriteError).toBeUndefined(); expect(data.nativeHostError).toContain("identity");
  expect(data.storageError).toBeUndefined(); expect(data.decrypted).toBe("private-probe\n"); expect(data.plaintext).toBeUndefined(); expect(data.storageFiles).toContain("archives-v1"); expect(data.vaultWrites).toBeGreaterThan(0); expect(data.existingError).toContain("archives chiffrées");
  for (const marker of MARKERS) expect(source).toContain(marker);
}, 30000);

test("TECH — a control host cannot negotiate a summary capability excluded independently from control", async () => {
  const { data, source } = await probe({ engine_tool_summaries: false });
  expect(data.channelError).toBeUndefined(); expect(data.parsed.error).toContain("unavailable in this build"); expect(data.purposes).toEqual([]); expect(data.summaries).toEqual([]);
  expect(source).not.toContain("Summarize the completed tool batch");
}, 30000);
