// Implements: SPEC-CFG-003 (FA-02, § 12 protected local files).
// Supports: SPEC-CFG-003 (§ 5.7 point 3), SPEC-PER-021 (EF-01 effective token cannot write a durable consent grant), gaps E-124, E-129.
// Permission probes never create, truncate, write or delete a file.
import { dlopen } from "bun:ffi";
import { accessSync, constants, lstatSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { currentPlatform } from "./system";

export interface PolicyFileProtection { readonly writable?: boolean; readonly error?: string }
export type PolicyFileProtectionReader = (file: string) => PolicyFileProtection;

const openWindowsApi = () => ({
  files: dlopen("kernel32.dll", {
    CreateFileW: { args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "u64"], returns: "u64" },
    CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  }),
  tokens: dlopen("advapi32.dll", { CheckTokenMembership: { args: ["u64", "buffer", "buffer"], returns: "i32" } }),
});
let windowsApi: ReturnType<typeof openWindowsApi> | undefined;

function windowsProtection(paths: readonly string[], allowAdministrativeProcess: boolean): PolicyFileProtection {
  const native = windowsApi ??= openWindowsApi();
  const member = Buffer.alloc(4);
  const administrators = Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0]);
  if (native.tokens.symbols.CheckTokenMembership(0n, administrators, member) === 0) return { error: "unverifiable-rights" };
  if (allowAdministrativeProcess && member.readUInt32LE() !== 0) return { writable: false };
  for (const [index, path] of paths.entries()) {
    // On a parent, DELETE_CHILD allows replacement even when the child's ACL forbids writes.
    const rights = index === 0 ? [2, 4, 0x10000, 0x40000, 0x80000] : [0x40, 0x40000, 0x80000, ...(index < paths.length - 1 ? [0x10000] : [])];
    for (const right of rights) {
      const handle = BigInt(native.files.symbols.CreateFileW(Buffer.from(`\\\\?\\${path}\0`, "utf16le"), right, 7, null, 3, 0x02200000, 0n));
      if (handle !== 0xffffffffffffffffn) {
        if (native.files.symbols.CloseHandle(handle) === 0) return { error: "unverifiable-rights" };
        return { writable: true };
      }
      if (native.files.symbols.GetLastError() !== 5) return { error: "unverifiable-rights" };
    }
  }
  return { writable: false };
}

/** A non-administrator must neither own the source nor be able to replace any component. */
export function inspectPolicyFileProtection(file: string, allowAdministrativeProcess = true): PolicyFileProtection {
  const platform = currentPlatform();
  if (!isAbsolute(file) || file.includes("\0") || (platform === "windows" && !/^[A-Za-z]:[\\/]/.test(file))) return { error: "unsupported-path" };
  if (platform === "other") return { error: "unsupported-platform" };
  try {
    const paths = [resolve(file)];
    while (dirname(paths.at(-1)!) !== paths.at(-1)) paths.push(dirname(paths.at(-1)!));
    const stats = paths.map((path) => lstatSync(path));
    if (stats.some((stat, index) => stat.isSymbolicLink() || (index === 0 ? !stat.isFile() : !stat.isDirectory()))) return { error: "unsafe-path" };
    if (platform === "windows") return windowsProtection(paths, allowAdministrativeProcess);
    for (const [index, stat] of stats.entries()) {
      // Root-owned sticky directories cannot replace their root-owned children (for example /tmp).
      const stickyParent = index > 0 && (stat.mode & 0o1000) !== 0;
      if (stat.uid !== 0 || (!stickyParent && (stat.mode & 0o022) !== 0)) return { writable: true };
      if ((!allowAdministrativeProcess || process.geteuid?.() !== 0) && !stickyParent) {
        try { accessSync(paths[index]!, constants.W_OK); return { writable: true }; }
        catch (error) { if (!["EACCES", "EPERM", "EROFS"].includes((error as NodeJS.ErrnoException).code ?? "")) return { error: "unverifiable-rights" }; }
      }
    }
    return { writable: false };
  } catch { return { error: "unverifiable-rights" }; }
}

/** Durable human attestation must be unwritable even by the current agent token. */
export const inspectPolicyConsentProtection: PolicyFileProtectionReader = (file) => inspectPolicyFileProtection(file, false);
