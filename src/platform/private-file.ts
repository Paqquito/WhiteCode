// Supports: SPEC-CFG-010 (§ 12), SPEC-PER-027 (EF-02): owner-only access before any private bytes are written.
import { chmodSync } from "node:fs";
import { dirname, join, toNamespacedPath } from "node:path";
import { runToCompletion } from "./process";
import { currentPlatform } from "./system";
import { dlopen } from "bun:ffi";

const openAclApi = () => ({
  security: dlopen("advapi32.dll", {
    ConvertStringSecurityDescriptorToSecurityDescriptorW: { args: ["buffer", "u32", "buffer", "ptr"], returns: "i32" },
    GetSecurityDescriptorDacl: { args: ["ptr", "buffer", "buffer", "buffer"], returns: "i32" },
    SetNamedSecurityInfoW: { args: ["buffer", "u32", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "u32" },
  }),
  memory: dlopen("kernel32.dll", {
    LocalFree: { args: ["ptr"], returns: "ptr" }, GetWindowsDirectoryW: { args: ["buffer", "u32"], returns: "u32" },
    CreateFileW: { args: ["buffer", "u32", "u32", "buffer", "u32", "u32", "ptr"], returns: "u64" },
    WriteFile: { args: ["u64", "buffer", "u32", "buffer", "ptr"], returns: "i32" },
    FlushFileBuffers: { args: ["u64"], returns: "i32" }, CloseHandle: { args: ["u64"], returns: "i32" },
    GetLastError: { args: [], returns: "u32" },
  }),
});
let aclApi: ReturnType<typeof openAclApi> | undefined;

let ownerSid: string | undefined;
let windowsRoot: string | undefined;
function ownerDescriptor(path: string): bigint {
  const native = aclApi ??= openAclApi();
  if (!windowsRoot) {
    const directory = Buffer.alloc(32768 * 2);
    const count = native.memory.symbols.GetWindowsDirectoryW(directory, 32768);
    if (!count || count >= 32768) throw new Error("Impossible de déterminer le dossier système pour protéger le fichier.");
    windowsRoot = directory.subarray(0, count * 2).toString("utf16le");
  }
  const root = windowsRoot;
  const env = { SystemRoot: root, PATH: join(root, "System32") };
  if (!ownerSid) {
    const result = runToCompletion(join(root, "System32/whoami.exe"), ["/user", "/fo", "csv", "/nh"], { cwd: dirname(path), env, timeoutMs: 5000 });
    ownerSid = result.code === 0 ? /S-1-\d+(?:-\d+)+/.exec(result.stdout)?.[0] : undefined;
    if (!ownerSid) throw new Error("Impossible d'identifier le propriétaire du fichier privé.");
  }
  const descriptor = Buffer.alloc(8);
  if (!native.security.symbols.ConvertStringSecurityDescriptorToSecurityDescriptorW(Buffer.from(`D:P(A;;FA;;;${ownerSid})\0`, "utf16le"), 1, descriptor, null)) throw new Error("Impossible de préparer les droits du fichier privé.");
  const pointer = descriptor.readBigUInt64LE();
  return pointer;
}

export function restrictFileToOwner(path: string): void {
  if (currentPlatform() !== "windows") { chmodSync(path, 0o600); return; }
  const pointer = ownerDescriptor(path);
  const native = aclApi!;
  try {
    const present = Buffer.alloc(4), dacl = Buffer.alloc(8), defaulted = Buffer.alloc(4);
    if (!native.security.symbols.GetSecurityDescriptorDacl(pointer, present, dacl, defaulted) || present.readUInt32LE() === 0 || dacl.readBigUInt64LE() === 0n) throw new Error("Liste de droits privés invalide.");
    // SE_FILE_OBJECT, DACL_SECURITY_INFORMATION and PROTECTED_DACL_SECURITY_INFORMATION.
    if (native.security.symbols.SetNamedSecurityInfoW(Buffer.from(toNamespacedPath(path) + "\0", "utf16le"), 1, 0x80000004, null, null, dacl.readBigUInt64LE(), null) !== 0) throw new Error("Impossible de restreindre les droits du fichier à son propriétaire.");
  } finally { native.memory.symbols.LocalFree(pointer); }
}

/** Windows applies the private DACL during CREATE_NEW, before any other process can open the file. */
export function writeNewPrivateWindowsFile(path: string, bytes: Uint8Array): void {
  const descriptor = ownerDescriptor(path);
  const api = aclApi!.memory.symbols;
  const attributes = Buffer.alloc(24);
  attributes.writeUInt32LE(24); attributes.writeBigUInt64LE(descriptor, 8);
  let handle: bigint | undefined;
  try {
    const value = api.CreateFileW(Buffer.from(toNamespacedPath(path) + "\0", "utf16le"), 0x40000000, 0, attributes, 1, 0x80, null);
    if (value === 0xffffffffffffffffn) throw new Error(`Création du fichier privé refusée (Windows ${api.GetLastError()}).`);
    handle = value;
    const written = Buffer.alloc(4);
    for (let offset = 0; offset < bytes.length;) {
      const chunk = bytes.subarray(offset, Math.min(bytes.length, offset + 0x1000000));
      if (!api.WriteFile(handle, chunk, chunk.length, written, null) || !written.readUInt32LE()) throw new Error(`Écriture du fichier privé refusée (Windows ${api.GetLastError()}).`);
      offset += written.readUInt32LE();
    }
    if (!api.FlushFileBuffers(handle)) throw new Error(`Synchronisation du fichier privé refusée (Windows ${api.GetLastError()}).`);
  } finally {
    if (handle !== undefined) api.CloseHandle(handle);
    api.LocalFree(descriptor);
  }
}
