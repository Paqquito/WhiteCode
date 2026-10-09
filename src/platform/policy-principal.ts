// Supports: SPEC-PER-021 (EF-01 per-account protected consent), gap E-129.
// Identity comes from the process token or native UID, never profile/environment paths.
import { dlopen, type Pointer } from "bun:ffi";
import { userInfo } from "node:os";
import { currentPlatform } from "./system";

export function policyPrincipal(): string {
  if (currentPlatform() !== "windows") {
    const uid = userInfo().uid;
    if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("Identité native du compte invérifiable.");
    return `uid:${uid}`;
  }
  const kernel = dlopen("kernel32.dll", { CloseHandle: { args: ["u64"], returns: "i32" } });
  const tokens = dlopen("advapi32.dll", {
    OpenProcessToken: { args: ["u64", "u32", "buffer"], returns: "i32" },
    GetTokenInformation: { args: ["u64", "u32", "buffer", "u32", "buffer"], returns: "i32" },
    IsValidSid: { args: ["ptr"], returns: "i32" },
    GetLengthSid: { args: ["ptr"], returns: "u32" },
    CopySid: { args: ["u32", "buffer", "ptr"], returns: "i32" },
  });
  let handle = 0n;
  try {
    const output = Buffer.alloc(8);
    if (!tokens.symbols.OpenProcessToken(0xffffffffffffffffn, 8, output)) throw new Error("Identité native du compte invérifiable.");
    handle = output.readBigUInt64LE();
    const info = Buffer.alloc(1024);
    const length = Buffer.alloc(4);
    if (!tokens.symbols.GetTokenInformation(handle, 1, info, info.length, length) || length.readUInt32LE() > info.length) throw new Error("Identité native du compte invérifiable.");
    const pointer = Number(info.readBigUInt64LE()) as Pointer;
    if (!Number.isSafeInteger(pointer) || !tokens.symbols.IsValidSid(pointer)) throw new Error("Identité native du compte invérifiable.");
    const size = tokens.symbols.GetLengthSid(pointer);
    if (size < 8 || size > 68) throw new Error("Identité native du compte invérifiable.");
    const sid = Buffer.alloc(size);
    if (!tokens.symbols.CopySid(size, sid, pointer)) throw new Error("Identité native du compte invérifiable.");
    return `sid:${sid.toString("hex")}`;
  } finally {
    if (handle !== 0n) kernel.symbols.CloseHandle(handle);
    tokens.close();
    kernel.close();
  }
}
