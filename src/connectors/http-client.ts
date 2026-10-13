// Implements: SPEC-MCP-003 (http and legacy sse, EF-01/02/03, RG-01, FA-01/02, CA-01/02/03).
// Supports: SPEC-MCP-022 (loss and reconnection), SPEC-MCP-009, SPEC-MCP-011, gap E-146.
// Wire framing follows the official MCP 2025-06-18 and 2024-11-05 transport specifications.
import { ConnectionError, McpError, PROTOCOL_VERSIONS, RequestTimeout, type McpCallResult, type McpContent, type McpPromptInfo, type McpToolInfo } from "./stdio-client";
import { secureConnectorUrl } from "./url";

const MAX_BYTES = 8 * 1024 * 1024;
interface Options {
  readonly name: string; readonly url: string; readonly transport: "http" | "sse";
  readonly headers: Readonly<Record<string, string>>; readonly fetch?: typeof fetch;
  readonly getHeaders?: (signal: AbortSignal, force: boolean) => Promise<Readonly<Record<string, string>> | undefined>;
  readonly connectTimeoutMs: number; readonly clientInfo: { readonly name: string; readonly version: string };
  readonly signal?: AbortSignal; readonly onNotification?: (method: string, params: unknown) => void;
  readonly onRequest?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
  readonly onLost?: (reason: string) => void;
}
interface Pending { method: string; resolve: (value: unknown) => void; reject: (error: Error) => void }
interface Event { event: string; data: string; id?: string }
export class AuthenticationRequired extends ConnectionError {
  constructor(message: string, readonly metadataUrl?: string) { super(message); }
}

/** Incremental UTF-8 and SSE decoding; bounds apply to an event, not to the lifetime of a connection. */
async function events(response: Response, receive: (event: Event) => boolean | void): Promise<void> {
  if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) throw new ConnectionError("Flux SSE invalide.");
  const reader = response.body.getReader(), decoder = new TextDecoder("utf-8", { fatal: true });
  let buffer = "", event = "message", data: string[] = [], id: string | undefined, size = 0;
  const line = (s: string) => {
    size += Buffer.byteLength(s, "utf8") + 1;
    if (size > MAX_BYTES) throw new ConnectionError("Événement MCP trop volumineux.");
    if (s === "") {
      const stop = data.length > 0 && receive({ event, data: data.join("\n"), ...(id !== undefined ? { id } : {}) }) === true;
      event = "message"; data = []; id = undefined; size = 0; return stop;
    }
    const colon = s.indexOf(":"), field = colon < 0 ? s : s.slice(0, colon), value = colon < 0 ? "" : s.slice(colon + 1).replace(/^ /, "");
    if (field === "data") data.push(value);
    else if (field === "event") event = value || "message";
    else if (field === "id" && !value.includes("\0")) { if (Buffer.byteLength(value) > 1024) throw new ConnectionError("Identifiant SSE invalide."); id = value; }
    return false;
  };
  try {
    for (;;) {
      const chunk = await reader.read();
      buffer += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      for (;;) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (!chunk.done && index === buffer.length - 1 && buffer[index] === "\r")) break;
        const end = buffer[index] === "\r" && buffer[index + 1] === "\n" ? index + 2 : index + 1;
        const s = buffer.slice(0, index); buffer = buffer.slice(end);
        if (line(s)) return;
      }
      if (Buffer.byteLength(buffer) > MAX_BYTES) throw new ConnectionError("Ligne SSE trop volumineuse.");
      if (chunk.done) return;
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class HttpConnection {
  readonly #o: Options; readonly #url: URL; readonly #life = new AbortController();
  readonly #jobs = new Set<Promise<unknown>>(); readonly #pending = new Map<number, Pending>();
  readonly #secrets = new Set<string>();
  #next = 1; #postUrl: URL; #session?: string; #ready = false; #closed = false; #lost = false;
  #lostReason?: string;
  #closeTask?: Promise<void>;
  protocolVersion = ""; capabilities: Record<string, unknown> = {};
  get lost(): string | undefined { return this.#lostReason; }
  private constructor(o: Options) {
    this.#o = o; this.#url = secureConnectorUrl(o.url); this.#postUrl = this.#url;
    for (const value of Object.values(o.headers)) if (value) {
      this.#secrets.add(value); const token = value.replace(/^(?:Bearer|Basic)\s+/i, ""); if (token) this.#secrets.add(token);
    }
    this.#remember(this.#url);
  }
  #remember(url: URL): void {
    // Endpoint and redirect parameters can carry an opaque session credential under any name.
    for (const value of url.searchParams.values()) if (value) this.#secrets.add(value);
  }
  static async open(o: Options): Promise<HttpConnection> {
    const c = new HttpConnection(o);
    const abort = () => c.#life.abort();
    const timer = setTimeout(abort, o.connectTimeoutMs);
    o.signal?.addEventListener("abort", abort, { once: true });
    if (o.signal?.aborted) abort();
    try {
      if (o.transport === "sse") await c.#legacy();
      const init = await c.request("initialize", { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: o.onRequest ? { elicitation: { form: {}, url: {} } } : {}, clientInfo: o.clientInfo }, { timeoutMs: o.connectTimeoutMs }) as { protocolVersion?: string; capabilities?: Record<string, unknown> };
      if (!init || !(PROTOCOL_VERSIONS as readonly unknown[]).includes(init.protocolVersion)) throw new ConnectionError("Version du protocole MCP non prise en charge.");
      if (init.capabilities !== undefined && (!init.capabilities || typeof init.capabilities !== "object" || Array.isArray(init.capabilities))) throw new ConnectionError("Capacités MCP invalides.");
      c.protocolVersion = init.protocolVersion!; c.capabilities = init.capabilities ?? {};
      await c.#notification("notifications/initialized", {});
      c.#ready = true;
      if (o.transport === "http") c.#track(c.#listen());
      return c;
    } catch (error) { await c.close(0); throw c.#safeError(error); }
    finally { clearTimeout(timer); o.signal?.removeEventListener("abort", abort); }
  }
  stderrTail(): string[] { return []; }
  #track<T>(job: Promise<T>): Promise<T> { this.#jobs.add(job); void job.then(() => this.#jobs.delete(job), () => this.#jobs.delete(job)); return job; }
  #safeError(error: unknown): Error {
    if (this.#lostReason === "authentification requise") return new AuthenticationRequired("Authentification requise (/connectors).");
    if (error instanceof ConnectionError || error instanceof McpError || error instanceof RequestTimeout) return error;
    return new ConnectionError(this.#life.signal.aborted ? "Connexion MCP interrompue." : "Connecteur injoignable ou réponse MCP invalide.");
  }
  async #headers(accept: string, signal: AbortSignal, supplied?: Readonly<Record<string, string>>): Promise<Headers> {
    let h: Headers;
    try { h = new Headers(this.#o.headers); } catch { throw new ConnectionError("En-têtes du connecteur invalides."); }
    if (this.#o.getHeaders) {
      const dynamic = supplied ?? await this.#o.getHeaders(signal, false);
      try { for (const [name, value] of Object.entries(dynamic ?? {})) { h.set(name, value); if (value) { this.#secrets.add(value); this.#secrets.add(value.replace(/^(?:Bearer|Basic)\s+/i, "")); } } }
      catch { throw new ConnectionError("En-têtes du connecteur invalides."); }
    }
    h.set("Accept", accept); h.set("Content-Type", "application/json");
    h.delete("MCP-Session-Id"); h.delete("MCP-Protocol-Version"); h.delete("Last-Event-ID");
    if (this.#session) h.set("MCP-Session-Id", this.#session);
    if (this.protocolVersion) h.set("MCP-Protocol-Version", this.protocolVersion);
    return h;
  }
  async #fetch(url: URL, method: string, signal: AbortSignal, body?: string, cursor?: string): Promise<Response> {
    let headers = await this.#headers(method === "GET" ? "text/event-stream" : "application/json, text/event-stream", signal);
    if (cursor !== undefined) headers.set("Last-Event-ID", cursor);
    let target = url, refreshed = false;
    for (let attempt = 0; attempt <= 5; attempt++) {
      signal.throwIfAborted();
      this.#remember(target);
      const response = await (this.#o.fetch ?? fetch)(target, { method, headers, signal, redirect: "manual", ...(body !== undefined ? { body } : {}) });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location"); await response.body?.cancel();
        if (!location || attempt === 5) throw new ConnectionError("Redirection MCP refusée.");
        const next = secureConnectorUrl(new URL(location, target).href);
        if (next.origin !== this.#url.origin) throw new ConnectionError("Redirection MCP vers une autre origine refusée.");
        target = next; continue;
      }
      if (response.status === 401) {
        const metadataUrl = /(?:^|[\s,])resource_metadata="([^"]+)"/i.exec(response.headers.get("WWW-Authenticate") ?? "")?.[1];
        await response.body?.cancel();
        if (!refreshed && this.#o.getHeaders) { refreshed = true; const dynamic = await this.#o.getHeaders(signal, true); if (dynamic) { headers = await this.#headers(method === "GET" ? "text/event-stream" : "application/json, text/event-stream", signal, dynamic); if (cursor !== undefined) headers.set("Last-Event-ID", cursor); attempt--; continue; } }
        if (this.#ready) this.#end("authentification requise"); throw new AuthenticationRequired("Authentification requise (/connectors).", metadataUrl);
      }
      if (response.status === 404 && this.#session) { await response.body?.cancel(); this.#end("session MCP expirée"); throw new ConnectionError("Session MCP expirée."); }
      return response;
    }
    throw new ConnectionError("Redirection MCP refusée.");
  }
  #dispatch(data: string): void {
    const m = JSON.parse(data) as Record<string, unknown>;
    if (!m || typeof m !== "object" || m.jsonrpc !== "2.0") throw new ConnectionError("Réponse JSON-RPC invalide.");
    if (typeof m.method === "string") {
      if (m.id === undefined) this.#o.onNotification?.(m.method, this.#redact(m.params));
      else this.#track(this.#notificationResponse(m));
      return;
    }
    const p = typeof m.id === "number" ? this.#pending.get(m.id) : undefined;
    if (!p) return;
    if (Object.hasOwn(m, "error") === Object.hasOwn(m, "result")) throw new ConnectionError("Réponse JSON-RPC invalide.");
    if (m.error) { const code = (m.error as { code?: number }).code; this.#pending.delete(m.id as number); p.reject(new McpError("Erreur de requête MCP.", typeof code === "number" ? code : undefined)); }
    else {
      const result = p.method === "initialize" ? m.result : this.#redact(m.result, p.method === "tools/list" || p.method === "prompts/list");
      this.#pending.delete(m.id as number); p.resolve(result);
    }
  }
  #redact(value: unknown, metadata = false): unknown {
    if (value === undefined || this.#secrets.size === 0) return value;
    // Match original text once: inserted markers are never input to subsequent replacements.
    const pattern = new RegExp([...this.#secrets].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    let bytes = 0;
    const mask = (text: string): string => {
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_BYTES) throw new ConnectionError("Résultat MCP masqué trop volumineux.");
      return text.replace(pattern, (match) => {
        bytes += 10 - Buffer.byteLength(match);
        if (bytes > MAX_BYTES) throw new ConnectionError("Résultat MCP masqué trop volumineux.");
        return "[redacted]";
      });
    };
    const visit = (item: unknown, field = "", opaque = false, depth = 0): unknown => {
      if (depth > 128) throw new ConnectionError("Résultat MCP trop imbriqué.");
      if (typeof item === "string") {
        // Routing names, schema contracts and content discriminants remain protocol data.
        if (!opaque && (metadata ? field !== "description" && field !== "title" : field === "type" || field === "role" || field === "mimeType")) return item;
        return mask(item);
      }
      if (Array.isArray(item)) return item.map((v) => visit(v, field, opaque, depth + 1));
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, v]) => {
        const data = opaque || key === "structuredContent";
        return [opaque ? mask(key) : key, visit(v, key, data, depth + 1)];
      }));
      return item;
    };
    const result = visit(value);
    if (Buffer.byteLength(JSON.stringify(result)) > MAX_BYTES) throw new ConnectionError("Résultat MCP masqué trop volumineux.");
    return result;
  }
  async #stream(response: Response, signal: AbortSignal, stop: () => boolean, receive?: (event: Event) => void): Promise<void> {
    let cursor: string | undefined;
    for (let resume = 0; ; resume++) {
      try {
        await events(response, (event) => {
          if (event.id !== undefined) cursor = event.id || undefined;
          if (receive) receive(event);
          else if (event.event === "message") this.#dispatch(event.data);
          return stop();
        });
        if (stop()) return;
      } catch (e) { if (signal.aborted || cursor === undefined || resume >= 2) throw e; }
      if (signal.aborted || cursor === undefined || resume >= 2) throw new ConnectionError("Flux MCP interrompu.");
      response = await this.#fetch(this.#url, "GET", signal, undefined, cursor);
      if (!response.ok) { await response.body?.cancel(); throw new ConnectionError("Reprise du flux MCP refusée."); }
    }
  }
  async #post(message: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const response = await this.#fetch(this.#postUrl, "POST", signal, JSON.stringify(message));
    if (!response.ok) { await response.body?.cancel(); throw new ConnectionError("Requête HTTP MCP refusée."); }
    if (message.method === "initialize" && this.#o.transport === "http") {
      const session = response.headers.get("MCP-Session-Id");
      if (session !== null) { if (!/^[\x21-\x7e]{1,1024}$/.test(session)) { await response.body?.cancel(); throw new ConnectionError("Identifiant de session MCP invalide."); } this.#session = session; this.#secrets.add(session); }
    }
    if (this.#o.transport === "sse" || message.id === undefined || message.result !== undefined || message.error !== undefined) { await response.body?.cancel(); return; }
    if (response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream")) return this.#stream(response, signal, () => !this.#pending.has(message.id as number));
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) { await response.body?.cancel(); throw new ConnectionError("Type de réponse MCP invalide."); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    try { for (;;) { const r = await reader.read(); if (r.done) break; size += r.value.byteLength; if (size > MAX_BYTES) throw new ConnectionError("Réponse MCP trop volumineuse."); chunks.push(r.value); } this.#dispatch(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
  request(method: string, params: unknown, o: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> { return this.#track(this.#request(method, params, o)); }
  async #request(method: string, params: unknown, o: { timeoutMs: number; signal?: AbortSignal }): Promise<unknown> {
    if (this.#lostReason === "authentification requise") throw new AuthenticationRequired("Authentification requise (/connectors).");
    if (this.#closed || this.#lost) throw new ConnectionError("Connecteur déconnecté.");
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(new RequestTimeout("Délai de requête MCP dépassé.")), o.timeoutMs);
    const signal = AbortSignal.any([this.#life.signal, abort.signal, ...(o.signal ? [o.signal] : [])]), id = this.#next++;
    let cancel!: () => void;
    const answer = new Promise<unknown>((resolve, reject) => { this.#pending.set(id, { method, resolve, reject }); cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true }); });
    void answer.catch(() => {});
    try {
      signal.throwIfAborted(); await this.#post({ jsonrpc: "2.0", id, method, params }, signal);
      if (this.#o.transport === "http" && this.#pending.has(id)) throw new ConnectionError("Réponse MCP absente du flux.");
      return await answer;
    } catch (error) {
      if (signal.aborted && method !== "initialize" && !this.#closed) this.#track(this.#notification("notifications/cancelled", { requestId: id, reason: "Request cancelled" }).catch(() => {}));
      throw this.#safeError(error);
    } finally { clearTimeout(timer); this.#pending.delete(id); signal.removeEventListener("abort", cancel); abort.abort(); }
  }
  async #notification(method: string, params: unknown): Promise<void> { await this.#post({ jsonrpc: "2.0", method, params }, AbortSignal.any([this.#life.signal, AbortSignal.timeout(this.#o.connectTimeoutMs)])); }
  async #notificationResponse(m: Record<string, unknown>): Promise<void> {
    try {
      const unsupportedUrl = m.method === "elicitation/create" && (m.params as { mode?: unknown } | undefined)?.mode === "url" && this.protocolVersion !== "2025-11-25";
      const answer = unsupportedUrl ? { result: { action: "decline" } } : m.method === "ping" ? { result: {} } : m.method === "elicitation/create" && this.#o.onRequest ? { result: await this.#o.onRequest(m.method, m.params, this.#life.signal).catch(() => ({ action: "cancel" })) } : { error: { code: -32601, message: "Method not found" } };
      await this.#post({ jsonrpc: "2.0", id: m.id, ...answer }, this.#life.signal);
    }
    catch { this.#end("réponse au serveur impossible"); }
  }
  async #legacy(): Promise<void> {
    const deadline = new AbortController(), timer = setTimeout(() => deadline.abort(), this.#o.connectTimeoutMs);
    const signal = AbortSignal.any([this.#life.signal, deadline.signal]);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const endpoint = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const cancel = () => reject(signal.reason); signal.addEventListener("abort", cancel, { once: true });
    const job = (async () => {
      try {
        const response = await this.#fetch(this.#url, "GET", signal);
        if (!response.ok) { await response.body?.cancel(); throw new ConnectionError("Connexion SSE refusée."); }
        await this.#stream(response, signal, () => this.#closed, (e) => {
          if (e.event === "endpoint") {
            const next = secureConnectorUrl(new URL(e.data, this.#url).href);
            if (next.origin !== this.#url.origin) throw new ConnectionError("Adresse SSE vers une autre origine refusée.");
            this.#remember(next); this.#postUrl = next; clearTimeout(timer); resolve();
          } else if (e.event === "message") this.#dispatch(e.data);
        });
        throw new ConnectionError("Flux SSE interrompu.");
      } catch (e) { reject(this.#safeError(e)); this.#end("flux SSE interrompu"); }
    })();
    this.#track(job);
    try { await endpoint; } finally { clearTimeout(timer); signal.removeEventListener("abort", cancel); }
  }
  async #listen(): Promise<void> {
    try { const r = await this.#fetch(this.#url, "GET", this.#life.signal); if (r.status === 405) { await r.body?.cancel(); return; } if (!r.ok) { await r.body?.cancel(); throw new ConnectionError("Flux HTTP MCP refusé."); } await this.#stream(r, this.#life.signal, () => this.#closed); }
    catch (error) { if (!this.#closed) this.#end(error instanceof AuthenticationRequired ? "authentification requise" : "flux MCP interrompu"); }
  }
  #end(reason: string): void {
    if (this.#lost || this.#closed) return;
    this.#lost = true; this.#lostReason = reason; this.#life.abort();
    for (const p of this.#pending.values()) p.reject(reason === "authentification requise" ? new AuthenticationRequired("Authentification requise (/connectors).") : new ConnectionError("Connecteur déconnecté."));
    this.#pending.clear(); if (this.#ready) this.#o.onLost?.(reason);
  }
  close(_graceMs = 0): Promise<void> { return this.#closeTask ??= this.#close(); }
  async #close(): Promise<void> {
    this.#closed = true; this.#life.abort();
    await Promise.allSettled([...this.#jobs]);
    if (this.#session) { try { const r = await this.#fetch(this.#url, "DELETE", AbortSignal.timeout(1000)); await r.body?.cancel(); } catch {} }
  }
  async #list(field: "tools" | "prompts", timeoutMs: number): Promise<unknown[]> {
    const items: unknown[] = []; let cursor: string | undefined;
    for (let page = 0; page < 100; page++) { const r = await this.request(`${field}/list`, cursor ? { cursor } : {}, { timeoutMs }) as Record<string, unknown>; if (Array.isArray(r?.[field])) items.push(...r[field]); cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined; if (!cursor) return items; }
    throw new ConnectionError("Trop de pages MCP.");
  }
  async listTools(timeoutMs: number): Promise<McpToolInfo[]> { return await this.#list("tools", timeoutMs) as McpToolInfo[]; }
  async listPrompts(timeoutMs: number): Promise<McpPromptInfo[]> { return (await this.#list("prompts", timeoutMs) as McpPromptInfo[]).filter((p) => typeof p?.name === "string"); }
  async getPrompt(name: string, args: Readonly<Record<string, string>>, o: { timeoutMs: number; signal?: AbortSignal }): Promise<{ messages: ReadonlyArray<{ role?: string; content?: McpContent | readonly McpContent[] }> }> { const r = await this.request("prompts/get", { name, arguments: args }, o) as { messages?: Array<{ content?: McpContent }> }; return { messages: Array.isArray(r?.messages) ? r.messages : [] }; }
  async callTool(name: string, args: unknown, o: { timeoutMs: number; signal?: AbortSignal }): Promise<McpCallResult> {
    try { const r = await this.request("tools/call", { name, arguments: args ?? {} }, o) as McpCallResult; return { content: Array.isArray(r?.content) ? r.content : [], structuredContent: r?.structuredContent, isError: r?.isError === true }; }
    catch (error) {
      if (error instanceof RequestTimeout) throw new RequestTimeout("The connector request timed out.");
      throw new Error(o.signal?.aborted ? "The connector request was cancelled." : "The connector request failed. Reconnect or authenticate it before using its tools.");
    }
  }
}
