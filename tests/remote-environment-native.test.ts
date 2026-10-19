// Supports: SPEC-MOD-013 CA-02, SPEC-CMD-104 CA-01 (real resident, HTTPS/WSS and ordinary child permissions).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runToCompletion } from "../src/platform/process";
import { ROOT, workspace } from "./helpers/env";
import { BUN, productEnv } from "./helpers/hooks";

const runtime = process.env.WC_RESIDENT_NATIVE_BUN;
const available = process.platform === "win32" && !!runtime;
const wsl = (...args: string[]) => ["-d", process.env.WC_NATIVE_LINUX_DISTRIBUTION ?? "Ubuntu", "--user", "root", "--exec", ...args];
test.skipIf(!available)("SPEC-MOD-013/CA-02 — SPEC-CMD-104/CA-01 — the real resident survives its terminal, starts permitted children and revokes only its own exposure", async () => {
  const ws = workspace(), environment = productEnv(ws), directory = join(ROOT, "build/resident-native"), binary = join(directory, "product"); mkdirSync(directory, { recursive: true });
  const command = async (file: string, args: string[], timeoutMs = 90000) => {
    const result = await runToCompletion(file, args, { cwd: ROOT, env: environment, timeoutMs });
    if (result.code !== 0) throw Error(result.stderr + result.stdout); return result.stdout.trim();
  };
  const windowsRuntime = await command("wsl.exe", wsl("/usr/bin/wslpath", "-w", runtime!));
  await command(BUN, ["--no-env-file", "build", "--compile", "--target=bun-linux-x64", "--compile-executable-path=" + windowsRuntime, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile=" + binary, join(ROOT, "tests/fixtures/resident-environment-native.ts")]);
  const script = await command("wsl.exe", wsl("/usr/bin/wslpath", "-u", join(ROOT, "tests/fixtures/resident-environment-native.py")));
  const executable = await command("wsl.exe", wsl("/usr/bin/wslpath", "-u", binary));
  const receipt = JSON.parse(await command("wsl.exe", wsl("/usr/bin/python3", script, executable)));
  writeFileSync(join(directory, "receipt.json"), JSON.stringify(receipt, null, 2));
  for (const key of ["https_web_request_created_real_child", "wss_authenticated_with_device", "client_closed_resident_survived", "duplicate_start_and_work_idempotent", "capacity_enforced", "denial_and_single_resolution", "local_read_deny_enforced", "allowed_write_completed", "child_credentials_absent", "late_shell_write_absent", "dotenv_bunfig_not_autoloaded", "stale_revoke_preserves_new_instance", "scoped_revoke_joined", "client_rotation_after_start_revokes_own_exposure", "stops_joined"]) expect(receipt.result[key]).toBe(true);
  expect(receipt.result.registration_count).toBe(3); expect(receipt.result.unregistration_count).toBe(3);
  expect(receipt.result.client_pid).not.toBe(receipt.result.resident_pid);
}, 120000);
