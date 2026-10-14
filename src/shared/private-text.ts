// Supports: SPEC-MOT-036/040 (bounded private text reads), SPEC-SES-001 (ordinary physical files), gap E-163.
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { realPathOrSelf } from "../platform/system";
export function ordinaryPrivateFile(input: string, maxBytes: number): void {
  const path = resolve(input); let ancestor = dirname(path);
  for (;;) { if (existsSync(ancestor)) { const stat = lstatSync(ancestor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Linked private directory."); } const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent; }
  if (realPathOrSelf(path) !== path) throw new Error("Linked private path.");
  if (existsSync(path)) { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("Invalid private file."); }
}
export function readPrivateSnapshot(input: string, maxBytes: number): { text: string; modifiedMs: number; size: number } {
  const path = resolve(input); ordinaryPrivateFile(path, maxBytes);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("Invalid private text size.");
    const bytes = Buffer.alloc(stat.size); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error("Incomplete private text."); offset += n; }
    const after = fstatSync(fd), named = lstatSync(path);
    if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || named.isSymbolicLink() || named.nlink !== 1 || named.dev !== stat.dev || named.ino !== stat.ino) throw new Error("Private text changed during reading.");
    return { text: bytes.toString("utf8"), modifiedMs: stat.mtimeMs, size: stat.size };
  } finally { closeSync(fd); }
}
export function readPrivateText(input: string, maxBytes: number): string { return readPrivateSnapshot(input, maxBytes).text; }
