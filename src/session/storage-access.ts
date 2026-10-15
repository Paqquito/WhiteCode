// Supports: SPEC-SES-001 (authorized storage), SPEC-SES-012 (sensitive temporary data stays in memory), gap E-181.
import { Stats, constants } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
export interface StoreWalk {
  files: Array<{ path: string; relativePath: string; stats: Stats }>;
  timedOut: boolean;
}
export interface StorageAccess {
  read(path: string): Buffer;
  write(
    path: string,
    bytes: Buffer,
    append?: boolean,
    exclusive?: boolean,
  ): void;
  exists(path: string): boolean;
  list(path: string): string[];
  stat(path: string): Stats;
  remove(path: string, recursive?: boolean): void;
  rename(from: string, to: string): void;
  walk(
    path: string,
    deadline: number,
    signal: AbortSignal,
    accept: (relative: string) => boolean,
  ): StoreWalk;
  reference(path: string): string;
  resolveReference(reference: string): string | undefined;
  lock(path: string): (() => void) | undefined;
  close(): void;
}
interface MemoryFile {
  readonly bytes: Buffer;
  readonly modified: number;
  readonly id: string;
}
export class TemporaryStorage implements StorageAccess {
  readonly #files = new Map<string, MemoryFile>();
  readonly #locks = new Set<string>();
  readonly #references = new Map<string, string>();
  #closed = false;
  #bytes = 0;
  #version = Date.now();
  constructor(readonly root: string) {}
  #path(input: string): string {
    if (this.#closed) throw new Error("Magasin temporaire fermé.");
    const path = resolve(input),
      rel = relative(this.root, path);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep))
      throw new Error("Chemin temporaire hors session.");
    return path;
  }
  read(path: string): Buffer {
    const file = this.#files.get(this.#path(path));
    if (!file)
      throw Object.assign(new Error("Fichier temporaire absent."), {
        code: "ENOENT",
      });
    return Buffer.from(file.bytes);
  }
  write(input: string, bytes: Buffer, append = false, exclusive = false): void {
    const path = this.#path(input),
      old = this.#files.get(path);
    if (old && exclusive)
      throw Object.assign(new Error("Fichier temporaire existant."), {
        code: "EEXIST",
      });
    const value =
        append && old ? Buffer.concat([old.bytes, bytes]) : Buffer.from(bytes),
      total = this.#bytes - (old?.bytes.length ?? 0) + value.length;
    if (total > 64 * 1024 * 1024 || (!old && this.#files.size >= 10000))
      throw new Error("Magasin temporaire plein : aucun repli sur disque.");
    this.#files.set(path, {
      bytes: value,
      modified: ++this.#version,
      id: old?.id ?? randomBytes(32).toString("hex"),
    });
    this.#bytes = total;
  }
  exists(path: string): boolean {
    this.#path(join(path, ".probe"));
    return (
      this.#files.has(resolve(path)) ||
      [...this.#files.keys()].some((file) =>
        file.startsWith(resolve(path) + sep),
      )
    );
  }
  list(path: string): string[] {
    this.#path(join(path, ".probe"));
    const prefix = resolve(path) + sep;
    return [
      ...new Set(
        [...this.#files.keys()]
          .filter((file) => file.startsWith(prefix))
          .map((file) => file.slice(prefix.length).split(sep)[0]!),
      ),
    ].sort();
  }
  stat(input: string): Stats {
    const path = resolve(input),
      file = this.#files.get(path);
    if (!file && !this.exists(path))
      throw Object.assign(new Error("Fichier temporaire absent."), {
        code: "ENOENT",
      });
    return Object.assign(Object.create(Stats.prototype) as Stats, {
      mode: (file ? constants.S_IFREG : constants.S_IFDIR) | 0o600,
      size: file?.bytes.length ?? 0,
      mtimeMs: file?.modified ?? this.#version,
      mtime: new Date(file?.modified ?? this.#version),
      nlink: 1,
      dev: 0,
      ino: 0,
    });
  }
  remove(input: string, recursive = false): void {
    const path = this.#path(input);
    for (const [file, row] of this.#files)
      if (file === path || (recursive && file.startsWith(path + sep))) {
        row.bytes.fill(0);
        this.#bytes -= row.bytes.length;
        this.#files.delete(file);
      }
  }
  rename(from: string, to: string): void {
    this.write(to, this.read(from));
    this.remove(from);
  }
  walk(
    path: string,
    deadline: number,
    signal: AbortSignal,
    accept: (relative: string) => boolean,
  ): StoreWalk {
    const prefix = resolve(path) + sep,
      files: StoreWalk["files"] = [];
    for (const file of this.#files.keys()) {
      if (Date.now() > deadline || signal.aborted)
        return { files, timedOut: true };
      if (
        file.startsWith(prefix) &&
        accept(file.slice(prefix.length).split(sep).join("/"))
      )
        files.push({
          path: file,
          relativePath: file.slice(prefix.length),
          stats: this.stat(file),
        });
    }
    return { files, timedOut: false };
  }
  reference(input: string): string {
    const path = this.#path(input);
    let id = this.#references.get(path);
    if (!id) {
      id = "archive:v1:" + randomBytes(32).toString("hex");
      this.#references.set(path, id);
    }
    return id;
  }
  resolveReference(reference: string): string | undefined {
    return [...this.#references].find(([, id]) => id === reference)?.[0];
  }
  lock(path: string): (() => void) | undefined {
    this.#path(path);
    if (this.#locks.has(path)) return undefined;
    this.#locks.add(path);
    return () => {
      this.#locks.delete(path);
    };
  }
  close(): void {
    for (const row of this.#files.values()) row.bytes.fill(0);
    this.#files.clear();
    this.#references.clear();
    this.#closed = true;
  }
}
