// Only this child restricts its own token; no login, elevation or machine ACL change.
import { dlopen, ptr } from "bun:ffi";
import { chmodSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "../helpers/env";
import { inspectPolicyFileProtection } from "../../src/platform/policy-file";

const ws = workspace();
const file = ws.write("managed/policy.json", JSON.stringify({ permissions: { denyRules: ["run_shell"] } }));
const security = dlopen("advapi32.dll", {
  OpenProcessToken: { args: ["u64", "u32", "buffer"], returns: "i32" },
  CreateRestrictedToken: { args: ["u64", "u32", "u32", "ptr", "u32", "ptr", "u32", "ptr", "buffer"], returns: "i32" },
  DuplicateTokenEx: { args: ["u64", "u32", "ptr", "u32", "u32", "buffer"], returns: "i32" },
  SetThreadToken: { args: ["ptr", "u64"], returns: "i32" },
  RevertToSelf: { args: [], returns: "i32" },
});
const kernel = dlopen("kernel32.dll", { CloseHandle: { args: ["u64"], returns: "i32" }, GetLastError: { args: [], returns: "u32" } });
const checked = (result: number) => { if (result === 0) throw new Error(`Token fixture failed: ${kernel.symbols.GetLastError()}`); };
const handles = [Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)];
const administrators = Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0]);
const disabled = Buffer.alloc(16);
disabled.writeBigUInt64LE(BigInt(ptr(administrators)));
try {
  checked(security.symbols.OpenProcessToken(0xffffffffffffffffn, 0x0a, handles[0]!));
  checked(security.symbols.CreateRestrictedToken(handles[0]!.readBigUInt64LE(), 1, 1, ptr(disabled), 0, null, 0, null, handles[1]!));
  checked(security.symbols.DuplicateTokenEx(handles[1]!.readBigUInt64LE(), 0x0c, null, 2, 2, handles[2]!));
  checked(security.symbols.SetThreadToken(null, handles[2]!.readBigUInt64LE()));
  const ordinary = inspectPolicyFileProtection(file);
  chmodSync(file, 0o444);
  const readonly = inspectPolicyFileProtection(file);
  const protectedFile = inspectPolicyFileProtection(join(process.env["SystemRoot"]!, "System32/kernel32.dll"));
  const mandatory = await cli(["--non-interactive", "Read the summary."], ws, { extra: { policyFileProtection: inspectPolicyFileProtection } });
  const validation = await cli(["config", "validate", "--scope", "managed"], ws, { extra: { policyFileProtection: inspectPolicyFileProtection } });
  checked(security.symbols.RevertToSelf());
  console.log(JSON.stringify({ ordinary, readonly, protectedFile, mandatory, validation }));
} finally {
  checked(security.symbols.RevertToSelf());
  chmodSync(file, 0o644);
  for (const handle of handles) if (handle.readBigUInt64LE() !== 0n) checked(kernel.symbols.CloseHandle(handle.readBigUInt64LE()));
  security.close();
  kernel.close();
}
