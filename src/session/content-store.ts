// Implements: SPEC-SES-017 (CA-01/02, immutable content references and transparent reading).
// Supports: SPEC-IHM-010, SPEC-MOT-006, SPEC-SES-016; gap E-162.
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { currentPlatform, realPathOrSelf } from "../platform/system";
import { writeAtomic } from "../tools/text-file";
import { tryFileLock } from "../platform/file-lock";
import { encryptedStore, storeRead, storeWrite, storeExists, storeFileLock } from "./private-storage";
import { ArchiveFailure } from "./archive-crypto";

interface ContentReference { readonly $contentRef: string; readonly encoding: "utf8" | "base64" }
const MAX_BYTES = 20 * 1024 * 1024;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function reference(value: unknown): value is ContentReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 2 && typeof row["$contentRef"] === "string" && /^[a-f0-9]{64}$/.test(row["$contentRef"]) && (row["encoding"] === "utf8" || row["encoding"] === "base64");
}
export class ContentStore {
  readonly root: string;
  constructor(root: string, readonly inlineThreshold = 4000) { this.root = resolve(root); }
  static forTranscript(path: string): ContentStore { return new ContentStore(join(dirname(dirname(dirname(path))), "content")); }
  withLock<T>(action: () => T): T {
    if (encryptedStore(this.root)) { const release = storeFileLock(join(this.root, ".references.lock")); if (!release) throw new Error("Content references are busy."); try { return action(); } finally { release(); } }
    this.#path("0".repeat(64)); mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const lock = join(this.root, ".references.lock");
    if (existsSync(lock)) { const stat = lstatSync(lock); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Invalid content lease."); }
    const release = tryFileLock(lock); if (!release) throw new Error("Content references are busy.");
    try { return action(); } finally { release(); }
  }
  /** The lease covers the blob and its published reference, so collection cannot race an adoption. */
  publish<T>(value: unknown, action: (encoded: unknown) => T): T {
    const needed = (part: unknown, depth = 0): boolean => depth > 8 || typeof part === "string" && part.length > this.inlineThreshold || !!part && typeof part === "object" && (["image", "document"].includes(String((part as Record<string, unknown>)["type"])) || Object.values(part).some(item => needed(item, depth + 1)));
    return needed(value) ? this.withLock(() => action(this.encode(value))) : action(value);
  }
  #path(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid content reference.");
    let ancestor = this.root;
    while (true) {
      try { const stat = lstatSync(ancestor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Linked content store."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parent = dirname(ancestor); if (parent === ancestor) break; ancestor = parent;
    }
    const path = join(this.root, hash + ".blob");
    if (realPathOrSelf(path) !== path) throw new Error("Linked content path.");
    try { const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Content has a foreign physical name."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    return path;
  }
  #get(hash: string): Buffer {
    if (encryptedStore(this.root)) { const bytes = storeRead(join(this.root, hash + ".blob")); if (bytes.length > MAX_BYTES || digest(bytes) !== hash) throw new Error("Altered content."); return bytes; }
    const path = this.#path(hash), fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Error("Invalid content size.");
      const bytes = Buffer.alloc(stat.size);
      for (let offset = 0; offset < bytes.length;) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error("Incomplete content."); offset += n; }
      const after = fstatSync(fd), named = lstatSync(this.#path(hash));
      if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || named.dev !== stat.dev || named.ino !== stat.ino || digest(bytes) !== hash) throw new Error("Altered content.");
      return bytes;
    } finally { closeSync(fd); }
  }
  #put(bytes: Buffer, encoding: ContentReference["encoding"]): ContentReference {
    if (bytes.length > MAX_BYTES) throw new Error("Content size exceeds its bound.");
    const hash = digest(bytes), path = this.#path(hash);
    if (encryptedStore(this.root)) { if (storeExists(path)) this.#get(hash); else storeWrite(path, bytes); return { $contentRef: hash, encoding }; }
    if (existsSync(path)) this.#get(hash);
    else { mkdirSync(this.root, { recursive: true, mode: 0o700 }); this.#path(hash); writeAtomic(path, bytes, currentPlatform(), true); this.#get(hash); }
    return { $contentRef: hash, encoding };
  }
  /** Only user input and input history call this; model-native messages remain verbatim. */
  encode(value: unknown, depth = 0): unknown {
    if (depth > 8) throw new Error("Content nesting exceeds its bound.");
    if (typeof value === "string") return value.length > this.inlineThreshold ? this.#put(Buffer.from(value), "utf8") : value;
    if (Array.isArray(value)) { if (value.length > 1024) throw new Error("Too many content parts."); return value.map(part => this.encode(part, depth + 1)); }
    if (!value || typeof value !== "object") return value;
    const row = value as Record<string, unknown>;
    if (["image", "document"].includes(String(row["type"])) && typeof row["dataBase64"] === "string") {
      const bytes = Buffer.from(row["dataBase64"], "base64"); if (bytes.toString("base64") !== row["dataBase64"]) throw new Error("Invalid image encoding.");
      return { ...row, dataBase64: this.#put(bytes, "base64") };
    }
    return Object.fromEntries(Object.entries(row).map(([key, part]) => [key, this.encode(part, depth + 1)]));
  }
  decode(value: unknown): unknown {
    let remaining = 50 * 1024 * 1024;
    const walk = (part: unknown, depth: number): unknown => {
      if (depth > 8) throw new Error("Content nesting exceeds its bound.");
      if (reference(part)) {
        try { const bytes = this.#get(part.$contentRef); remaining -= bytes.length; if (remaining < 0) throw new Error("Resolved content exceeds its bound."); return bytes.toString(part.encoding); }
        catch (error) { if (error instanceof ArchiveFailure) throw error; return "[Stored content unavailable.]"; }
      }
      if (Array.isArray(part)) { if (part.length > 1024) throw new Error("Too many content parts."); return part.map(item => walk(item, depth + 1)); }
      if (!part || typeof part !== "object") return part;
      const row = Object.fromEntries(Object.entries(part).map(([key, item]) => [key, walk(item, depth + 1)]));
      return ["image", "document"].includes(String(row["type"])) && row["dataBase64"] === "[Stored content unavailable.]" ? { type: "text", text: row["type"] === "document" ? "[Stored document unavailable.]" : "[Stored image unavailable.]" } : row;
    };
    return walk(value, 0);
  }
  /** A bounded, complete scan is required before deleting any unreferenced, hash-verified blob. */
  collect(sessionsDir: string, historyPath: string): number {
    if (encryptedStore(this.root)) return 0; // Retention never deletes an encrypted blob on an incomplete reference inventory.
    if (!existsSync(this.root)) return 0;
    return this.withLock(() => {
      const referenced = new Set<string>(), deadline = Date.now() + 200, files: string[] = [historyPath]; let total = 0;
      const scan = (dir: string, depth: number): void => {
        if (depth > 1 || Date.now() > deadline || files.length > 10_000) throw new Error("Content reference scan is incomplete.");
        if (!existsSync(dir)) return;
        const directory = lstatSync(dir); if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Linked reference directory.");
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name); if (entry.isSymbolicLink()) throw new Error("Linked reference store.");
          if (entry.isDirectory() && depth < 1) scan(path, depth + 1); else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
        }
      };
      scan(sessionsDir, 0);
      for (const path of files) {
        if (!existsSync(path)) continue;
        const namedBefore = lstatSync(path); if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.nlink !== 1) throw new Error("Invalid reference file.");
        const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const stat = fstatSync(fd); total += stat.size;
          if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== namedBefore.dev || stat.ino !== namedBefore.ino || total > 50 * 1024 * 1024 || Date.now() > deadline) throw new Error("Content reference scan is incomplete.");
          const bytes = Buffer.alloc(stat.size); let offset = 0;
          while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) throw new Error("Incomplete reference file."); offset += n; }
          for (const match of bytes.toString("utf8").matchAll(/"\$contentRef"\s*:\s*"([a-f0-9]{64})"/g)) referenced.add(match[1]!);
          const after = fstatSync(fd), namedAfter = lstatSync(path);
          if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || namedAfter.dev !== stat.dev || namedAfter.ino !== stat.ino || namedAfter.isSymbolicLink() || namedAfter.nlink !== 1) throw new Error("References changed during collection.");
        } finally { closeSync(fd); }
      }
      if (Date.now() > deadline) throw new Error("Content reference scan is incomplete.");
      let removed = 0;
      const names = readdirSync(this.root); if (names.length > 10_000) throw new Error("Content collection exceeds its bound.");
      for (const name of names) {
        if (Date.now() > deadline) break;
        const hash = /^([a-f0-9]{64})\.blob$/.exec(name)?.[1]; if (!hash || referenced.has(hash)) continue;
        const path = this.#path(hash), before = lstatSync(path); this.#get(hash);
        const after = lstatSync(this.#path(hash));
        if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("Content changed before collection.");
        unlinkSync(path); removed++;
      }
      return removed;
    });
  }
}
