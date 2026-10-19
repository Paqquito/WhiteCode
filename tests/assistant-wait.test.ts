// Supports: SPEC-OUT-023, SPEC-MOD-026 (real controlled driver with an omitted proactive capability).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { activationProfile } from "./helpers/activation-profile";

function compiled(assistant: boolean) {
  const f = activationProfile("test", { mode_assistant_persistent: assistant, mode_self_initiated: false });
  const output = join(f.root, "tests/compiled/assistant-wait-probe.js");
  mkdirSync(dirname(output), { recursive: true });
  const built = spawnSync(process.execPath, ["--no-env-file", "build", "tests/fixtures/assistant-wait-probe.ts", "--target=bun", "--minify", "--external=bun:test", "--outfile", output], { cwd: f.root, env: f.environment, encoding: "utf8", windowsHide: true, timeout: 30000 });
  expect(built.status, built.stdout + built.stderr).toBe(0);
  const source = readFileSync(output, "utf8").replace(/\\x([a-f0-9]{2})|\\u([a-f0-9]{4})/gi, (_match, hex, unicode) => String.fromCharCode(parseInt(hex ?? unicode, 16)));
  return { ...f, output, source };
}

test("TECH — a real controlled persistent assistant advertises wait and wakes on a message with proactive mode omitted", () => {
  const f = compiled(true);
  const result = spawnSync(process.execPath, ["--no-env-file", "test", f.output], { cwd: f.root, env: f.environment, encoding: "utf8", windowsHide: true, timeout: 20000 });
  writeFileSync(join(dirname(f.output), "assistant-wait-verdict.json"), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }, null, 2));
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stderr).toMatch(/1 pass/);
  expect(result.stderr).toMatch(/0 fail/);
  expect(f.source).toContain("Wait without a shell process");
  expect(f.source).not.toContain("[Proactive wake at ");
}, 60000);

test("TECH — wait body is removed when both assistant and proactive capabilities are omitted", () => {
  const f = compiled(false);
  expect(f.source).not.toContain("Wait without a shell process");
  expect(f.source).not.toContain("[Proactive wake at ");
}, 60000);
