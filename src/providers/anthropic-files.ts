// Implements: SPEC-API-021 (CA-01, EF-01, RG-01, expiration and compatible inline fallback).
import type Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import { ProviderError, type DocumentPart, type ModelRequest } from "./types";

export const documentFingerprint = (part: DocumentPart): string => createHash("sha256").update(Buffer.from(part.dataBase64, "base64")).digest("hex");
const UPLOAD_THRESHOLD = 256 * 1024;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
type Entry = { readonly id: string; readonly expires: number };
export type FileTransfer = (event: { readonly bytes: number; readonly state: "uploading" | "uploaded" }) => void;

/** IDs belong only to documents read by this product and this session; none are accepted from model or user input. */
export class AnthropicFiles {
  readonly #sessions = new Map<string, Map<string, Entry>>();
  #queue = Promise.resolve();
  constructor(readonly client: Anthropic, readonly transfer?: FileTransfer, readonly allowed?: (part: DocumentPart) => boolean) {}

  async prepare(request: ModelRequest, signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    signal.throwIfAborted();
    const result = this.#queue.then(() => this.#prepare(request, signal));
    this.#queue = result.then(() => undefined, () => undefined);
    return new Promise((resolve,reject)=>{
      const abort=()=>{signal.removeEventListener("abort",abort);reject(signal.reason);};
      signal.addEventListener("abort",abort,{once:true});
      void result.then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});
      if(signal.aborted)abort();
    });
  }
  async #prepare(request: ModelRequest, signal: AbortSignal): Promise<ReadonlyMap<string, string>> {
    signal.throwIfAborted();
    const references = new Map<string, string>();
    const documents = request.history.flatMap(message => message.role === "user" ? message.parts.filter((part): part is DocumentPart => part.type === "document") : []);
    for (const part of documents) {
      if (this.allowed?.(part) === false) throw new ProviderError("permission", "Le document joint n'est plus autorisé par les permissions actuelles.");
      if (Buffer.byteLength(part.dataBase64, "base64") > MAX_DOCUMENT_BYTES) throw new ProviderError("invalid_request", "Fichier trop volumineux pour le service (limite locale de 20 Mio).");
      const bytes = Buffer.from(part.dataBase64, "base64");
      if (bytes.toString("base64") !== part.dataBase64 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new ProviderError("invalid_request", "Document PDF joint invalide.");
    }
    if (!request.model.capabilities.pdf || !request.model.capabilities.filesApi) return references;
    const session = request.conversationId ?? "current";
    let entries = this.#sessions.get(session);
    if (!entries) {
      if (this.#sessions.size >= 128) throw new ProviderError("invalid_request", "Trop de sessions de fichiers sont actives dans ce processus.");
      entries = new Map(); this.#sessions.set(session, entries);
    }
    for (const message of request.history) {
      if (message.role !== "user") continue;
      for (const part of message.parts) {
        if (part.type !== "document") continue;
        const bytes = Buffer.from(part.dataBase64, "base64");
        if (bytes.length > MAX_DOCUMENT_BYTES) throw new ProviderError("invalid_request", "Fichier trop volumineux pour le service (limite locale de 20 Mio).");
        if (bytes.length < UPLOAD_THRESHOLD) continue;
        const key = documentFingerprint(part);
        if (references.has(key)) continue;
        let entry = entries.get(key);
        if (entry) {
          if (entry.expires <= Date.now()) { entries.delete(key); entry = undefined; }
          else try {
            const metadata = await this.client.files.retrieveMetadata(entry.id, {}, { signal });
            if (metadata.id !== entry.id) throw new ProviderError("malformed_response", "Référence distante de fichier incohérente.");
            if (metadata.expires_at != null) {
              const expires = Date.parse(metadata.expires_at);
              if (!Number.isFinite(expires)) throw new ProviderError("malformed_response", "Expiration distante de fichier invalide.");
              if (expires <= Date.now()) { entries.delete(key); entry = undefined; }
            }
          }
          catch (error) { if ((error as { status?: number }).status !== 404) throw error; entries.delete(key); entry = undefined; }
        }
        if (!entry) {
          if (entries.size >= 1000) throw new ProviderError("invalid_request", "Nombre maximal de fichiers de la session atteint.");
          this.transfer?.({ bytes: bytes.length, state: "uploading" });
          const uploaded = await this.client.files.upload({ file: new File([bytes], basename(part.name), { type: part.mediaType }), expires_in_seconds: 86400 }, { signal });
          if (typeof uploaded.id !== "string" || !uploaded.id || uploaded.id.length > 512 || /[\x00-\x20\x7f]/.test(uploaded.id)) throw new ProviderError("malformed_response", "Identifiant de fichier renvoyé par le service invalide.");
          const expires = uploaded.expires_at === null || uploaded.expires_at === undefined ? Date.now() + 86400000 : Date.parse(uploaded.expires_at);
          if (Number.isNaN(expires) || expires <= Date.now()) throw new ProviderError("malformed_response", "Le service a renvoyé un fichier déjà expiré.");
          entry = { id: uploaded.id, expires }; entries.set(key, entry);
          this.transfer?.({ bytes: bytes.length, state: "uploaded" });
        }
        references.set(key, entry.id);
      }
    }
    return references;
  }
}
