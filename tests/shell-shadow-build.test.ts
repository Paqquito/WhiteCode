import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveBuildOptions } from "../src/extension-points/build-options";

test("TECH — either excluded shell observer flag prevents a direct callback without changing permission decisions", async () => {
  const source = resolve(import.meta.dir, "..");
  for (const syntax of [false, true]) for (const shadow of [false, true]) {
    const root = join(source, "build", `shell-shadow-flags-${randomUUID()}`); mkdirSync(root, { recursive: true });
    cpSync(join(source, "src"), join(root, "src"), { recursive: true }); cpSync(join(source, "tsconfig.json"), join(root, "tsconfig.json"));
    symlinkSync(realpathSync(join(source, "node_modules")), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    const flags = resolveBuildOptions("public", { shell_syntax_analysis: syntax, shell_syntax_analysis_shadow: shadow });
    writeFileSync(join(root, "src/identity/generated/build-flags.ts"), `export const BUILD_PROFILE = "public";\nexport const BUILD_VALUES = ${JSON.stringify(flags)} as const;\n`);
    writeFileSync(join(root, "probe.ts"), 'import { decide } from "./src/permissions/engine"; const reports: unknown[] = []; let reads = 0; const context = { mode: "unrestricted", rules: [], sessionAllows: [], managedRulesOnly: false, cwd: "/fixture", home: "/home", platform: "linux", get shellShadow() { reads++; return value => reports.push(value); } }; const query = { toolName: "run_shell", subject: { kind: "command", command: "echo $(printf SHADOW_PRIVATE_WITNESS)" }, available: true, flags: { readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: false } }; console.log(JSON.stringify({ decision: decide(query, context), reports, reads }));\n');
    const built = await Bun.build({ entrypoints: [join(root, "probe.ts")], target: "bun", minify: true, outdir: root, naming: "probe.js" });
    if (!built.success) throw new Error(built.logs.join("\n"));
    const run = Bun.spawnSync([process.execPath, "--no-env-file", join(root, "probe.js")], { cwd: root, env: {}, timeout: 10000 });
    expect(run.exitCode).toBe(0);
    const actual = JSON.parse(run.stdout.toString()) as { decision: { kind: string }; reports: unknown[]; reads: number };
    expect(actual.decision.kind).toBe("allow");
    expect(actual.reports).toEqual(syntax && shadow ? [{ existing: "allow", candidate: "ask" }] : []);
    expect(actual.reads > 0).toBe(syntax && shadow);
    expect(JSON.stringify(actual.reports)).not.toContain("SHADOW_PRIVATE_WITNESS");
    expect(readFileSync(join(root, "probe.js"), "utf8")).toContain("SHADOW_PRIVATE_WITNESS");
  }
}, 30000);
