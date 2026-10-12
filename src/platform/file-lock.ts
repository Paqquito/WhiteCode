// Supports: SPEC-CFG-010 (EF-03, FA-02): kernel-held lock released on normal close or process termination.
import { closeSync, constants, fstatSync, openSync } from "node:fs";
import { dlopen, read } from "bun:ffi";
import { arch } from "node:os";
import { toNamespacedPath } from "node:path";
import { currentPlatform } from "./system";

const openWindows = () => dlopen("kernel32.dll", {
  CreateFileW: { args: ["buffer", "u32", "u32", "ptr", "u32", "u32", "ptr"], returns: "u64" },
  CloseHandle: { args: ["u64"], returns: "i32" },
  GetLastError: { args: [], returns: "u32" },
  GetFileInformationByHandle: { args: ["u64", "buffer"], returns: "i32" },
});
const openPosix = () => {
  const symbols = { flock: { args: ["i32", "i32"], returns: "i32" } } as const;
  if (currentPlatform() === "macos") {
    const library = dlopen("/usr/lib/libSystem.B.dylib", { ...symbols, __error: { args: [], returns: "ptr" } });
    return { library, errno: library.symbols.__error };
  }
  const definitions = { ...symbols, __errno_location: { args: [], returns: "ptr" } } as const;
  const library = (() => {
    try { return dlopen("libc.so.6", definitions); }
    catch { return dlopen(`/lib/ld-musl-${arch() === "arm64" ? "aarch64" : "x86_64"}.so.1`, definitions); }
  })();
  return { library, errno: library.symbols.__errno_location };
};
let windows: ReturnType<typeof openWindows> | undefined;
let posix: ReturnType<typeof openPosix> | undefined;

/** The empty lock file stays in place: unlinking a locked inode would let writers lock different files. */
export function tryFileLock(path: string): (() => void) | undefined {
  if (currentPlatform() === "windows") {
    const api = (windows ??= openWindows()).symbols;
    const handle = api.CreateFileW(Buffer.from(toNamespacedPath(path) + "\0", "utf16le"), 0xc0000000, 0, null, 4, 0x200080, null);
    if (handle === 0xffffffffffffffffn) {
      const code = api.GetLastError();
      if (code === 32 || code === 33) return undefined;
      throw new Error(`Impossible d'acquérir le verrou de fichier (Windows ${code}).`);
    }
    const info = Buffer.alloc(52);
    if (!api.GetFileInformationByHandle(handle, info) || (info.readUInt32LE() & 0x410) !== 0) {
      api.CloseHandle(handle);
      throw new Error("Le verrou doit être un fichier ordinaire sans lien.");
    }
    return () => { if (!api.CloseHandle(handle)) throw new Error("Impossible de libérer le verrou de fichier."); };
  }
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Le verrou doit être un fichier ordinaire sans lien.");
    const api = posix ??= openPosix();
    if (api.library.symbols.flock(fd, 2 | 4) === 0) return () => closeSync(fd);
    const pointer = api.errno();
    const code = pointer === null ? 0 : read.i32(pointer);
    if (code !== (currentPlatform() === "macos" ? 35 : 11) && code !== 4) throw new Error(`Impossible d'acquérir le verrou de fichier (POSIX ${code}).`);
    closeSync(fd);
    return undefined;
  } catch (error) { closeSync(fd); throw error; }
}
