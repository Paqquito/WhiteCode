// Supports: SPEC-OUT-026 (custom creation, owned removal and dirty-tree refusal), gap E-243.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** Only a newly created ordinary child of the reserved copy folder can be owned by this session. */
export class CustomCopyTree {
  readonly #identity: { dev: number; ino: number };
  readonly #baseline: string;
  readonly #canonicalPath: string;
  readonly #canonicalParent: string;
  constructor(readonly path: string, readonly parent: string) {
    if (dirname(realpathSync(path)) !== realpathSync(parent)) throw new Error("Custom copy escapes its reserved parent.");
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Custom copy is not an ordinary directory.");
    this.#identity = { dev: stat.dev, ino: stat.ino };
    this.#canonicalPath = realpathSync(path); this.#canonicalParent = realpathSync(parent);
    this.#baseline = this.#fingerprint();
  }
  #fingerprint(): string {
    const current = lstatSync(this.path);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== this.#identity.dev || current.ino !== this.#identity.ino || realpathSync(this.path) !== this.#canonicalPath || realpathSync(this.parent) !== this.#canonicalParent || dirname(this.#canonicalPath) !== this.#canonicalParent) throw new Error("Custom copy ownership changed; preserve the directory.");
    const hash = createHash("sha256"); let count = 0, bytes = 0;
    const visit = (folder: string, prefix: string) => {
      for (const entry of readdirSync(folder).sort()) {
        if (++count > 10000) throw new Error("Custom copy inventory is excessive; preserve the directory.");
        const path = join(folder, entry), relative = prefix + entry, stat = lstatSync(path);
        if (stat.isSymbolicLink()) throw new Error("Linked custom-copy content requires manual preservation.");
        if (stat.isDirectory()) { hash.update("directory\0" + relative + "\0"); visit(path, relative + "/"); }
        else {
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) throw new Error("Custom-copy content is linked or excessive; preserve the directory.");
          hash.update("file\0" + relative + "\0").update(createHash("sha256").update(readFileSync(path)).digest());
        }
      }
    };
    visit(this.path, ""); return hash.digest("hex");
  }
  changed(): boolean { return this.#fingerprint() !== this.#baseline; }
  remove(confirmed: boolean): void {
    if (this.changed() && !confirmed) throw new Error("Uncommitted custom-copy changes would be lost. Explicit confirmation is required.");
    // The exact freshly owned target and every contained entry were checked immediately above.
    rmSync(this.#canonicalPath, { recursive: true, force: false });
  }
}
