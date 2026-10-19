// Supports: SPEC-CMD-003, SPEC-MOT-027, SPEC-BLD-003 (actual command/tool omission).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activationProfile } from "./helpers/activation-profile";

for (const included of [true, false]) test(`TECH — a real controlled session honours compiled advisor presence ${included}`, () => {
  const f = activationProfile("test", { model_advisor: included }), output = join(f.root, "tests/compiled/advisor-presence-probe.js");
  mkdirSync(dirname(output), { recursive: true });
  const built = spawnSync(process.execPath, ["--no-env-file", "build", "tests/fixtures/advisor-presence-probe.ts", "--target=bun", "--minify", "--external=bun:test", "--outfile", output], { cwd: f.root, env: f.environment, encoding: "utf8", windowsHide: true, timeout: 30000 });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  const result = spawnSync(process.execPath, ["--no-env-file", "test", output], { cwd: f.root, env: f.environment, encoding: "utf8", windowsHide: true, timeout: 15000 });
  writeFileSync(join(dirname(output), "advisor-presence-verdict.json"), JSON.stringify({ included, status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/1 pass/); expect(result.stderr).toMatch(/0 fail/);
}, 60000);
