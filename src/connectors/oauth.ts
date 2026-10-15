// Implements: SPEC-MCP-006 (OAuth discovery, registration, PKCE, resource, vault, refresh and logout, CA-01 to CA-03).
// Supports: SPEC-OUT-029 (human authorization only), gap E-155.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { CredentialVault } from "../platform/credential-vault";
import { tryFileLock } from "../platform/file-lock";
import { comparablePath, realPathOrSelf } from "../platform/system";
import { startLoopbackServer } from "../platform/loopback-server";
import { secureConnectorUrl } from "../connectors/url";
import { existsSync } from "node:fs";
import { readPrivateText } from "../shared/private-text";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";

export interface OAuthConfiguration { readonly clientId?: string; readonly clientSecret?: string; readonly callbackPort?: number; readonly scopes?: readonly string[] }
export interface OAuthUi {
  confirm(server: string, signal?: AbortSignal): Promise<boolean>;
  /** The human may paste the full callback URL into a separate masked buffer; no model receives it. */
  authorize(url: string, signal: AbortSignal): Promise<string | undefined>;
}
interface Options {
  readonly explicitMetadata?: Metadata;
  readonly credentialNamespace?: "company-account";
  readonly name: string; readonly url: string; readonly configuration: OAuthConfiguration;
  readonly configDir: string; readonly service: string; readonly vault: CredentialVault;
  readonly fetch: typeof fetch; readonly timeoutMs: number; readonly now?: () => number;
}
export interface Metadata { issuer: string; authorization_endpoint: string; token_endpoint: string; registration_endpoint?: string; revocation_endpoint?: string }
interface Token { resource: string; issuer: string; access: string; refresh?: string; expiresAt: number; clientId: string; clientSecret?: string; tokenEndpoint: string; revocationEndpoint?: string; generation?: string; version?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(value);
const same = (a: string, b: string) => { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && timingSafeEqual(aa, bb); };
const error = (message: string): Error => new Error(`Authentification du connecteur : ${message}`);
export class OAuthGenerationChanged extends Error { constructor() { super("Connexion modifiée pendant l’autorisation du service."); } }
export interface AuthorizationSnapshot { readonly authorization: string; readonly generation?: string; readonly version?: string }

/** One vault entry and one native lock per profile, connector name and canonical resource URL. No plaintext fallback. */
export class ConnectorOAuth {
  readonly #resource: string; readonly #account: string; readonly #lock: string;
  #metadata?: Metadata; #challenge?: string; #signing?: Promise<string>;
  constructor(readonly options: Options) {
    this.#resource = secureConnectorUrl(options.url).href;
    const digest = createHash("sha256").update(JSON.stringify([comparablePath(realPathOrSelf(options.configDir)), options.name, this.#resource])).digest("hex");
    this.#account = `${options.credentialNamespace ?? "connector-oauth"}-${digest}`; this.#lock = join(options.configDir, "locks", `${this.#account}.lock`);
  }
  challenge(metadataUrl: string | undefined): void { if (metadataUrl) this.#challenge = secureConnectorUrl(metadataUrl).href; }
  #lifecycle(): string { const file = this.#lock + ".generation"; return existsSync(file) ? readPrivateText(file, 64) : "initial"; }
  async #locked<T>(signal: AbortSignal, action: () => Promise<T>): Promise<T> {
    mkdirSync(join(this.options.configDir, "locks"), { recursive: true });
    const deadline = Date.now() + Math.min(this.options.timeoutMs, 30000); let release: (() => void) | undefined;
    while (!(release = tryFileLock(this.#lock))) { signal.throwIfAborted(); if (Date.now() >= deadline) throw error("trousseau occupé."); await new Promise(r => setTimeout(r, 25)); }
    try { signal.throwIfAborted(); return await action(); } finally { release(); }
  }
  async #stored(): Promise<Token | undefined> {
    const raw = await this.options.vault.read(this.options.service, this.#account);
    if (raw === undefined) return undefined;
    let t: unknown; try { t = JSON.parse(raw); } catch { throw error("entrée de trousseau invalide."); }
    if (!object(t) || t.resource !== this.#resource || !text(t.access) || !text(t.clientId) || !text(t.issuer) || !text(t.tokenEndpoint) || !Number.isFinite(t.expiresAt) || t.refresh !== undefined && !text(t.refresh) || t.clientSecret !== undefined && !text(t.clientSecret)) throw error("entrée de trousseau invalide.");
    if (t.generation !== undefined && (typeof t.generation !== "string" || !/^[a-f0-9]{32}$/.test(t.generation))) throw error("génération d’identifiants invalide.");
    if (t.version !== undefined && (typeof t.version !== "string" || !/^[a-f0-9]{32}$/.test(t.version))) throw error("version d’identifiants invalide.");
    // A malformed store cannot send a token to a different protocol or a URL carrying credentials.
    secureConnectorUrl(t.tokenEndpoint); secureConnectorUrl(t.issuer); if (t.revocationEndpoint !== undefined) { if (!text(t.revocationEndpoint)) throw error("entrée de trousseau invalide."); secureConnectorUrl(t.revocationEndpoint); }
    if (this.options.explicitMetadata && (t.issuer !== this.options.explicitMetadata.issuer || t.tokenEndpoint !== this.options.explicitMetadata.token_endpoint || t.revocationEndpoint !== this.options.explicitMetadata.revocation_endpoint)) throw error("points d’autorisation modifiés ; reconnectez le compte.");
    return t as unknown as Token;
  }
  async #save(t: Token, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted(); const generation = t.generation ?? randomBytes(16).toString("hex"), raw = JSON.stringify({ ...t, generation, version: randomBytes(16).toString("hex") });
    await this.options.vault.write(this.options.service, this.#account, raw);
    if (await this.options.vault.read(this.options.service, this.#account) !== raw) throw error("enregistrement dans le trousseau non confirmé.");
    return generation;
  }
  async #json(url: string, signal: AbortSignal, body?: URLSearchParams | Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = secureConnectorUrl(url);
    const response = await this.options.fetch(target, { signal, redirect: "error", headers: body ? { "Content-Type": body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json", Accept: "application/json" } : { Accept: "application/json" }, ...(body ? { method: "POST", body: body instanceof URLSearchParams ? body.toString() : JSON.stringify(body) } : {}) });
    if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json") || !response.body) { await response.body?.cancel(); throw error("réponse d'autorisation refusée."); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > 262144) throw error("réponse d'autorisation trop volumineuse."); chunks.push(part.value); } }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    let result: unknown; try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw error("réponse d'autorisation invalide."); }
    if (!object(result)) throw error("réponse d'autorisation invalide."); return result;
  }
  async #discover(signal: AbortSignal): Promise<Metadata> {
    if (this.#metadata) return this.#metadata;
    if (this.options.explicitMetadata) { for (const endpoint of Object.values(this.options.explicitMetadata)) if (endpoint !== undefined) secureConnectorUrl(endpoint); return this.#metadata = { ...this.options.explicitMetadata }; }
    const resource = new URL(this.#resource);
    const paths = this.#challenge ? [this.#challenge] : [new URL(`/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`, resource.origin).href, new URL("/.well-known/oauth-protected-resource", resource.origin).href];
    let protectedMetadata: Record<string, unknown> | undefined;
    for (const path of [...new Set(paths)]) { try { protectedMetadata = await this.#json(path, signal); break; } catch { signal.throwIfAborted(); } }
    if (!protectedMetadata || protectedMetadata.resource !== this.#resource || !Array.isArray(protectedMetadata.authorization_servers) || !text(protectedMetadata.authorization_servers[0])) throw error("le connecteur ne publie pas ses informations d'autorisation.");
    const issuer = protectedMetadata.authorization_servers[0]; secureConnectorUrl(issuer);
    const u = new URL(issuer); if (u.search) throw error("émetteur d'autorisation invalide.");
    const metadataUrl = new URL(`/.well-known/oauth-authorization-server${u.pathname === "/" ? "" : u.pathname}`, u.origin).href;
    const m = await this.#json(metadataUrl, signal);
    if (m.issuer !== issuer || !text(m.authorization_endpoint) || !text(m.token_endpoint) || !Array.isArray(m.code_challenge_methods_supported) || !m.code_challenge_methods_supported.includes("S256")) throw error("métadonnées d'autorisation invalides ou PKCE S256 absent.");
    for (const endpoint of [m.authorization_endpoint, m.token_endpoint, m.registration_endpoint, m.revocation_endpoint]) if (endpoint !== undefined) { if (!text(endpoint)) throw error("adresse d'autorisation invalide."); secureConnectorUrl(endpoint); }
    return this.#metadata = { issuer, authorization_endpoint: m.authorization_endpoint, token_endpoint: m.token_endpoint, ...(typeof m.registration_endpoint === "string" ? { registration_endpoint: m.registration_endpoint } : {}), ...(typeof m.revocation_endpoint === "string" ? { revocation_endpoint: m.revocation_endpoint } : {}) };
  }
  #token(result: Record<string, unknown>, base: Omit<Token, "access" | "expiresAt">, previousRefresh?: string): Token {
    if (!text(result.access_token) || typeof result.token_type !== "string" || result.token_type.toLowerCase() !== "bearer" || typeof result.expires_in !== "number" || !Number.isFinite(result.expires_in) || result.expires_in < 0 || result.expires_in > 315360000 || result.refresh_token !== undefined && !text(result.refresh_token)) throw error("jeton reçu invalide.");
    return { ...base, access: result.access_token, expiresAt: (this.options.now?.() ?? Date.now()) + result.expires_in * 1000, ...(typeof result.refresh_token === "string" ? { refresh: result.refresh_token } : previousRefresh ? { refresh: previousRefresh } : {}) };
  }
  async info(): Promise<{ expiresAt: number; generation?: string } | undefined> { const token = await this.#stored(); return token ? { expiresAt: token.expiresAt, generation: token.generation } : undefined; }
  async authorization(signal: AbortSignal, force = false, rejected?: string, expectedGeneration?: string): Promise<string | undefined> {
    return (await this.authorize(signal, { force, rejected, expectedGeneration }))?.authorization;
  }
  async authorize(signal: AbortSignal, options: { force?: boolean; rejected?: string; rejectedVersion?: string; expectedGeneration?: string } = {}): Promise<AuthorizationSnapshot | undefined> {
    const { force, rejected, rejectedVersion, expectedGeneration } = options;
    const task = this.#locked(signal, async () => {
      const t = await this.#stored(); if (!t) return undefined;
      if (expectedGeneration !== undefined && t.generation !== expectedGeneration) throw new OAuthGenerationChanged();
      const current = { authorization: `Bearer ${t.access}`, generation: t.generation, version: t.version };
      if (force && (rejectedVersion !== undefined ? t.version !== rejectedVersion : rejected !== undefined && current.authorization !== rejected)) return current;
      if (!force && t.expiresAt > (this.options.now?.() ?? Date.now()) + 30000) return current;
      if (!t.refresh) return undefined;
      const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: t.refresh, client_id: t.clientId, resource: this.#resource }); if (t.clientSecret) body.set("client_secret", t.clientSecret);
      const operation = AbortSignal.timeout(30000);
      const next = this.#token(await this.#json(t.tokenEndpoint, operation, body), t, t.refresh);
      const generation = await this.#save(next, operation); return { authorization: `Bearer ${next.access}`, generation, version: (await this.#stored())?.version };
    });
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason); signal.addEventListener("abort", abort, { once: true });
      void task.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, cause => { signal.removeEventListener("abort", abort); reject(cause); }); if (signal.aborted) abort();
    });
  }
  signIn(ui: OAuthUi, parent: AbortSignal): Promise<string> {
    if (this.#signing) return this.#signing;
    const task = this.#signIn(ui, parent); this.#signing = task;
    void task.finally(() => { if (this.#signing === task) this.#signing = undefined; }).catch(() => {}); return task;
  }
  async #signIn(ui: OAuthUi, parent: AbortSignal): Promise<string> {
    const life = new AbortController(), signal = AbortSignal.any([parent, life.signal, AbortSignal.timeout(this.options.timeoutMs)]);
    signal.throwIfAborted();
    const generation = await this.#locked(signal, async () => { await this.options.vault.read(this.options.service, this.#account); return this.#lifecycle(); });
    if (!await ui.confirm(this.options.name, signal)) throw error("autorisation refusée.");
    const verifier = randomBytes(32).toString("base64url"), state = randomBytes(32).toString("base64url");
    let resolve!: (code: string) => void, reject!: (cause: Error) => void, redirect = "";
    const returned = new Promise<string>((yes, no) => { resolve = yes; reject = no; }); void returned.catch(() => {});
    const parse = (address: string): string => {
      const u = new URL(address);
      if (u.origin + u.pathname !== redirect || u.hash || u.searchParams.getAll("state").length !== 1 || !same(u.searchParams.get("state") ?? "", state)) throw error("retour d'autorisation invalide.");
      if (u.searchParams.has("error")) throw error("autorisation refusée.");
      const code = u.searchParams.get("code"); if (!text(code) || u.searchParams.getAll("code").length !== 1) throw error("retour d'autorisation invalide."); return code;
    };
    const receiver = startLoopbackServer(request => {
      const headers = { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'", "X-Content-Type-Options": "nosniff" };
      if (request.method !== "GET" || request.headers.has("origin") || request.url.length > 8192) return new Response("Retour refusé.", { status: 403, headers });
      try { resolve(parse(request.url)); return new Response("Autorisation reçue. Revenez au terminal.", { headers }); }
      catch (cause) { if (cause instanceof Error && cause.message === "Authentification du connecteur : autorisation refusée.") reject(cause); return new Response("Retour refusé.", { status: 403, headers }); }
    }, this.options.configuration.callbackPort ?? 0);
    redirect = `http://127.0.0.1:${receiver.port}/oauth/callback`;
    const abort = () => reject(error("autorisation interrompue ou délai dépassé.")); signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted(); const m = await this.#discover(signal);
      let clientId = this.options.configuration.clientId, clientSecret = this.options.configuration.clientSecret;
      if (!clientId) {
        if (!m.registration_endpoint) throw error("configurez oauth.clientId ; enregistrement dynamique absent.");
        const registration = await this.#json(m.registration_endpoint, signal, { client_name: this.options.name, redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" });
        if (!text(registration.client_id) || registration.client_secret !== undefined && !text(registration.client_secret)) throw error("enregistrement dynamique invalide.");
        clientId = registration.client_id; if (typeof registration.client_secret === "string") clientSecret = registration.client_secret;
      }
      const address = secureConnectorUrl(m.authorization_endpoint);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirect, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state, resource: this.#resource })) address.searchParams.set(key, value);
      if (this.options.configuration.scopes?.length) address.searchParams.set("scope", this.options.configuration.scopes.join(" "));
      const manual = ui.authorize(address.href, signal).then(value => { if (!value) throw error("autorisation annulée."); return parse(value); });
      const code = await Promise.race([returned, manual]); life.abort(); parent.throwIfAborted();
      const exchangeSignal = AbortSignal.any([parent, AbortSignal.timeout(30000)]);
      const body = new URLSearchParams({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: redirect, code_verifier: verifier, resource: this.#resource }); if (clientSecret) body.set("client_secret", clientSecret);
      const t = this.#token(await this.#json(m.token_endpoint, exchangeSignal, body), { resource: this.#resource, issuer: m.issuer, clientId, ...(clientSecret ? { clientSecret } : {}), tokenEndpoint: m.token_endpoint, ...(m.revocation_endpoint ? { revocationEndpoint: m.revocation_endpoint } : {}) });
      return await this.#locked(exchangeSignal, async () => { if (this.#lifecycle() !== generation) throw error("connexion annulée par une déconnexion."); return this.#save(t, exchangeSignal); });
    } catch (cause) { if (cause instanceof Error && cause.message.startsWith("Authentification du connecteur :")) throw cause; throw error("parcours impossible ; vérifiez le réseau et le trousseau."); }
    finally { life.abort(); signal.removeEventListener("abort", abort); receiver.close({flushResponse:true}); }
  }
  async signOut(signal: AbortSignal, expectedGeneration?: string): Promise<boolean> {
    return this.#locked(AbortSignal.timeout(30000), async () => {
      let t: Token | undefined; try { t = await this.#stored(); } catch { /* An invalid entry still has to be removable. */ }
      if (expectedGeneration !== undefined && t?.generation !== expectedGeneration) return false;
      writeAtomic(this.#lock + ".generation", Buffer.from(randomBytes(16).toString("hex")), currentPlatform(), true);
      if (t?.revocationEndpoint) { const body = new URLSearchParams({ token: t.refresh ?? t.access, client_id: t.clientId }); if (t.clientSecret) body.set("client_secret", t.clientSecret);
        try { const response = await this.options.fetch(secureConnectorUrl(t.revocationEndpoint), { method: "POST", body, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) }); await response.body?.cancel(); } catch {} }
      await this.options.vault.remove(this.options.service, this.#account);
      if (await this.options.vault.read(this.options.service, this.#account) !== undefined) throw error("suppression du trousseau non confirmée.");
      return true;
    });
  }
}
