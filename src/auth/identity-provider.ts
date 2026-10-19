// Implements: SPEC-MCP-007 (managed OIDC, RFC 8693 / ID-JAG, RFC 7523, refresh and administrator fallback).
// Supports: SPEC-MCP-006 (shared PKCE, vault and lifecycle locks), SPEC-API-012 (managed identity boundary).
import { createHash, createPublicKey, verify, type JsonWebKeyInput } from "node:crypto";
import { ConnectorOAuth, DelegationRefused, clientBasic, type DelegatedGrant, type Metadata, type OAuthConfiguration } from "../connectors/oauth";
import type { CredentialVault } from "../platform/credential-vault";
import { secureConnectorUrl } from "../connectors/url";

export interface IdentityProviderConnector {
  readonly name: string; readonly resource: string; readonly authorizationServer: string;
  readonly clientId: string; readonly clientSecret: string; readonly scopes?: readonly string[];
}
export interface IdentityProviderConfiguration {
  readonly issuer: string; readonly clientId: string; readonly clientSecret: string; readonly callbackPort?: number;
  readonly allowOAuthFallback?: boolean; readonly connectors: readonly IdentityProviderConnector[];
}
interface Options {
  readonly remember?: (value: string) => void;
  readonly configuration: IdentityProviderConfiguration; readonly configDir: string; readonly service: string;
  readonly vault: CredentialVault; readonly fetch: typeof fetch; readonly variables: Readonly<Record<string, string | undefined>>;
  readonly permitted: () => boolean; readonly timeoutMs: number; readonly now?: () => number;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 32768 && !/[\u0000-\u001f\u007f]/.test(value);
const error = () => new Error("Authentification du fournisseur d’identité impossible ; vérifiez la configuration gérée et le réseau.");
const ID_JAG = "urn:ietf:params:oauth:token-type:id-jag";
export function identityProviderSecretVariables(configuration: IdentityProviderConfiguration | undefined): string[] {
  if (!configuration) return [];
  return [configuration.clientSecret, ...configuration.connectors.map(c => c.clientSecret)].flatMap(reference => { const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(reference); return match ? [match[1]!] : []; });
}
function endpoint(value: string, issuer = false): URL { const url = secureConnectorUrl(value); if (url.protocol !== "https:" || issuer && url.search) throw error(); return url; }
function scopeWithin(value: unknown, scopes: readonly string[] | undefined): boolean { return value === undefined ? !scopes?.length : typeof value === "string" && value.split(" ").filter(Boolean).every(scope => (scopes ?? []).includes(scope)); }
function secret(reference: string, variables: Options["variables"]): string {
  const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(reference), value = match ? variables[match[1]!] : undefined;
  if (!text(value)) throw new Error("Secret client du fournisseur d’identité absent ; une référence d’environnement gérée est exigée.");
  return value;
}
/** One human login per managed provider and local profile; connector assertions never reach another resource. */
export class ManagedIdentityProvider {
  readonly #binding: string; readonly #secret: string; readonly #connectors = new Map<string, IdentityProviderConnector>();
  #client?: ConnectorOAuth; #metadata?: Record<string, unknown>; #opening?: Promise<ConnectorOAuth>;
  constructor(readonly options: Options) {
    const c = options.configuration; endpoint(c.issuer, true);
    if (!text(c.clientId) || !Array.isArray(c.connectors) || c.connectors.length > 100) throw error();
    this.#secret = secret(c.clientSecret, options.variables);
    options.remember?.(this.#secret);
    this.#binding = createHash("sha256").update(JSON.stringify(c)).digest("hex");
    for (const connector of c.connectors) {
      if (!/^[a-z0-9][a-z0-9-]{1,47}$/.test(connector.name) || this.#connectors.has(connector.name) || !text(connector.clientId)) throw error();
      endpoint(connector.resource); endpoint(connector.authorizationServer, true); secret(connector.clientSecret, options.variables);
      if (connector.scopes !== undefined && (!Array.isArray(connector.scopes) || connector.scopes.length > 100 || connector.scopes.some((scope: unknown) => typeof scope !== "string" || !/^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(scope)))) throw error();
      this.#connectors.set(connector.name, connector);
    }
  }
  #check(): void { if (!this.options.permitted()) throw new Error("Fournisseur d’identité géré modifié ou révoqué ; redémarrez la session."); }
  async #json(url: string, parent: AbortSignal, body?: URLSearchParams, credentials?: { client: string; secret: string }, exchange = false): Promise<Record<string, unknown>> {
    this.#check(); const signal = AbortSignal.any([parent, AbortSignal.timeout(30000)]);
    const response = await this.options.fetch(endpoint(url), { signal, redirect: "error", headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}), ...(credentials ? { Authorization: clientBasic(credentials.client, credentials.secret) } : {}) }, ...(body ? { method: "POST", body: body.toString() } : {}) });
    if (!response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) { await response.body?.cancel(); throw error(); }
    const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
    let result: unknown;
    try { for (;;) { const part = await reader.read(); if (part.done) break; if ((size += part.value.byteLength) > 262144) throw error(); chunks.push(part.value); } result = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw error(); } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    this.#check(); signal.throwIfAborted();
    if (!object(result)) throw error();
    for (const name of ["access_token", "refresh_token", "id_token"]) if (text(result[name])) this.options.remember?.(result[name]);
    if (!response.ok) { if (exchange && [400, 403].includes(response.status) && typeof result.error === "string" && ["access_denied", "invalid_grant", "invalid_target", "invalid_scope", "unauthorized_client", "interaction_required", "insufficient_user_authentication"].includes(result.error)) throw new DelegationRefused(); throw error(); }
    return result;
  }
  async #openid(signal: AbortSignal): Promise<ConnectorOAuth> {
    this.#check(); if (this.#client) return this.#client;
    if (this.#opening) return this.#opening;
    const opening = (async () => {
      const c = this.options.configuration, m = await this.#json(c.issuer.replace(/\/$/, "") + "/.well-known/openid-configuration", signal);
      if (m.issuer !== c.issuer || !text(m.authorization_endpoint) || !text(m.token_endpoint) || !text(m.jwks_uri) || !Array.isArray(m.id_token_signing_alg_values_supported) || !m.id_token_signing_alg_values_supported.includes("RS256") || !Array.isArray(m.code_challenge_methods_supported) || !m.code_challenge_methods_supported.includes("S256") || m.token_endpoint_auth_methods_supported !== undefined && (!Array.isArray(m.token_endpoint_auth_methods_supported) || !m.token_endpoint_auth_methods_supported.includes("client_secret_basic"))) throw error();
      for (const url of [m.authorization_endpoint, m.token_endpoint, m.jwks_uri, m.revocation_endpoint]) if (url !== undefined) { if (!text(url)) throw error(); endpoint(url); }
      this.#metadata = m;
      return this.#client = new ConnectorOAuth({ name: `identity-provider-${this.#binding}`, url: c.issuer, credentialNamespace: "identity-provider", configDir: this.options.configDir, service: this.options.service, vault: this.options.vault, fetch: this.options.fetch, timeoutMs: this.options.timeoutMs, now: this.options.now, remember: this.options.remember, permitted: this.options.permitted, clientAuthentication: "client_secret_basic", configuration: { clientId: c.clientId, clientSecret: this.#secret, callbackPort: c.callbackPort, scopes: ["openid", "offline_access"] }, explicitMetadata: { issuer: c.issuer, authorization_endpoint: m.authorization_endpoint, token_endpoint: m.token_endpoint, ...(typeof m.revocation_endpoint === "string" ? { revocation_endpoint: m.revocation_endpoint } : {}) }, validateIdentity: async (token, signal, checks) => {
        const claims = await this.#jwt(token, signal), audience = claims.aud;
        if (!(audience === c.clientId || Array.isArray(audience) && audience.length > 0 && audience.length <= 16 && audience.every(text) && audience.includes(c.clientId)) || claims.azp !== undefined && claims.azp !== c.clientId || Array.isArray(audience) && audience.length > 1 && claims.azp !== c.clientId || checks.subject !== undefined && claims.sub !== checks.subject || checks.requiredNonce && claims.nonce !== checks.nonce || claims.nonce !== undefined && claims.nonce !== checks.nonce) throw error();
        if (claims.at_hash !== undefined && claims.at_hash !== createHash("sha256").update(checks.accessToken).digest().subarray(0, 16).toString("base64url")) throw error();
        return { subject: claims.sub as string, expiresAt: (claims.exp as number) * 1000 };
      } });
    })();
    this.#opening = opening;
    try { return await opening; } finally { if (this.#opening === opening) this.#opening = undefined; }
  }
  async #jwt(token: string, signal: AbortSignal): Promise<Record<string, unknown>> {
    if (!text(token) || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw error();
    const [headerText, payload, signature] = token.split("."); let header: unknown, claims: unknown;
    try { header = JSON.parse(Buffer.from(headerText!, "base64url").toString("utf8")); claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8")); } catch { throw error(); }
    const now = (this.options.now?.() ?? Date.now()) / 1000;
    if (!object(header) || header.alg !== "RS256" || header.crit !== undefined || !text(header.kid) || !object(claims) || claims.iss !== this.options.configuration.issuer || !text(claims.sub) || typeof claims.exp !== "number" || !Number.isFinite(claims.exp) || claims.exp <= now || typeof claims.iat !== "number" || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.exp <= claims.iat || claims.exp - claims.iat > 86400 || claims.nbf !== undefined && (typeof claims.nbf !== "number" || !Number.isFinite(claims.nbf) || claims.nbf > now + 60)) throw error();
    const jwks = await this.#json(this.#metadata!.jwks_uri as string, signal);
    if (!Array.isArray(jwks.keys) || jwks.keys.length > 100) throw error();
    const matching = jwks.keys.filter((key: unknown) => object(key) && key.kid === header.kid);
    const key: unknown = matching[0];
    if (matching.length !== 1 || !object(key) || key.kty !== "RSA" || !text(key.n) || !text(key.e) || Buffer.from(key.n, "base64url").length < 256 || key.alg !== undefined && key.alg !== "RS256" || key.use !== undefined && key.use !== "sig" || key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes("verify"))) throw error();
    try { if (!verify("RSA-SHA256", Buffer.from(`${headerText}.${payload}`), createPublicKey({ key: key as JsonWebKeyInput["key"], format: "jwk" }), Buffer.from(signature!, "base64url"))) throw error(); } catch { throw error(); }
    return claims;
  }
  connector(name: string, resource: string): { readonly configuration: OAuthConfiguration; readonly delegation: DelegatedGrant; readonly clientAuthentication: "client_secret_basic" } | undefined {
    const c = this.#connectors.get(name); if (!c) return undefined;
    if (secureConnectorUrl(resource).href !== endpoint(c.resource).href) throw new Error("URL du connecteur différente de la ressource autorisée par l’organisation.");
    const clientSecret = secret(c.clientSecret, this.options.variables);
    this.options.remember?.(clientSecret);
    return { configuration: { clientId: c.clientId, clientSecret, scopes: c.scopes }, clientAuthentication: "client_secret_basic", delegation: {
      binding: this.#binding,
      allowFallback: this.options.configuration.allowOAuthFallback === true,
      permitted: () => this.options.permitted(),
      signIn: async (ui, signal) => { const client = await this.#openid(signal); if (!await client.identity(signal)) await client.signIn({ ...ui, confirm: (_name, scope) => ui.confirm(this.options.configuration.issuer, scope) }, signal); this.#check(); },
      acquire: async (metadata: Metadata, signal) => {
        this.#check(); if (metadata.issuer !== c.authorizationServer) throw new Error("Serveur d’autorisation différent de celui fixé par l’organisation.");
        const client = await this.#openid(signal), identity = await client.identity(signal); if (!identity) return undefined;
        const body = new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:token-exchange", requested_token_type: ID_JAG, subject_token_type: "urn:ietf:params:oauth:token-type:id_token", subject_token: identity.token, audience: c.authorizationServer, resource: endpoint(c.resource).href }); if (c.scopes?.length) body.set("scope", c.scopes.join(" "));
        const result = await this.#json(this.#metadata!.token_endpoint as string, signal, body, { client: this.options.configuration.clientId, secret: this.#secret }, true);
        if (result.issued_token_type !== ID_JAG || result.token_type !== "N_A" || !text(result.access_token)) throw error();
        const assertion = await this.#jwt(result.access_token, signal), audience = assertion.aud;
        if (!(audience === c.authorizationServer || Array.isArray(audience) && audience.length === 1 && audience[0] === c.authorizationServer) || assertion.sub !== identity.subject || assertion.client_id !== c.clientId || assertion.resource !== endpoint(c.resource).href || !scopeWithin(assertion.scope, c.scopes) || assertion.authorization_details !== undefined) throw error();
        const encodedHeader: unknown = JSON.parse(Buffer.from(result.access_token.split(".")[0]!, "base64url").toString("utf8")); if (!object(encodedHeader) || encodedHeader.typ !== "oauth-id-jag+jwt") throw error();
        const token = await this.#json(metadata.token_endpoint, signal, new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: result.access_token }), { client: c.clientId, secret: clientSecret }, true);
        if (token.resource !== endpoint(c.resource).href || !scopeWithin(token.scope, c.scopes) || token.authorization_details !== undefined) throw error();
        return token;
      },
    } };
  }
}
