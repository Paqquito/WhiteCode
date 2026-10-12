// Implements: SPEC-PER-027 (EF-02 to EF-05, CA-01/02/03/05), SPEC-API-011 (stored provider keys).
// Supports: gap E-135 (profile-qualified account; archive keys have a separate vault entry and lifecycle).
import { lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { nativeCredentialVault, VaultUnavailable, type CredentialVault } from "../platform/credential-vault";
import { tryFileLock } from "../platform/file-lock";
import { restrictFileToOwner } from "../platform/private-file";
import { comparablePath, currentPlatform, realPathOrSelf } from "../platform/system";
import { writeAtomic } from "../tools/text-file";

export interface CredentialStoreOptions {
  readonly service: string;
  readonly configDir: string;
  readonly vault?: CredentialVault;
  readonly preference: "auto" | "keychain" | "file";
  readonly warn?: (message: string) => void;
  readonly mayUseFile?: () => boolean;
  readonly migrate?: boolean;
}
/** Product credentials remain inaccessible to model-facing file reads, including symlinks and hard links. */
export function isCredentialFile(path: string, configDir: string): boolean {
  const file = join(configDir, "credentials.json");
  if (comparablePath(realPathOrSelf(path)) === comparablePath(realPathOrSelf(file))) return true;
  try { const a = statSync(path), b = statSync(file); return a.ino !== 0 && a.dev === b.dev && a.ino === b.ino; } catch { return false; }
}
const parse = (text: string): Record<string, string> => {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("Magasin d'identifiants invalide."); }
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some((v) => typeof v !== "string")) throw new Error("Magasin d'identifiants invalide.");
  return value as Record<string, string>;
};

export class CredentialStore {
  readonly #o: CredentialStoreOptions;
  readonly #vault: CredentialVault;
  readonly #account: string;
  readonly #file: string;
  #warned = false;
  #source = "aucune";
  get source(): string { return this.#source; }
  constructor(options: CredentialStoreOptions) {
    this.#o = options; this.#vault = options.vault ?? nativeCredentialVault();
    mkdirSync(options.configDir, { recursive: true });
    this.#account = "profile-" + createHash("sha256").update(comparablePath(realPathOrSelf(options.configDir))).digest("hex") + "-credentials";
    this.#file = join(options.configDir, "credentials.json");
  }
  #fallback(mutating = false): Record<string, string> | undefined {
    try {
      const stat = lstatSync(this.#file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error("Fichier d'identifiants invalide.");
      if (mutating && stat.nlink > 1) throw new Error("Fichier d'identifiants lié à plusieurs noms : retirez ses liens supplémentaires avant toute modification.");
      restrictFileToOwner(this.#file);
      if (currentPlatform() !== "windows" && (stat.mode & 0o777) !== 0o600) this.#o.warn?.("Droits du fichier d'identifiants corrigés.");
      if (!this.#warned) { this.#warned = true; this.#o.warn?.("Identifiants lus dans un fichier non chiffré à droits privés."); }
      return parse(readFileSync(this.#file, "utf8"));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  async #locked<T>(action: () => Promise<T>, assertCurrent: () => void = () => {}): Promise<T> {
    mkdirSync(this.#o.configDir, { recursive: true });
    const deadline = Date.now() + 30_000;
    let release: (() => void) | undefined;
    while (!(release = tryFileLock(this.#file + ".lock"))) {
      assertCurrent();
      if (Date.now() >= deadline) throw new Error("Magasin d'identifiants verrouillé : réessayez.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    try { assertCurrent(); return await action(); } finally { release(); }
  }
  async get(name: string): Promise<string | undefined> {
    if (this.#o.preference !== "file") {
      try {
        const value = await this.#vault.read(this.#o.service, this.#account);
        if (this.#o.preference === "keychain") {
          const key = value === undefined ? undefined : parse(value)[name];
          if (key) this.#source = "trousseau";
          return key;
        }
        if (value !== undefined && parse(value)[name] !== undefined) { this.#source = "trousseau"; return parse(value)[name]; }
        if (this.#o.migrate !== false && this.#fallback() !== undefined) {
          const migrated = await this.#locked(async () => {
            const current = await this.#vault.read(this.#o.service, this.#account);
            const values = { ...this.#fallback(true), ...(current === undefined ? {} : parse(current)) };
            await this.#vault.write(this.#o.service, this.#account, JSON.stringify(values));
            this.#fallback(true);
            rmSync(this.#file, { force: true }); return values;
          });
          this.#source = "trousseau"; return migrated[name];
        }
        if (value !== undefined) { this.#source = "trousseau"; return parse(value)[name]; }
      } catch (error) { if (!(error instanceof VaultUnavailable) || error.locked) throw error; if (this.#o.preference === "keychain") throw new Error("Authentification inaccessible : trousseau exigé."); }
    }
    const value = this.#fallback()?.[name];
    if (value) this.#source = "fichier non chiffré";
    return value;
  }
  async save(name: string, value: string, confirmFallback?: () => Promise<boolean>, assertCurrent: () => void = () => {}): Promise<void> {
    await this.#locked(async () => {
      if (this.#o.preference !== "file") {
        let stored: string | undefined;
        let available = true;
        try { stored = await this.#vault.read(this.#o.service, this.#account); }
        catch (error) { if (!(error instanceof VaultUnavailable) || error.locked) throw error; available = false; }
        assertCurrent();
        if (available) {
          const previous = { ...this.#fallback(true), ...(stored === undefined ? {} : parse(stored)) };
          await this.#vault.write(this.#o.service, this.#account, JSON.stringify({ ...previous, [name]: value }));
          this.#fallback(true);
          rmSync(this.#file, { force: true }); // migration only after a successful vault write.
          return;
        }
      }
      if (this.#o.preference === "keychain") throw new Error("Connexion refusée : trousseau exigé, aucun repli fichier autorisé.");
      if (!confirmFallback || !await confirmFallback()) throw new Error("Connexion annulée : repli fichier non accepté.");
      assertCurrent();
      if (this.#o.mayUseFile?.() === false) throw new Error("Connexion refusée : trousseau exigé, aucun repli fichier autorisé.");
      this.#o.warn?.("Identifiants enregistrés dans un fichier non chiffré à droits privés.");
      writeAtomic(this.#file, Buffer.from(JSON.stringify({ ...this.#fallback(true), [name]: value }) + "\n"), currentPlatform(), true);
    }, assertCurrent);
  }
  async clear(assertCurrent: () => void = () => {}): Promise<void> {
    await this.#locked(async () => {
      let available = true;
      try { await this.#vault.read(this.#o.service, this.#account); }
      catch (error) { if (!(error instanceof VaultUnavailable) || error.locked || this.#o.preference === "keychain") throw error; available = false; }
      assertCurrent();
      const existing = this.#fallback(true);
      try { if (available) await this.#vault.remove(this.#o.service, this.#account); }
      catch (error) { if (!(error instanceof VaultUnavailable) || error.locked || this.#o.preference === "keychain") throw error; }
      this.#fallback(true);
      assertCurrent();
      if (existing !== undefined) rmSync(this.#file);
    }, assertCurrent);
  }
}
