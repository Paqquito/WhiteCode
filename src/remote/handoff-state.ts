// Supports: SPEC-CMD-091 CA-01, SPEC-MOD-015 (bounded, complete transfer; no archive extraction).
import { createHash } from "node:crypto";
import { retainedHistory } from "../session/retained-history";
import { containsSecret } from "../shared/secrets";
export interface HandoffState { version: 1; repository: string; branch: string; base: string; index: string; snapshot: string; transferBranch: string }
export function handoffRepository(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || value.length > 4096) throw Error("Dépôt HTTPS sans identifiants requis.");
  return url.href.replace(/\/$/, "").replace(/\.git$/, "");
}
export const handoffBranch = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,199}$/.test(value) && !/\.\.|\/\/|@\{|\.lock(?:\/|$)|[./]$/.test(value);
export function handoffState(value: unknown): HandoffState {
  const v = value as Partial<HandoffState> | null;
  if (!v || v.version !== 1 || typeof v.repository !== "string" || !handoffBranch(v.branch) || !handoffBranch(v.transferBranch) || !/^handoff\/[a-f0-9-]{36}$/.test(v.transferBranch) || ![v.base,v.index,v.snapshot].every(s => typeof s === "string" && /^[a-f0-9]{40,64}$/.test(s))) throw Error("État de transfert Git invalide.");
  handoffRepository(v.repository);
  return { version: 1, repository: v.repository, branch: v.branch, base: v.base!, index: v.index!, snapshot: v.snapshot!, transferBranch: v.transferBranch };
}
export function handoffHistory(value: unknown) {
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > 192000 || containsSecret(serialized)) throw Error("Historique trop volumineux ou sensible : transfert refusé.");
  // Opaque binary attachments cannot be screened for excluded files or credentials.
  if (/"(?:dataBase64|data_base64)"\s*:/.test(serialized)) throw Error("Pièces jointes binaires : transfert automatique refusé.");
  return retainedHistory(JSON.parse(serialized));
}
export function handoffDigest(state: HandoffState, messages: unknown): string { return createHash("sha256").update(JSON.stringify([handoffState(state), handoffHistory(messages)])).digest("hex"); }
