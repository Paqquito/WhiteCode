// Supports: SPEC-SES-001 (§ 5.7 authenticated encryption and profile keys), SPEC-PER-027 (archive key lifecycle), gap E-136.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialVault } from "../platform/credential-vault";
import { tryFileLock } from "../platform/file-lock";
import { comparablePath, currentPlatform, realPathOrSelf } from "../platform/system";
import { writeAtomic } from "../tools/text-file";

export class ArchiveFailure extends Error {
  constructor(message = "Données de session altérées ou illisibles.") { super(message); }
}
interface KeyRing {
  readonly v: 1;
  readonly active: string;
  readonly fingerprint: string;
  readonly keys: Readonly<Record<string, string>>;
}
interface KeyOptions {
  readonly service: string;
  readonly configDir: string;
  readonly vault: CredentialVault;
  /** Existing encrypted data must never cause generation of a replacement for a lost key. */
  readonly requireExisting?: boolean;
}
const keyId = () => randomBytes(16).toString("hex");
const keyValue = () => randomBytes(32).toString("base64");
const serviceKey = (service: string) => createHash("sha256").update(service).digest("hex").slice(0, 24);
const lockPath = (options: KeyOptions) => join(options.configDir, "archive-key-" + serviceKey(options.service) + ".lock");
function base64(value: unknown, length?: number): Buffer {
  if (typeof value !== "string") throw new ArchiveFailure();
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value || (length !== undefined && bytes.length !== length)) throw new ArchiveFailure();
  return bytes;
}
function parseRing(text: string): KeyRing {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ArchiveFailure();
    const ring = value as KeyRing;
    if (ring.v !== 1 || typeof ring.active !== "string" || !/^[a-f0-9]{32}$/.test(ring.active) || !ring.keys || typeof ring.keys !== "object" || Array.isArray(ring.keys)) throw new ArchiveFailure();
    base64(ring.fingerprint, 32);
    const entries = Object.entries(ring.keys);
    if (entries.length < 1 || entries.length > 2 || !Object.hasOwn(ring.keys, ring.active)) throw new ArchiveFailure();
    for (const [id, key] of entries) { if (!/^[a-f0-9]{32}$/.test(id)) throw new ArchiveFailure(); base64(key, 32); }
    return ring;
  } catch { throw new ArchiveFailure("Clé d'archives invalide dans le coffre du système."); }
}

/** The key ring exists exclusively in the user's system vault, separate from provider credentials. */
export class ArchiveKeys {
  readonly #options: KeyOptions;
  readonly #account: string;
  #ring: KeyRing;
  #generation: string;
  get ring(): KeyRing { return this.#ring; }
  constructor(options: KeyOptions, account: string, ring: KeyRing) {
    this.#options = options; this.#account = account; this.#ring = ring;
    const signature = ring.active + ":" + Object.keys(ring.keys).sort().join(".");
    let marker: { signature?: string; generation?: string } = {};
    try { marker = JSON.parse(readFileSync(this.#marker, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new ArchiveFailure("Marqueur de clé d'archives invalide."); }
    if (marker.signature === signature && typeof marker.generation === "string" && /^[a-f0-9]{32}$/.test(marker.generation)) this.#generation = marker.generation;
    else { this.#generation = keyId(); this.#writeGeneration(); }
  }
  get #marker(): string { return join(this.#options.configDir, "archive-key-" + serviceKey(this.#options.service) + ".generation.json"); }
  #writeGeneration(): void { writeAtomic(this.#marker, Buffer.from(JSON.stringify({ signature: this.#ring.active + ":" + Object.keys(this.#ring.keys).sort().join("."), generation: this.#generation })), currentPlatform(), true); }
  /** The disk generation also revokes stale ciphers held by another process, before any store mutation. */
  cipher(): ArchiveCipher { return this.#cipher(false); }
  #cipher(keyLockHeld: boolean): ArchiveCipher {
    const generation = this.#generation;
    const assertCurrent = () => {
      let marker: { generation?: string };
      try { marker = JSON.parse(readFileSync(this.#marker, "utf8")); } catch { throw new ArchiveFailure("Génération de clé d'archives indisponible."); }
      if (marker.generation !== generation) throw new ArchiveFailure("Clé d'archives renouvelée : rouvrez le magasin.");
    };
    return new ArchiveCipher(this.#ring, assertCurrent, (action) => {
      const release = keyLockHeld ? undefined : tryFileLock(lockPath(this.#options));
      if (!keyLockHeld && !release) throw new ArchiveFailure("Rotation ou migration en cours : écriture suspendue.");
      try { assertCurrent(); action(); } finally { release?.(); }
    });
  }
  async #save(ring: KeyRing): Promise<void> {
    const { vault, service } = this.#options, text = JSON.stringify(ring);
    await vault.write(service, this.#account, text);
    if (await vault.read(service, this.#account) !== text) throw new ArchiveFailure("La clé d'archives n'a pas pu être vérifiée dans le coffre.");
    this.#ring = ring;
    this.#generation = keyId(); this.#writeGeneration();
  }
  /** Keeps both keys until the caller has migrated and verified every covered file. A failed call resumes the same rotation. */
  async rotate(migrateAndVerify: (cipher: ArchiveCipher) => Promise<void>): Promise<void> {
    await withKeyLock(this.#options, async () => {
      const text = await this.#options.vault.read(this.#options.service, this.#account);
      if (text === undefined) throw new ArchiveFailure("Clé d'archives absente du coffre du système.");
      this.#ring = parseRing(text);
      this.#generation = new ArchiveKeys(this.#options, this.#account, this.#ring).#generation;
      if (Object.keys(this.#ring.keys).length === 1) {
        const active = keyId();
        await this.#save({ ...this.#ring, active, keys: { ...this.#ring.keys, [active]: keyValue() } });
      }
      const cipher = this.#cipher(true);
      try { await migrateAndVerify(cipher); } finally { cipher.destroy(); }
      await this.#save({ ...this.#ring, keys: { [this.#ring.active]: this.#ring.keys[this.#ring.active]! } });
    });
  }
}
async function withKeyLock<T>(options: KeyOptions, action: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 30_000;
  let release: (() => void) | undefined;
  while (!(release = tryFileLock(lockPath(options)))) {
    if (Date.now() >= deadline) throw new ArchiveFailure("Clé d'archives occupée : réessayez.");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try { return await action(); } finally { release(); }
}
export async function openArchiveKeys(options: KeyOptions): Promise<ArchiveKeys> {
  mkdirSync(options.configDir, { recursive: true, mode: 0o700 });
  const account = "profile-" + createHash("sha256").update(comparablePath(realPathOrSelf(options.configDir))).digest("hex") + "-archives";
  try {
    return await withKeyLock(options, async () => {
      const stored = await options.vault.read(options.service, account);
      if (stored !== undefined) return new ArchiveKeys(options, account, parseRing(stored));
      if (options.requireExisting) throw new ArchiveFailure("Clé d'archives absente du coffre du système ; les données ne peuvent être récupérées.");
      const active = keyId(), ring: KeyRing = { v: 1, active, fingerprint: keyValue(), keys: { [active]: keyValue() } };
      const text = JSON.stringify(ring);
      await options.vault.write(options.service, account, text);
      if (await options.vault.read(options.service, account) !== text) throw new ArchiveFailure("Écriture de la clé d'archives non vérifiée.");
      return new ArchiveKeys(options, account, ring);
    });
  } catch (error) {
    if (error instanceof ArchiveFailure) throw error;
    throw new ArchiveFailure("Stockage chiffré indisponible : déverrouillez le coffre du système.");
  }
}

export interface DecodedArchive {
  readonly chunks: Buffer[];
  readonly partial: boolean;
  readonly needsNewline: boolean;
  readonly completeBytes: number;
  readonly fileId: string;
  readonly keyIds: ReadonlySet<string>;
}
/** AES-256-GCM frames, with a random file identity and authenticated domain, order and format version. */
export class ArchiveCipher {
  readonly #active: string;
  readonly #keys: Map<string, Buffer>;
  readonly #fingerprint: Buffer;
  #closed = false;
  constructor(ring: KeyRing, readonly assertCurrent: () => void, readonly mutate: (action: () => void) => void) {
    parseRing(JSON.stringify(ring));
    this.#active = ring.active; this.#keys = new Map(Object.entries(ring.keys).map(([id, key]) => [id, base64(key, 32)]));
    this.#fingerprint = base64(ring.fingerprint, 32);
  }
  #assertOpen(): void { if (this.#closed) throw new ArchiveFailure("Accès aux archives terminé."); this.assertCurrent(); }
  /** Protected deduplication names stay stable across data-key rotation, within this profile only. */
  fingerprint(domain: string, bytes: Uint8Array): string {
    this.#assertOpen();
    return createHmac("sha256", this.#fingerprint).update(JSON.stringify(["archive:1", domain])).update(bytes).digest("hex");
  }
  #aad(domain: string, fileId: string, sequence: number): Buffer { return Buffer.from(JSON.stringify(["archive:1", domain, fileId, sequence])); }
  frame(domain: string, fileId: string, sequence: number, bytes: Uint8Array): Buffer {
    this.#assertOpen();
    if (bytes.length > 64 * 1024 * 1024 || !/^[a-f0-9]{32}$/.test(fileId) || !Number.isSafeInteger(sequence) || sequence < 0) throw new ArchiveFailure();
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#keys.get(this.#active)!, nonce);
    cipher.setAAD(this.#aad(domain, fileId, sequence));
    const body = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return Buffer.from([this.#active, nonce.toString("base64"), body.toString("base64"), cipher.getAuthTag().toString("base64")].join(".") + "\n");
  }
  encode(domain: string, chunks: readonly Uint8Array[]): Buffer {
    const fileId = keyId();
    return Buffer.concat([Buffer.from(`archive:1:${fileId}\n`), this.frame(domain, fileId, 0, Buffer.alloc(0)), ...chunks.map((bytes, i) => this.frame(domain, fileId, i + 1, bytes))]);
  }
  decode(domain: string, bytes: Uint8Array, allowPartial = false): DecodedArchive {
    this.#assertOpen();
    try {
      const text = Buffer.from(bytes).toString("utf8"), lines = text.split("\n"), header = /^archive:1:([a-f0-9]{32})$/.exec(lines[0]!);
      if (!header || lines.length < 2) throw new ArchiveFailure();
      const tail = lines[lines.length - 1]!, unterminated = tail !== "";
      if (unterminated && !allowPartial) throw new ArchiveFailure();
      const parts = tail.split(".");
      // A complete tag must be authenticated even when its following LF was not written.
      const completeTail = unterminated && (parts.length > 4 || (parts.length === 4 && parts[3]!.length >= 24));
      const partial = unterminated && !completeTail;
      if (tail.length > 90 * 1024 * 1024) throw new ArchiveFailure();
      if (completeTail) lines.push("");
      const chunks: Buffer[] = [], keyIds = new Set<string>();
      for (let i = 1; i < lines.length - 1; i++) {
        const line = lines[i]!;
        if (line.length > 90 * 1024 * 1024) throw new ArchiveFailure();
        const parts = line.split(".");
        if (parts.length !== 4 || !/^[a-f0-9]{32}$/.test(parts[0]!)) throw new ArchiveFailure();
        const key = this.#keys.get(parts[0]!);
        if (!key) throw new ArchiveFailure("Clé requise absente du coffre du système.");
        const decipher = createDecipheriv("aes-256-gcm", key, base64(parts[1], 12));
        decipher.setAAD(this.#aad(domain, header[1]!, i - 1)); decipher.setAuthTag(base64(parts[3], 16));
        const plain = Buffer.concat([decipher.update(base64(parts[2])), decipher.final()]);
        if (i === 1) { if (plain.length !== 0) throw new ArchiveFailure(); } else chunks.push(plain);
        keyIds.add(parts[0]!);
      }
      if (!keyIds.size) throw new ArchiveFailure();
      const completeBytes = partial ? Buffer.byteLength(text.slice(0, text.lastIndexOf("\n") + 1)) : bytes.length;
      return { chunks, partial, needsNewline: completeTail, completeBytes, fileId: header[1]!, keyIds };
    } catch (error) { if (error instanceof ArchiveFailure) throw error; throw new ArchiveFailure(); }
  }
  destroy(): void { for (const key of this.#keys.values()) key.fill(0); this.#fingerprint.fill(0); this.#closed = true; }
}
