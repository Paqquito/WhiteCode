// Implements: SPEC-CFG-003 (§ 5.1 Windows registry channel, § 12 protected local source), gap E-123.
// Native calls are confined to the platform adapter; no shell, PATH lookup or environment expansion.
import { dlopen } from "bun:ffi";
import { currentPlatform } from "./system";

export interface RegistryPolicy {
  readonly text?: string;
  readonly error?: string;
  readonly writable?: boolean;
}
export type RegistryPolicyReader = () => RegistryPolicy;

const HKLM = 0xffffffff80000002n;
const VIEW64 = 0x100;
const MAX_BYTES = 1024 * 1024;
const wide = (text: string) => Buffer.from(`${text}\0`, "utf16le");
const openApi = () => dlopen("advapi32.dll", {
  RegGetValueW: { args: ["u64", "buffer", "buffer", "u32", "buffer", "ptr", "buffer"], returns: "i32" },
  RegOpenKeyExW: { args: ["u64", "buffer", "u32", "u32", "buffer"], returns: "i32" },
  RegCloseKey: { args: ["u64"], returns: "i32" },
  CheckTokenMembership: { args: ["u64", "buffer", "buffer"], returns: "i32" },
});
let api: ReturnType<typeof openApi> | undefined;

/** `Policy`, REG_SZ, in the machine's 64-bit policy view. Only a missing key/value means absence. */
export function readWindowsRegistryPolicy(key: string): RegistryPolicy {
  if (currentPlatform() !== "windows") return {};
  const parts = key.split(/\\+/);
  if (parts.some((part) => !part || /[\0\r\n]/.test(part)) || /^HK/i.test(key)) return { error: "invalid-key" };
  try {
    const native = (api ??= openApi()).symbols;
    const path = wide(parts.join("\\"));
    const value = wide("Policy");
    const size = Buffer.alloc(4);
    const type = Buffer.alloc(4);
    const flags = 0x00010002; // REG_SZ only; 64-bit view, independent of the executable architecture.
    const status = native.RegGetValueW(HKLM, path, value, flags, type, null, size);
    if (status === 2 || status === 3) return {};
    if (status !== 0) return { error: `registry-${status}` };
    const length = size.readUInt32LE();
    if (length < 2 || length > MAX_BYTES || length % 2 !== 0) return { error: "invalid-size" };
    const bytes = Buffer.alloc(length + 2);
    size.writeUInt32LE(bytes.length);
    const readStatus = native.RegGetValueW(HKLM, path, value, flags, type, bytes, size);
    if (readStatus !== 0) return { error: `registry-${readStatus}` };
    const actual = size.readUInt32LE();
    if (type.readUInt32LE() !== 1 || actual < 2 || actual > MAX_BYTES || actual > bytes.length || actual % 2 !== 0 || bytes.readUInt16LE(actual - 2) !== 0) return { error: "invalid-value" };
    const text = bytes.subarray(0, actual - 2).toString("utf16le");
    if (text.includes("\0")) return { error: "invalid-value" };
    const member = Buffer.alloc(4);
    // SID S-1-5-32-544: the built-in administrators, evaluated against the effective token.
    const administrators = Buffer.from([1, 2, 0, 0, 0, 0, 0, 5, 32, 0, 0, 0, 32, 2, 0, 0]);
    if (native.CheckTokenMembership(0n, administrators, member) === 0) return { error: "unverifiable-rights" };
    if (member.readUInt32LE() !== 0) return { text, writable: false };
    // A writable ancestor can replace the policy too. Probe permissions without modifying any key.
    for (let depth = parts.length; depth > 0; depth--) {
      for (const right of [2, 4, 0x10000, 0x40000, 0x80000]) { // set value, create child, delete, change ACL/owner
        const handle = Buffer.alloc(8);
        const access = native.RegOpenKeyExW(HKLM, wide(parts.slice(0, depth).join("\\")), 0, VIEW64 | right, handle);
        if (access === 0) { native.RegCloseKey(handle.readBigUInt64LE()); return { text, writable: true }; }
        if (access !== 5) return { error: "unverifiable-rights" };
      }
    }
    return { text, writable: false };
  } catch {
    return { error: "unavailable" };
  }
}
