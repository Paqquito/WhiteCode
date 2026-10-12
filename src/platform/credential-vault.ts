// Implements: SPEC-PER-027 (Windows preferred user credential store, EF-01, EF-03, EF-06, RG-01).
// Supports: gap E-135 (native platform adapters, no secret in command arguments or on disk).
import { dlopen, ptr, toArrayBuffer } from "bun:ffi";
import { currentPlatform } from "./system";
import { posixCredentialVault } from "./credential-vault-posix";

export interface CredentialVault {
  read(service: string, account: string): string | undefined | Promise<string | undefined>;
  write(service: string, account: string, value: string): void | Promise<void>;
  remove(service: string, account: string): void | Promise<void>;
}
export class VaultUnavailable extends Error {
  constructor(readonly locked = false) { super("Trousseau système indisponible ou verrouillé."); }
}
const openWindowsVault = () => ({
  credentials: dlopen("advapi32.dll", {
    CredReadW: { args: ["buffer", "u32", "u32", "buffer"], returns: "i32" },
    CredWriteW: { args: ["buffer", "u32"], returns: "i32" },
    CredDeleteW: { args: ["buffer", "u32", "u32"], returns: "i32" },
    CredFree: { args: ["ptr"], returns: "void" },
  }),
  errors: dlopen("kernel32.dll", { GetLastError: { args: [], returns: "u32" } }),
});
let windowsVault: ReturnType<typeof openWindowsVault> | undefined;
function windowsApi() {
  try { return windowsVault ??= openWindowsVault(); } catch { throw new VaultUnavailable(); }
}
function target(service: string, account: string): Buffer {
  if (!service || !account || /[\u0000\r\n]/.test(service + account)) throw new Error("Nom de trousseau invalide.");
  return Buffer.from(service + "/" + account + "\0", "utf16le");
}
const nativeFailure = (code: number): never => {
  if ([5, 1312, 1167].includes(code)) throw new VaultUnavailable(code !== 1167);
  throw new Error(`Opération du trousseau refusée (Windows ${code}).`);
};

/** Generic entries persist across logins of this user; the Windows constant does not grant machine-wide access. */
export function nativeCredentialVault(options: { readonly interactive?: boolean; readonly environment?: Readonly<Record<string, string>> } = {}): CredentialVault {
  if (currentPlatform() !== "windows") return posixCredentialVault(options.interactive === true, options.environment ?? {});
  return {
    read(service, account) {
      const api = windowsApi(), result = Buffer.alloc(8);
      if (!api.credentials.symbols.CredReadW(target(service, account), 1, 0, result)) {
        const code = api.errors.symbols.GetLastError();
        if (code === 1168) return undefined;
        return nativeFailure(code);
      }
      const pointer = result.readBigUInt64LE();
      try {
        const value = Buffer.from(toArrayBuffer(pointer, 0, 80));
        const length = value.readUInt32LE(32), data = value.readBigUInt64LE(40);
        if (length > 2560 || (length && !data)) throw new Error("Entrée du trousseau invalide.");
        return length ? Buffer.from(toArrayBuffer(data, 0, length)).toString("utf8") : "";
      } finally { api.credentials.symbols.CredFree(pointer); }
    },
    write(service, account, secret) {
      const api = windowsApi(), name = target(service, account), bytes = Buffer.from(secret, "utf8");
      if (!bytes.length || bytes.length > 2560) throw new Error("Identifiant trop volumineux pour cette version du trousseau Windows.");
      const value = Buffer.alloc(80);
      value.writeUInt32LE(1, 4); value.writeBigUInt64LE(BigInt(ptr(name)), 8);
      value.writeUInt32LE(bytes.length, 32); value.writeBigUInt64LE(BigInt(ptr(bytes)), 40);
      value.writeUInt32LE(2, 48); // CRED_PERSIST_LOCAL_MACHINE: same user, subsequent logon sessions.
      try {
        if (!api.credentials.symbols.CredWriteW(value, 0)) nativeFailure(api.errors.symbols.GetLastError());
      } finally { bytes.fill(0); }
    },
    remove(service, account) {
      const api = windowsApi();
      if (!api.credentials.symbols.CredDeleteW(target(service, account), 1, 0)) {
        const code = api.errors.symbols.GetLastError();
        if (code !== 1168) nativeFailure(code);
      }
    },
  };
}
