// Supports: SPEC-SES-001 (§ 5.7 protected inventory and in-memory access), SPEC-PER-027 (independent archive key), gap E-181.
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import {
  ArchiveFailure,
  openArchiveKeys,
  type ArchiveKeys,
} from "./archive-crypto";
import { ArchiveFiles } from "./archive-files";
import type { CredentialVault } from "../platform/credential-vault";
import { tryFileLock } from "../platform/file-lock";
import { comparablePath, realPathOrSelf } from "../platform/system";
import { TemporaryStorage } from "./storage-access";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
import {
  privateContext as context,
  relativeStorePath as within,
  coveredStorePath as covered,
  archiveMarker as marker,
  privateAccess as access,
  privateArchivePresent,
  encryptedStore,
  guardedStoreWrite,
} from "./private-context";
export {
  privateStorageScope,
  encryptedStore,
  guardedStoreWrite,
} from "./private-context";
const missing = () =>
  Object.assign(new Error("Fichier privé absent."), { code: "ENOENT" });
interface Entry {
  readonly path: string;
  readonly log: boolean;
}
/** Encrypted names and contents. No model-controlled path is used as a physical object name. */
export class PrivateStorage {
  readonly directory: string;
  readonly archive: ArchiveFiles;
  readonly #index: string;
  readonly #lock: string;
  #closed = false;
  constructor(
    readonly root: string,
    readonly keys: ArchiveKeys,
  ) {
    if (!buildFlag("storage_encryption")) throw new ArchiveFailure("Storage encryption unavailable in this build.");
    this.directory = join(root, "archives-v1");
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    if (
      fs.lstatSync(this.directory).isSymbolicLink() ||
      !fs.lstatSync(this.directory).isDirectory() ||
      comparablePath(realPathOrSelf(this.directory)) !==
        comparablePath(this.directory)
    )
      throw new ArchiveFailure("Dossier d’archives lié refusé.");
    this.archive = new ArchiveFiles(this.directory, keys.cipher());
    this.#index = marker(root);
    this.#lock = join(root, "archive-store.lock");
  }
  #id(path: string): string {
    const rel = within(this.root, path);
    if (!rel || !covered(rel))
      throw new ArchiveFailure("Emplacement hors inventaire privé.");
    return this.archive.cipher.fingerprint("object-name", Buffer.from(rel));
  }
  #entries(): Entry[] {
    if (this.#closed) throw new ArchiveFailure("Accès au magasin terminé.");
    if (!fs.existsSync(this.#index)) {
      if (privateArchivePresent(this.root))
        throw new ArchiveFailure(
          "Inventaire privé absent : archives conservées, ouverture refusée.",
        );
      return [];
    }
    let value: unknown;
    try {
      const bytes = this.archive.read(this.#index);
      if (bytes.length > 8 * 1024 * 1024) throw new Error();
      value = JSON.parse(bytes.toString());
    } catch {
      throw new ArchiveFailure("Inventaire privé altéré ou illisible.");
    }
    if (
      !Array.isArray(value) ||
      value.length > 100000 ||
      value.some(
        (row) =>
          !row ||
          typeof row.path !== "string" ||
          row.path.length > 4096 ||
          typeof row.log !== "boolean" ||
          within(this.root, join(this.root, row.path)) !== row.path ||
          !covered(row.path),
      ) ||
      new Set(value.map((row) => row.path)).size !== value.length
    )
      throw new ArchiveFailure("Inventaire privé altéré.");
    return value as Entry[];
  }
  #save(entries: readonly Entry[]): void {
    const bytes = Buffer.from(JSON.stringify(entries));
    if (entries.length > 100000 || bytes.length > 8 * 1024 * 1024)
      throw new ArchiveFailure("Inventaire privé trop volumineux.");
    this.archive.write(this.#index, bytes);
  }
  #locked<T>(action: () => T): T {
    const release = tryFileLock(this.#lock);
    if (!release)
      throw new ArchiveFailure("Magasin privé occupé : opération suspendue.");
    try {
      return action();
    } finally {
      release();
    }
  }
  initialize(): void {
    this.#locked(() => {
      this.#entries();
      if (!fs.existsSync(this.#index)) this.#save([]);
    });
  }
  read(path: string): Buffer {
    const id = this.#id(path),
      rel = within(this.root, path)!,
      entry = this.#entries().find((entry) => entry.path === rel);
    if (!entry) throw missing();
    return this.archive.read(join(this.directory, id), entry.log);
  }
  exists(path: string): boolean {
    const rel = within(this.root, path);
    return (
      !!rel &&
      this.#entries().some(
        (entry) => entry.path === rel || entry.path.startsWith(rel + "/"),
      )
    );
  }
  list(path: string): string[] {
    const rel = within(this.root, path);
    if (!rel) throw missing();
    const prefix = rel + "/",
      names = new Set(
        this.#entries()
          .filter((entry) => entry.path.startsWith(prefix))
          .map((entry) => entry.path.slice(prefix.length).split("/")[0]!),
      );
    return [...names].sort();
  }
  walk(
    path: string,
    deadline: number,
    signal: AbortSignal,
    accept: (relative: string) => boolean,
  ) {
    const rel = within(this.root, path),
      prefix = rel + "/",
      files: Array<{ path: string; relativePath: string; stats: fs.Stats }> =
        [];
    let timedOut = false;
    for (const entry of this.#entries()) {
      if (!entry.path.startsWith(prefix)) continue;
      if (Date.now() > deadline || signal.aborted || files.length >= 1000) {
        timedOut = true;
        break;
      }
      const relativePath = entry.path.slice(prefix.length);
      if (!accept(relativePath)) continue;
      const logical = join(this.root, entry.path);
      files.push({ path: logical, relativePath, stats: this.stat(logical) });
    }
    return { files, timedOut };
  }
  stat(path: string): fs.Stats {
    const rel = within(this.root, path),
      entries = this.#entries(),
      entry = entries.find((entry) => entry.path === rel);
    if (entry) {
      const value = fs.statSync(join(this.directory, this.#id(path)));
      return Object.assign(value, { size: this.read(path).length });
    }
    if (!entries.some((entry) => entry.path.startsWith(rel + "/")))
      throw missing();
    const value = fs.statSync(this.directory);
    return value;
  }
  write(path: string, bytes: Buffer, append = false, exclusive = false): void {
    this.#locked(() => {
      const entries = this.#entries(),
        rel = within(this.root, path)!,
        previous = entries.find((entry) => entry.path === rel),
        object = join(this.directory, this.#id(path));
      if (exclusive && previous)
        throw Object.assign(new Error("Fichier privé existant."), {
          code: "EEXIST",
        });
      if (previous && append) {
        if (previous.log) this.archive.append(object, bytes);
        else
          this.archive.write(
            object,
            Buffer.concat([this.archive.read(object), bytes]),
          );
      } else if (append) {
        this.archive.write(object, Buffer.alloc(0));
        this.archive.append(object, bytes);
      } else this.archive.write(object, bytes);
      if (!previous || !append)
        this.#save([
          ...entries.filter((entry) => entry.path !== rel),
          { path: rel, log: append && (!previous || previous.log) },
        ]);
    });
  }
  remove(path: string, recursive = false): void {
    this.#locked(() => {
      const entries = this.#entries(),
        rel = within(this.root, path)!,
        removed = entries.filter(
          (entry) =>
            entry.path === rel ||
            (recursive && entry.path.startsWith(rel + "/")),
        );
      if (!removed.length) throw missing();
      // Remove names first; a crash can leave an encrypted orphan, never a clear replacement.
      this.#save(entries.filter((entry) => !removed.includes(entry)));
      for (const entry of removed) {
        const object = join(
          this.directory,
          this.#id(join(this.root, entry.path)),
        );
        if (fs.existsSync(object)) fs.unlinkSync(object);
      }
    });
  }
  rename(from: string, to: string): void {
    if (resolve(from) === resolve(to)) return;
    this.#locked(() => {
      const entries = this.#entries(),
        before = within(this.root, from)!,
        after = within(this.root, to)!,
        entry = entries.find((row) => row.path === before);
      if (!entry) throw missing();
      const source = join(this.directory, this.#id(from)),
        destination = join(this.directory, this.#id(to)),
        bytes = this.archive.read(source, entry.log);
      this.archive.write(destination, bytes);
      this.#save([
        ...entries.filter((row) => row.path !== before && row.path !== after),
        { path: after, log: false },
      ]);
      fs.unlinkSync(source);
    });
  }
  reference(path: string): string {
    return "archive:v1:" + this.#id(path);
  }
  resolveReference(reference: string): string | undefined {
    if (!/^archive:v1:[a-f0-9]{64}$/.test(reference)) return undefined;
    return this.#entries()
      .map((entry) => join(this.root, entry.path))
      .find((path) => this.reference(path) === reference);
  }
  close(): void {
    this.#closed = true;
    this.archive.cipher.destroy();
  }
  lock(path: string): (() => void) | undefined {
    return tryFileLock(
      join(this.directory, "lock-" + this.reference(path).slice(11)),
    );
  }
}
export async function openPrivateStorage(options: {
  readonly root: string;
  readonly service: string;
  readonly vault: CredentialVault;
  readonly enabled: boolean;
  readonly notice?: (text: string) => void;
}): Promise<() => void> {
  const ctx = context.getStore();
  if (!ctx) throw new Error("Private storage requires a session scope.");
  const root = resolve(options.root);
  if (comparablePath(realPathOrSelf(root)) !== comparablePath(root))
    throw new ArchiveFailure("Profil lié refusé.");
  ctx.root = root;
  if (!options.enabled) {
    if (privateArchivePresent(root))
      throw new ArchiveFailure(
        "Ce profil contient des archives chiffrées : activez storage.encryption.enabled.",
      );
    return () => {
      ctx.closed = true;
    };
  }
  if (!buildFlag("storage_encryption")) throw new ArchiveFailure("Storage encryption unavailable in this build.");
  options.notice?.(
    "Stockage chiffré : la perte du coffre système et de sa clé rend les archives irrécupérables. Migration des copies locales en cours.",
  );
  const keys = await openArchiveKeys({
    configDir: root,
    service: options.service,
    vault: options.vault,
    requireExisting: privateArchivePresent(root),
  });
  const store = new PrivateStorage(root, keys);
  try {
    store.initialize();
    // This lease serializes activation against other activations. All new storage writes go through their own store lease.
    const release = tryFileLock(join(root, "archive-migration.lock"));
    if (!release)
      throw new ArchiveFailure("Migration du profil déjà en cours.");
    try {
      let count = 0;
      const migrate = (path: string, depth: number): void => {
        if (++count > 100000 || depth > 16)
          throw new ArchiveFailure(
            "Migration trop volumineuse ; opération suspendue.",
          );
        const stat = fs.lstatSync(path);
        if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1))
          throw new ArchiveFailure("Copie liée : migration refusée.");
        if (stat.isDirectory()) {
          for (const name of fs.readdirSync(path))
            migrate(join(path, name), depth + 1);
          fs.rmdirSync(path);
        } else if (stat.isFile()) {
          if (/\.(active|lock|archive-lock)$/.test(path)) {
            if (stat.size)
              throw new ArchiveFailure(
                "Verrou ancien non vide : migration suspendue.",
              );
            const lease = tryFileLock(path);
            if (!lease)
              throw new ArchiveFailure(
                "Session ancienne active : migration suspendue.",
              );
            lease();
            fs.unlinkSync(path);
            return;
          }
          if (stat.size > 64 * 1024 * 1024)
            throw new ArchiveFailure(
              "Copie trop volumineuse : migration suspendue.",
            );
          const bytes = fs.readFileSync(path);
          if (store.exists(path)) {
            if (!store.read(path).equals(bytes))
              throw new ArchiveFailure(
                "Migration interrompue et original modifié : copies conservées.",
              );
          } else store.write(path, bytes);
          if (!store.read(path).equals(bytes))
            throw new ArchiveFailure("Migration non vérifiée.");
          const stamp = (value: fs.Stats) =>
            `${value.dev}:${value.ino}:${value.mode}:${value.nlink}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
          if (
            stamp(fs.lstatSync(path)) !== stamp(stat) ||
            !fs.readFileSync(path).equals(bytes) ||
            stamp(fs.lstatSync(path)) !== stamp(stat)
          )
            throw new ArchiveFailure(
              "Original modifié pendant la migration : copies conservées.",
            );
          fs.unlinkSync(path);
        } else
          throw new ArchiveFailure(
            "Copie non ordinaire : migration suspendue.",
          );
      };
      for (const name of fs.readdirSync(root))
        if (covered(name)) migrate(join(root, name), 0);
    } finally {
      release();
    }
    ctx.store = store;
    options.notice?.(
      "Stockage chiffré prêt ; aucune copie applicative connue en clair.",
    );
    return () => {
      ctx.closed = true;
      store.close();
    };
  } catch (error) {
    store.close();
    throw error;
  }
}
export function storeReference(path: string): string {
  return access(path)?.reference(path) ?? path;
}
export function storeDirectoryReference(path: string): string {
  const store = access(path),
    ctx = context.getStore();
  if (!store || !ctx) return path;
  const reference = store
    .reference(path)
    .replace("archive:v1:", "archive-dir:v1:");
  (ctx.references ??= new Map()).set(reference, path);
  return reference;
}
export function resolveStoreReference(reference: string): string | undefined {
  const ctx = context.getStore();
  const registered = ctx?.references?.get(reference);
  if (registered) return registered;
  const directory =
    /^(archive-dir:v1:[a-f0-9]{64})\/([a-z0-9][a-z0-9_-]{0,63}\.md)$/.exec(
      reference,
    );
  if (directory) {
    const root = ctx?.references?.get(directory[1]!);
    return root ? join(root, directory[2]!) : undefined;
  }
  return (
    ctx?.store?.resolveReference(reference) ??
    ctx?.temporary?.flatMap(
      (row) => row.store.resolveReference(reference) ?? [],
    )[0]
  );
}
export function storeRead(path: string): Buffer;
export function storeRead(path: string, encoding: BufferEncoding): string;
export function storeRead(
  path: string,
  encoding?: BufferEncoding,
): Buffer | string {
  const store = access(path),
    bytes = store ? store.read(path) : fs.readFileSync(path);
  return encoding ? bytes.toString(encoding) : bytes;
}
export function storeWrite(
  path: string,
  data: string | Uint8Array,
  options?: fs.WriteFileOptions,
): void {
  guardedStoreWrite(
    path,
    Buffer.from(data),
    () => fs.writeFileSync(path, data, options),
    false,
    typeof options === "object" && options !== null && options.flag === "wx",
  );
}
export function storeAppend(
  path: string,
  data: string | Uint8Array,
  options?: fs.WriteFileOptions,
): void {
  guardedStoreWrite(
    path,
    Buffer.from(data),
    () => fs.appendFileSync(path, data, options),
    true,
  );
}
export function storeExists(path: string): boolean {
  const store = access(path);
  return store ? store.exists(path) : fs.existsSync(path);
}
export function storeList(path: string): string[] {
  return access(path)?.list(path) ?? fs.readdirSync(path);
}
export function walkStoreFiles(
  path: string,
  deadline: number,
  signal: AbortSignal,
  accept: (relative: string) => boolean,
) {
  const store = access(path);
  if (!store) throw new ArchiveFailure("Magasin chiffré requis.");
  return store.walk(path, deadline, signal, accept);
}
export function storeStat(path: string): fs.Stats {
  return access(path)?.stat(path) ?? fs.lstatSync(path);
}
export function storeMkdir(
  path: string,
  options?: fs.MakeDirectoryOptions,
): string | undefined {
  return access(path) ? undefined : fs.mkdirSync(path, options);
}
export function storeFileLock(path: string): (() => void) | undefined {
  const store = access(path);
  return store ? store.lock(path) : tryFileLock(path);
}
export function protectTemporaryStore(root: string): () => void {
  const ctx = context.getStore();
  if (!ctx) throw new Error("Session scope required.");
  const store = new TemporaryStorage(resolve(root));
  (ctx.temporary ??= []).push({ root: resolve(root), store });
  return () => store.close();
}
/** Native servers invoke callbacks in their own async context: capture the session explicitly. */
export function bindPrivateStorage<Args extends unknown[], T>(action: (...args: Args) => T): (...args: Args) => T {
  const ctx = context.getStore();
  return ctx ? (...args: Args) => context.run(ctx, () => action(...args)) : action;
}
export function storeRemove(path: string, recursive = false): void {
  const store = access(path);
  if (store) store.remove(path, recursive);
  else fs.rmSync(path, { recursive });
}
export function storeRename(from: string, to: string): void {
  const store = access(from);
  if (store) {
    if (access(to) !== store)
      throw new ArchiveFailure("Export implicite du magasin refusé.");
    store.rename(from, to);
  } else {
    if (access(to)) throw new ArchiveFailure("Import hors migration refusé.");
    fs.renameSync(from, to);
  }
}
