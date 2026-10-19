// Implements: SPEC-PER-015 (Linux namespaces, bounded writable mounts and no host Unix-socket bypass).
import { dlopen } from "bun:ffi";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { currentPlatform, findExecutable, isWithin } from "./system";
export interface SandboxFiles {
  readonly writable: readonly string[];
  readonly readable?: readonly string[];
  readonly hidden: readonly string[];
  readonly readonly?: readonly string[];
  readonly readDenied: (path: string) => boolean;
  readonly writeDenied: (path: string) => boolean;
}
export interface SandboxLaunch {
  readonly file: string; readonly args: string[]; readonly environment: Readonly<Record<string, string>>; readonly fds: readonly number[];
  spawned(): void; close(): void;
  readonly violations?: readonly string[];
}
/** x86-64 only: reject alternate ABIs, host IPC, new namespaces and asynchronous syscall bypasses. */
export function sandboxSeccomp(): Buffer {
  const instructions: Array<[number, number, number, number]> = [
    [0x20, 0, 0, 4], [0x15, 1, 0, 0xc000003e], [0x06, 0, 0, 0x80000000],
    [0x20, 0, 0, 0], [0x35, 0, 1, 0x40000000], [0x06, 0, 0, 0x50001],
  ];
  for (const syscall of [101, 155, 161, 165, 166, 248, 249, 250, 272, 298, 303, 304, 308, 310, 311, 321, 323, 425, 426, 427, 438]) instructions.push([0x15, 0, 1, syscall], [0x06, 0, 0, 0x50001]);
  // The runtime uses connected stream pairs to spawn children. Datagram pairs could be disconnected and retargeted.
  instructions.push([0x15, 0, 6, 53], [0x20, 0, 0, 24], [0x54, 0, 0, 15], [0x15, 2, 0, 1], [0x15, 1, 0, 5], [0x06, 0, 0, 0x50001], [0x06, 0, 0, 0x7fff0000]);
  instructions.push([0x15, 0, 5, 41], [0x20, 0, 0, 16], [0x15, 2, 0, 2], [0x15, 1, 0, 10], [0x06, 0, 0, 0x50001], [0x06, 0, 0, 0x7fff0000], [0x06, 0, 0, 0x7fff0000]);
  const bytes = Buffer.alloc(instructions.length * 8);
  instructions.forEach(([code, yes, no, value], index) => { const at = index * 8; bytes.writeUInt16LE(code, at); bytes[at + 2] = yes; bytes[at + 3] = no; bytes.writeUInt32LE(value, at + 4); });
  return bytes;
}
const native = () => dlopen("libc.so.6", { memfd_create: { args: ["buffer", "u32"], returns: "i32" }, socketpair: { args: ["i32", "i32", "i32", "buffer"], returns: "i32" } });
let libc: ReturnType<typeof native> | undefined;
export function sandboxSocketPair(): [number, number] {
  const result = Buffer.alloc(8), api = libc ??= native();
  if (api.symbols.socketpair(1, 0x80801, 0, result) !== 0) throw Error("Sandbox channel unavailable.");
  return [result.readInt32LE(), result.readInt32LE(4)];
}
export function sandboxUnavailable(): string | undefined {
  if (currentPlatform() !== "linux" || process.arch !== "x64") return "System sandbox unavailable: only native Linux x64 is verified.";
  if (!findExecutable("bwrap")) return "System sandbox unavailable: bubblewrap (bwrap) is missing.";
  return undefined;
}
/** Host paths are pinned by directory descriptors; symlinks and shared writable inodes never enlarge a mount. */
export function sandboxLaunch(input: { files: SandboxFiles; cwd: string; file: string; args: readonly string[]; environment: Readonly<Record<string, string>>; channel?: number; runtime?: string }): SandboxLaunch {
  const unavailable = sandboxUnavailable(); if (unavailable) throw Error(unavailable);
  const owned: number[] = [], extra: number[] = input.channel === undefined ? [] : [input.channel];
  const descriptor = (fd: number) => { owned.push(fd); extra.push(fd); return String(extra.length + 2); };
  const args = ["--unshare-all", "--unshare-user", "--disable-userns", "--new-session", "--die-with-parent", "--cap-drop", "ALL"];
  const close = () => { for (const fd of owned.splice(0)) closeSync(fd); };
  try {
    const api = libc ??= native(), filter = api.symbols.memfd_create(Buffer.from("sandbox-filter\0"), 1);
    if (filter < 0) throw Error("Sandbox syscall filter unavailable.");
    writeSync(filter, sandboxSeccomp(), 0, sandboxSeccomp().length, 0); args.push("--seccomp", descriptor(filter));
    for (const path of ["/usr", "/bin", "/sbin", "/lib", "/lib64"]) if (existsSync(path)) args.push("--ro-bind", path, path);
    args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run", "--dir", "/etc");
    for (const path of ["/etc/ssl", "/etc/alternatives", "/etc/ld.so.cache", "/etc/localtime", "/etc/passwd", "/etc/group", "/etc/nsswitch.conf"]) if (existsSync(path)) args.push("--ro-bind", path, path);
    if (input.runtime) args.push("--ro-bind", realpathSync(input.runtime), "/sandbox-runtime");
    const roots = [...new Set([...input.files.writable, ...(input.files.readable ?? [])].filter(existsSync).map(path => realpathSync(path)))];
    if (!roots.some(root => isWithin(input.cwd, root, "linux"))) throw Error("Sandbox working directory is outside its declared roots.");
    const exposed = [...roots, "/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
    const absentReadonly: string[] = [];
    const restrictions = (paths: readonly string[], hiding = false) => paths.flatMap(path => {
      if (!exposed.some(root => isWithin(path, root, "linux") || isWithin(root, path, "linux"))) return [];
      // An absent denied name must not become writable when the command creates it.
      const missing = !existsSync(path);
      while (!existsSync(path) && dirname(path) !== path) path = dirname(path);
      if (missing && hiding) { absentReadonly.push(path, realpathSync(path)); return []; }
      return [...new Set([path, realpathSync(path)])];
    });
    const hiddenRoots = restrictions(input.files.hidden, true), readonlyRoots = [...restrictions(input.files.readonly ?? []), ...absentReadonly];
    const masks: Array<{ path: string; hide: boolean; directory: boolean }> = []; let inspected = 0;
    const inspect = (path: string) => {
      if (++inspected > 100000) throw Error("Sandbox profile exceeds its bounded file capacity.");
      const stat = lstatSync(path);
      const hidden = input.files.readDenied(path) || hiddenRoots.some(root => isWithin(path, root, "linux"));
      if (hidden) { masks.push({ path, hide: true, directory: stat.isDirectory() }); return; }
      if (stat.isSymbolicLink()) return;
      // A second name can alias a sensitive inode under another lexical path. Hide shared files, including reads.
      if (stat.isFile() && stat.nlink !== 1) { masks.push({ path, hide: true, directory: false }); return; }
      if (input.files.writeDenied(path) || readonlyRoots.some(root => isWithin(path, root, "linux")) || stat.isFile() && input.runtime !== undefined && realpathSync(path) === realpathSync(input.runtime)) masks.push({ path, hide: false, directory: stat.isDirectory() });
      if (stat.isDirectory()) for (const name of readdirSync(path)) inspect(join(path, name));
      else if (!stat.isFile()) masks.push({ path, hide: true, directory: false });
    };
    for (const root of roots) {
      if (!isAbsolute(root) || dirname(root) === root) throw Error("Sandbox filesystem root cannot be granted.");
      const fd = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), stat = fstatSync(fd);
      if (!stat.isDirectory()) { closeSync(fd); throw Error("Sandbox mount must be a physical directory."); }
      args.push(input.files.writable.some(path => isWithin(root, realpathSync(path), "linux")) ? "--bind-fd" : "--ro-bind-fd", descriptor(fd), root);
      inspect(root);
    }
    for (const [paths, hide] of [[hiddenRoots, true], [readonlyRoots, false]] as const) for (const path of paths) {
      if (path === "/") throw Error("Sandbox cannot satisfy a blanket filesystem restriction.");
      if (!masks.some(mask => mask.path === path)) masks.push({ path, hide, directory: lstatSync(path).isDirectory() });
    }
    let empty: string | undefined;
    for (const mask of masks) {
      if (mask.hide) {
        if (mask.directory) args.push("--perms", "0000", "--tmpfs", mask.path, "--remount-ro", mask.path);
        else {
          if (empty === undefined) { const fd = api.symbols.memfd_create(Buffer.from("sandbox-hidden\0"), 1); if (fd < 0) throw Error("Sandbox hidden-file guard unavailable."); empty = descriptor(fd); }
          args.push("--perms", "0000", "--ro-bind-data", empty, mask.path);
        }
      } else args.push("--ro-bind", mask.path, mask.path);
    }
    // Start the native helper at an empty root so its runtime cannot autoload project environment/configuration.
    args.push("--remount-ro", "/", "--chdir", input.runtime ? "/" : input.cwd, "--", input.file, ...input.args);
    return { file: findExecutable("bwrap")!, args, environment: input.environment, fds: extra, spawned: close, close };
  } catch (error) { close(); throw error; }
}
