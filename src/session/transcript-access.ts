// Supports: SPEC-SES-001 (§ 5.7 invocation-scoped transcript references, CA-12/13/15), SPEC-HOK-001 (transcriptRef), gap E-137.
import { randomBytes } from "node:crypto";
import { readLoopback, startLoopbackServer } from "../platform/loopback-server";
import { bindPrivateStorage } from "./private-storage";

export interface TranscriptGrant { readonly reference: string; release(): void }
export interface TranscriptInvocation { readonly event: string; readonly fields: Readonly<Record<string, unknown>> }
const activeReads = new Map<string, () => Buffer>();
let broker: ReturnType<typeof startLoopbackServer> | undefined;
/** One unreferenced broker per process; revocation removes every content callback of a closed invocation. */
function localPort(): number {
  broker ??= startLoopbackServer((request) => {
    const headers = { Connection: "close", "Cache-Control": "no-store" };
    const url = new URL(request.url);
    const token = /^\/read\/([A-Za-z0-9_-]{43})$/.exec(url.pathname)?.[1];
    const read = token ? activeReads.get(token) : undefined;
    if (request.method !== "GET" || request.headers.has("origin") || url.search || !read)
      return new Response("Référence indisponible.", { status: 404, headers });
    try { return new Response(read(), { headers: { ...headers, "Content-Type": "application/x-ndjson; charset=utf-8" } }); }
    catch { return new Response("Lecture de la session indisponible.", { status: 503, headers }); }
  });
  return broker.port;
}
/** Loopback capability server. The content is obtained in memory, and never written to a temporary file. */
export class TranscriptAccess {
  readonly #grants = new Set<string>();
  #closed = false;
  constructor(readonly read: (invocation?: TranscriptInvocation) => Buffer) {}
  async #start(): Promise<number> {
    if (this.#closed) throw new Error("Accès à la session terminé.");
    return localPort();
  }
  async grant(invocation?: TranscriptInvocation): Promise<TranscriptGrant> {
    const port = await this.#start();
    if (this.#closed) throw new Error("Accès à la session terminé.");
    const token = randomBytes(32).toString("base64url"); this.#grants.add(token);
    activeReads.set(token, bindPrivateStorage(() => this.read(invocation)));
    return { reference: `session:v1:${port}:${token}`, release: () => { this.#grants.delete(token); activeReads.delete(token); } };
  }
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const token of this.#grants) activeReads.delete(token);
    this.#grants.clear();
  }
}

/** Reads directly from loopback, without following redirects or writing temporary content. */
export async function readTranscriptReference(reference: string, write: (text: string) => void, signal?: AbortSignal): Promise<void> {
  const match = /^session:v1:([1-9]\d{0,4}):([A-Za-z0-9_-]{43})$/.exec(reference);
  if (!match || Number(match[1]) > 65535) throw new Error("Référence de session invalide.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const timer = setTimeout(cancel, 5000);
  let reader: ReturnType<NonNullable<Response["body"]>["getReader"]> | undefined;
  try {
    const response = await readLoopback(Number(match[1]), match[2]!, controller.signal);
    if (response.status !== 200 || !response.body) { await response.body?.cancel(); throw new Error(); }
    const stream = reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) { const chunk = await stream.read(); if (chunk.done) break; write(decoder.decode(chunk.value, { stream: true })); }
    const tail = decoder.decode(); if (tail) write(tail);
  } catch { throw new Error("Référence de session indisponible ou expirée."); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
}
