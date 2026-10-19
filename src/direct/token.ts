// Supports: SPEC-MOD-019 (private token creation), SPEC-MOD-018 (header-only secret), SPEC-PER-027 (shared credential store).
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore } from "../auth/credentials";
import { tryFileLock } from "../platform/file-lock";
import { securePrivateDirectory } from "../platform/private-file";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";

function token(value: string): string {
  if (!/^[A-Za-z0-9_-]{22,512}$/.test(value) || Buffer.from(value, "base64url").length < 16 || Buffer.from(value, "base64url").toString("base64url") !== value) throw new Error("Format de jeton de serveur invalide.");
  return value;
}
export function readDirectTokenFile(path: string): string {
  try { return token(readPrivateText(path, 1024).trim()); }
  catch { throw new Error("Fichier de jeton de serveur invalide ou inaccessible."); }
}

export async function directServerToken(options: { store: Pick<CredentialStore, "get" | "save">; directory: string; signal: AbortSignal; assertPolicy: () => void; confirmFallback?: () => Promise<boolean> }): Promise<string> {
  const assertCurrent = () => { options.signal.throwIfAborted(); options.assertPolicy(); };
  assertCurrent();
  const lock = join(options.directory, "token-init.lock");
  ordinaryPrivateFile(lock, 0); mkdirSync(options.directory, { recursive: true }); securePrivateDirectory(options.directory);
  const deadline = Date.now() + 10000;
  let release: (() => void) | undefined;
  while (!release) {
    assertCurrent(); release = tryFileLock(lock);
    if (release) break;
    if (Date.now() >= deadline) throw new Error("Initialisation du jeton déjà en cours ; réessayez après sa fin.");
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
  try {
    assertCurrent();
    const current = await options.store.get("direct-server"); assertCurrent();
    if (current !== undefined) return token(current);
    const generated = randomBytes(32).toString("base64url");
    await options.store.save("direct-server", generated, options.confirmFallback, assertCurrent);
    assertCurrent(); return generated;
  } finally { release(); }
}
