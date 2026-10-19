// Supports: SPEC-VOX-001, SPEC-BLD-002 (native capture presence and inactive helper bodies).
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveBuildOptions } from "../src/extension-points/build-options";
const ROOT = resolve(import.meta.dir, "..");
async function probe(profile: "public" | "internal" | "test", enabled: boolean) {
  const base = join(ROOT, "build", "activation-audio-complement", "probes"); mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, "profile-"));
  for (const folder of ["src", "prompts"]) cpSync(join(ROOT, folder), join(root, folder), { recursive: true });
  mkdirSync(join(root, "tests", "fixtures"), { recursive: true }); const entry = join(root, "tests", "fixtures", "audio-activation-probe.ts"); cpSync(join(ROOT, "tests", "fixtures", "audio-activation-probe.ts"), entry);
  cpSync(join(ROOT, "tsconfig.json"), join(root, "tsconfig.json")); symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(root, "src", "identity", "generated", "build-flags.ts"), "export const BUILD_PROFILE = " + JSON.stringify(profile) + ";\nexport const BUILD_VALUES = " + JSON.stringify(resolveBuildOptions(profile, { ui_dictation: enabled })) + " as const;\n");
  const built = await Bun.build({ entrypoints: [entry], target: "bun", minify: true, outdir: root, naming: "probe.js" }); if (!built.success) throw Error(built.logs.join("\n"));
  const run = Bun.spawnSync([process.execPath, "--no-env-file", join(root, "probe.js")], { cwd: root, env: {}, timeout: 10000 });
  writeFileSync(join(root, "observations.json"), JSON.stringify({ profile, enabled, code: run.exitCode, stdout: run.stdout.toString(), stderr: run.stderr.toString() }, null, 2));
  if (run.exitCode !== 0) throw Error(run.stderr.toString());
  return { source: readFileSync(join(root, "probe.js"), "utf8"), data: JSON.parse(run.stdout.toString()) as { script?: string; scriptError?: string; captureError?: string; nativeAudioSources: { macos: string; linux: string } } };
}
test("TECH — excluded dictation removes native helper bodies and refuses direct microphone entries before effects", async () => {
  for (const profile of ["internal", "test"] as const) {
    const { source, data } = await probe(profile, false);
    expect(source.includes("AUDIO_READY"), profile).toBe(false); expect(source.includes("MicrophoneInput"), profile).toBe(false);
    expect(data.script).toBeUndefined(); expect(data.scriptError).toContain("unavailable in this build"); expect(data.captureError).toContain("unavailable in this build"); expect(data.nativeAudioSources).toEqual({ macos: "", linux: "" });
  }
}, 30000);
test("TECH — included dictation retains native helper text and cancellation before any microphone access", async () => {
  const { source, data } = await probe("public", true);
  expect(source.includes("AUDIO_READY")).toBe(true); expect(data.script).toContain("MICROPHONE_HELPER_COMPILED"); expect(data.scriptError).toBeUndefined(); expect(data.captureError).toBe("Probe cancelled before capture."); expect(data.nativeAudioSources.macos).toContain("AVAudioEngine"); expect(data.nativeAudioSources.linux).toContain("--format=S16_LE");
}, 30000);
