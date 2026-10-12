// Supports: SPEC-SES-001 (§ 5.7 migration, rotation and authorized in-memory access), gap E-136.
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, truncateSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { ArchiveCipher, ArchiveFailure } from "./archive-crypto";
import { comparablePath, currentPlatform, realPathOrSelf } from "../platform/system";
import { writeAtomic } from "../tools/text-file";
import { tryFileLock } from "../platform/file-lock";

/** Paths remain internal. Callers expose opaque references and keep the profile's migration lock while enumerating files. */
export class ArchiveFiles {
  readonly #root: string;
  constructor(root: string, readonly cipher: ArchiveCipher) { this.#root = comparablePath(realPathOrSelf(root)); }
  #domain(path: string): string {
    const absolute = resolve(path), logical = comparablePath(absolute), real = comparablePath(realPathOrSelf(path));
    const rel = relative(this.#root, logical), realRel = relative(this.#root, real);
    if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || realRel !== rel) throw new ArchiveFailure("Chemin hors du magasin privé ou lié à un autre emplacement.");
    let ancestor = absolute;
    while (comparablePath(ancestor) !== this.#root) {
      try { const stat = lstatSync(ancestor); if (stat.isSymbolicLink() || (ancestor === absolute && (!stat.isFile() || stat.nlink > 1))) throw new ArchiveFailure("Un magasin privé ne peut être un lien ni avoir plusieurs noms."); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const parent = dirname(ancestor); if (parent === ancestor) throw new ArchiveFailure(); ancestor = parent;
    }
    return rel.split("\\").join("/");
  }
  read(path: string, appendLog = false): Buffer {
    const domain = this.#domain(path);
    return Buffer.concat(this.cipher.decode(domain, readFileSync(path), appendLog).chunks);
  }
  #replace(path: string, domain: string, chunks: readonly Uint8Array[]): void {
    const encoded = this.cipher.encode(domain, chunks), temporary = path + ".archive-tmp-" + randomUUID();
    this.#domain(temporary);
    if (existsSync(temporary)) throw new ArchiveFailure("Nom de candidat de migration déjà utilisé.");
    writeAtomic(temporary, encoded, currentPlatform(), true);
    const verified = this.cipher.decode(domain, readFileSync(temporary)).chunks;
    if (verified.length !== chunks.length || verified.some((chunk, i) => !chunk.equals(Buffer.from(chunks[i]!)))) throw new ArchiveFailure("Migration non vérifiée ; original conservé.");
    renameSync(temporary, path);
  }
  write(path: string, bytes: Uint8Array): void {
    const domain = this.#domain(path);
    this.#mutate(path, () => this.#replace(path, domain, [bytes]));
  }
  contentFingerprint(path: string, bytes: Uint8Array): string { return this.cipher.fingerprint("import:" + this.#domain(path), bytes); }
  /** The private fingerprint, recorded by the caller's inventory, makes an interrupted import safe to repeat. */
  importPlaintext(path: string, expectedFingerprint: string): void {
    const domain = this.#domain(path);
    this.#mutate(path, () => {
      const bytes = readFileSync(path);
      if (this.contentFingerprint(path, bytes) === expectedFingerprint) this.#replace(path, domain, [bytes]);
      else {
        const imported = Buffer.concat(this.cipher.decode(domain, bytes).chunks);
        if (this.contentFingerprint(path, imported) !== expectedFingerprint) throw new ArchiveFailure("Original de migration modifié ou inventaire incorrect.");
      }
    });
  }
  /** Replaces only after verifying a uniquely named encrypted candidate on disk. */
  migrate(path: string, appendLog = false): void {
    const domain = this.#domain(path);
    this.#mutate(path, () => {
      const chunks = this.cipher.decode(domain, readFileSync(path), appendLog).chunks;
      this.#replace(path, domain, chunks);
    });
  }
  #mutate(path: string, action: () => void): void {
    this.#domain(path);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = path + ".archive-lock";
    this.#domain(lock);
    const release = tryFileLock(lock);
    if (!release) throw new ArchiveFailure("Magasin privé occupé : écriture suspendue.");
    try { this.cipher.mutate(() => { this.#domain(path); action(); }); }
    finally { release(); }
  }
  /** Single-file append lock prevents concurrent frames from sharing a sequence number. */
  append(path: string, bytes: Uint8Array): void {
    const domain = this.#domain(path);
    this.#mutate(path, () => {
      if (!existsSync(path)) this.#replace(path, domain, []);
      const decoded = this.cipher.decode(domain, readFileSync(path), true);
      if (decoded.partial) truncateSync(path, decoded.completeBytes);
      const frame = Buffer.concat([decoded.needsNewline ? Buffer.from("\n") : Buffer.alloc(0), this.cipher.frame(domain, decoded.fileId, decoded.chunks.length + 1, bytes)]), fd = openSync(path, "a");
      try {
        for (let offset = 0; offset < frame.length;) offset += writeSync(fd, frame, offset, frame.length - offset);
        fsyncSync(fd);
      } finally { closeSync(fd); }
    });
  }
  verifyActive(path: string, appendLog = false): void {
    const domain = this.#domain(path), result = this.cipher.decode(domain, readFileSync(path), appendLog);
    // Comparing to a fresh frame avoids exposing key identifiers to store callers.
    const active = this.cipher.frame(domain, result.fileId, 0, Buffer.alloc(0)).toString().split(".")[0]!;
    if ([...result.keyIds].some((id) => id !== active)) throw new ArchiveFailure("La rotation dépend encore d'une ancienne clé.");
  }
}
