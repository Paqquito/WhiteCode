// Supports: SPEC-SES-001 (per-session storage ownership and atomic activation), gap E-181.
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { tryFileLock } from "../platform/file-lock";
import type { StorageAccess } from "./storage-access";
export interface PrivateContext {
  root?: string;
  store?: StorageAccess;
  temporary?: Array<{ root: string; store: StorageAccess }>;
  closed?: boolean;
  references?: Map<string, string>;
}
export const privateContext = new AsyncLocalStorage<PrivateContext>();
export const privateDirectories = new Set([
  "sessions",
  "content",
  "memory",
  "agent-memory",
  "team-memory",
  "teams",
  "background-sessions",
  "session-analysis",
  "api-references",
]);
const files = new Set(["input-history.jsonl", "debug.log"]);
export const archiveMarker = (root: string) =>
  join(root, "archives-v1", "index");
/** Even an absent index cannot turn an existing encrypted profile back into a plaintext profile. */
export function privateArchivePresent(root: string): boolean {
  const directory = join(root, "archives-v1");
  if (!fs.existsSync(directory)) return false;
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return true;
  return fs.readdirSync(directory).some((name) => {
    if (!/^(?:lock-[a-f0-9]{64}|index\.archive-lock)$/.test(name)) return true;
    const lock = fs.lstatSync(join(directory, name));
    return (
      !lock.isFile() ||
      lock.isSymbolicLink() ||
      lock.nlink !== 1 ||
      lock.size !== 0
    );
  });
}
export function relativeStorePath(
  root: string,
  path: string,
): string | undefined {
  const rel = relative(root, resolve(path));
  return rel && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(".." + sep)
    ? rel.split(sep).join("/")
    : undefined;
}
export function coveredStorePath(rel: string): boolean {
  return (
    privateDirectories.has(rel.split("/")[0]!) ||
    files.has(rel.split("/")[0]!.replace(/\.(tmp.*|illisible-.*)$/, ""))
  );
}
export function privateStorageScope<T>(action: () => T): T {
  return privateContext.run({}, action);
}
export function privateAccess(path: string): StorageAccess | undefined {
  const ctx = privateContext.getStore();
  const temporary = ctx?.temporary?.find(
    (row) => resolve(path) === row.root || relativeStorePath(row.root, path),
  );
  if (temporary) {
    if (ctx?.closed) throw new Error("Accès au magasin terminé.");
    return temporary.store;
  }
  if (!ctx?.root) return undefined;
  const rel = relativeStorePath(ctx.root, path);
  if (!rel || !coveredStorePath(rel)) return undefined;
  if (ctx.closed) throw new Error("Accès au magasin terminé.");
  if (!ctx.store && privateArchivePresent(ctx.root))
    throw new Error("Le magasin est désormais chiffré : rouvrez la session.");
  return ctx.store;
}
export function encryptedStore(path: string): boolean {
  return !!privateAccess(path);
}
export function privateStat(path: string): fs.Stats {
  return privateAccess(path)?.stat(path) ?? fs.lstatSync(path);
}
export function guardedStoreWrite(
  path: string,
  bytes: Uint8Array,
  plain: () => void,
  append = false,
  exclusive = false,
): void {
  const store = privateAccess(path);
  if (store) {
    store.write(path, Buffer.from(bytes), append, exclusive);
    return;
  }
  const ctx = privateContext.getStore(),
    rel = ctx?.root && relativeStorePath(ctx.root, path);
  if (!ctx?.root || !rel || !coveredStorePath(rel)) {
    plain();
    return;
  }
  fs.mkdirSync(ctx.root, { recursive: true, mode: 0o700 });
  const release = tryFileLock(join(ctx.root, "archive-store.lock"));
  if (!release) throw new Error("Magasin privé occupé.");
  try {
    privateAccess(path);
    plain();
  } finally {
    release();
  }
}
