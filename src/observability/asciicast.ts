// Implements: SPEC-OBS-016 (CA-01, terminal output and resize events in asciicast v2).
// Supports: SPEC-SES-001 (encrypted default recording refused), gap E-161.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Terminal } from "../platform/terminal";
import { restrictFileToOwner } from "../platform/private-file";
import { encryptedStore, storeExists, storeAppend, storeWrite } from "../session/private-storage";

/** Outputs only: neither keyboard input nor the environment is recorded. Exclusive creation forbids overwriting. */
export class Asciicast {
  #fd?: number;
  readonly #origin = performance.now();
  readonly #identity: { dev: number; ino: number } = { dev: 0, ino: 0 };
  readonly #encrypted: boolean;
  #closed = false;
  #bytes = 0;
  #failed = false;
  constructor(readonly path: string, width: number, height: number, readonly warn: (message: string) => void) {
    this.#encrypted = encryptedStore(path);
    if (this.#encrypted) {
      if (storeExists(path)) throw new Error("Recording already exists");
      storeWrite(path, Buffer.alloc(0), { flag: "wx" }); this.#line({ version: 2, width: Math.max(1, width || 80), height: Math.max(1, height || 24), timestamp: Math.floor(Date.now() / 1000) }); return;
    }
    for (let directory = dirname(resolve(path));; directory = dirname(directory)) {
      try { const entry = lstatSync(directory); if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe recording directory"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (directory === dirname(directory)) break;
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    this.#identity = fstatSync(this.#fd);
    try { restrictFileToOwner(path); this.#line({ version: 2, width: Math.max(1, width || 80), height: Math.max(1, height || 24), timestamp: Math.floor(Date.now() / 1000) }); }
    catch (error) { this.close(); throw error; }
  }
  #line(value: unknown): void {
    if (this.#encrypted) { if (this.#closed) return; const data = JSON.stringify(value) + "\n"; if (this.#bytes + Buffer.byteLength(data) > 104857600) throw new Error("Recording size limit"); storeAppend(this.path, data); this.#bytes += Buffer.byteLength(data); return; }
    if (this.#fd === undefined) return;
    const current = lstatSync(this.path); if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== this.#identity.dev || current.ino !== this.#identity.ino) throw new Error("Recording file changed");
    const data = Buffer.from(JSON.stringify(value) + "\n"); if (this.#bytes + data.length > 104857600) throw new Error("Recording size limit");
    for (let offset = 0; offset < data.length;) offset += writeSync(this.#fd, data, offset, data.length - offset); this.#bytes += data.length;
  }
  #event(kind: "o" | "r", value: string): void {
    try { this.#line([Math.max(0, performance.now() - this.#origin) / 1000, kind, value]); }
    catch { this.close(); if (!this.#failed) { this.#failed = true; this.warn("Enregistrement désactivé : destination modifiée, pleine ou limite de taille atteinte."); } }
  }
  output(text: string): void { if (text) this.#event("o", text); }
  terminal(original: Terminal): Terminal {
    return { write: text => { this.output(text); original.write(text); }, get columns() { return original.columns; }, get rows() { return original.rows; }, setRawMode: enabled => original.setRawMode(enabled), onInput: listener => original.onInput(listener), onProcessExit: listener => original.onProcessExit(listener), onResize: listener => original.onResize(() => { this.#event("r", `${original.columns}x${original.rows}`); listener(); }) };
  }
  close(): void { this.#closed = true; if (this.#fd !== undefined) { closeSync(this.#fd); this.#fd = undefined; } }
}
