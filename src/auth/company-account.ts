// Implements: SPEC-API-028 (identity-only OAuth, vault separation and controlled service access), SPEC-API-023, SPEC-API-012.
// Supports: gap E-173.
import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ConnectorOAuth, OAuthGenerationChanged, type OAuthUi } from "../connectors/oauth";
import type { CredentialVault } from "../platform/credential-vault";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { currentPlatform } from "../platform/system";
import { writeAtomic } from "../tools/text-file";
import {remoteEvents} from "../remote/events";

export interface AccountProfile { readonly method: "company"; readonly account: string; readonly organization: { readonly id: string; readonly name: string }; readonly roles: readonly string[]; readonly expiresAt: number; readonly updatedAt: number }
export type CompanyService = "account" | "settings" | "policy" | "memory" | "metrics" | "sessions" | "triggers" | "connectors" | "events" | "share" | "speech";
interface Options {
  readonly configDir: string; readonly vault: CredentialVault; readonly keychainService: string;
  readonly authorizeUrl: string; readonly tokenUrl: string; readonly revokeUrl?: string; readonly clientId: string;
  readonly services: Readonly<Partial<Record<CompanyService, string>>>;
  readonly fetch: typeof fetch; readonly forceOrganization?: () => string | undefined;
  readonly now?: () => number;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/.test(value);
function endpoint(value: string): URL { const url = new URL(value); if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error("Les services du compte exigent une adresse HTTPS sans identifiants."); return url; }
async function json(response: Response): Promise<unknown> {
  if (!response.ok || !response.body || !response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) { await response.body?.cancel(); throw new Error(`Service du compte indisponible (${response.status}).`); }
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const part = await reader.read(); if (part.done) break; if ((bytes += part.value.byteLength) > 262144) throw new Error("Réponse du compte trop volumineuse."); parts.push(part.value); } return JSON.parse(Buffer.concat(parts).toString("utf8")); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export class CompanyAccount {
  readonly #oauth: ConnectorOAuth;
  readonly #services = new Map<CompanyService, URL>();
  readonly #profileFile: string;
  constructor(readonly options: Options) {
    const authorize = endpoint(options.authorizeUrl), token = endpoint(options.tokenUrl); if (options.revokeUrl) endpoint(options.revokeUrl);
    if (!options.clientId || options.clientId.length > 256 || /[\u0000-\u001f\u007f]/.test(options.clientId)) throw new Error("Identifiant OAuth du compte invalide.");
    for (const [name, value] of Object.entries(options.services)) if (value) this.#services.set(name as CompanyService, endpoint(value));
    const resource = this.#services.get("account"); if (!resource) throw new Error("Service de profil absent de la configuration de marque.");
    this.#profileFile = join(options.configDir, "company-profile.json");
    this.#oauth = new ConnectorOAuth({ name: "company-account", url: resource.href, credentialNamespace: "company-account", configDir: options.configDir, service: options.keychainService, vault: options.vault, fetch: options.fetch, now: options.now, timeoutMs: 180000,
      configuration: { clientId: options.clientId, scopes: ["openid", "profile", "organization"] }, explicitMetadata: { issuer: authorize.origin, authorization_endpoint: authorize.href, token_endpoint: token.href, ...(options.revokeUrl ? { revocation_endpoint: options.revokeUrl } : {}) },
    });
  }
  async signIn(ui: OAuthUi, signal: AbortSignal): Promise<AccountProfile> {
    ordinaryPrivateFile(this.#profileFile, 32768); if (existsSync(this.#profileFile)) unlinkSync(this.#profileFile);
    const generation = await this.#oauth.signIn(ui, signal);
    try { return (await this.#validatedProfile(signal, generation)).profile; } catch (error) { await this.#signOut(AbortSignal.timeout(30000), generation); throw error; }
  }
  async signOut(signal: AbortSignal): Promise<void> {
    await this.#signOut(signal);
  }
  async #signOut(signal: AbortSignal, generation?: string): Promise<void> {
    const removed = await this.#oauth.signOut(signal, generation);
    if (removed) { ordinaryPrivateFile(this.#profileFile, 32768); if (existsSync(this.#profileFile)) { if (generation === undefined) unlinkSync(this.#profileFile); else { const raw: unknown = JSON.parse(readPrivateText(this.#profileFile, 32768)); if (object(raw) && raw.generation === generation) unlinkSync(this.#profileFile); } } }
  }
  async profile(): Promise<AccountProfile | undefined> { return (await this.#cachedProfile())?.profile; }
  /** Non-secret login generation used to invalidate session eligibility after an account change. */
  async sessionBinding(): Promise<string | undefined> { const current = await this.#cachedProfile(); return current ? JSON.stringify([current.generation, current.profile.account, current.profile.organization.id]) : undefined; }
  async #cachedProfile(): Promise<{ profile: AccountProfile; generation: string } | undefined> {
    const token = await this.#oauth.info(); if (!token) return undefined;
    if (!existsSync(this.#profileFile)) return undefined;
    const raw: unknown = JSON.parse(readPrivateText(this.#profileFile, 32768));
    if (!object(raw) || raw.generation !== token.generation) return undefined;
    if (typeof token.generation !== "string") return undefined;
    const profile = this.#parseProfile(raw), forced = this.options.forceOrganization?.(); if (forced && profile.organization.id !== forced) { await this.#signOut(AbortSignal.timeout(30000), token.generation); throw new Error(`Ce poste exige un compte de l’organisation ${forced}.`); } return { profile, generation: token.generation };
  }
  #parseProfile(raw: unknown): AccountProfile {
    if (!object(raw) || !text(raw.account) || !object(raw.organization) || !text(raw.organization.id) || !text(raw.organization.name) || !Array.isArray(raw.roles) || raw.roles.length > 32 || !raw.roles.every(text) || typeof raw.expiresAt !== "number" || !Number.isFinite(raw.expiresAt) || typeof raw.updatedAt !== "number" || !Number.isFinite(raw.updatedAt)) throw new Error("Profil du compte invalide.");
    return { method: "company", account: raw.account, organization: { id: raw.organization.id, name: raw.organization.name }, roles: [...raw.roles] as string[], expiresAt: raw.expiresAt, updatedAt: raw.updatedAt };
  }
  async refreshProfile(signal: AbortSignal): Promise<AccountProfile> { return (await this.#validatedProfile(signal)).profile; }
  async #validatedProfile(signal: AbortSignal, expectedGeneration?: string): Promise<{ profile: AccountProfile; generation: string }> {
    if (expectedGeneration !== undefined && (await this.#oauth.info())?.generation !== expectedGeneration) throw new Error("Connexion remplacée pendant son ouverture.");
    let before = await this.#oauth.info(), raw = await this.request("account", "profile", undefined, signal), token = await this.#oauth.info();
    if (before?.generation !== token?.generation) { before = token; raw = await this.request("account", "profile", undefined, signal); token = await this.#oauth.info(); if (before?.generation !== token?.generation) throw new Error("Connexion modifiée pendant la lecture du profil."); }
    if (!object(raw) || !token || typeof token.generation !== "string" || expectedGeneration !== undefined && token.generation !== expectedGeneration) throw new Error("Profil du compte absent ou remplacé.");
    const profile = this.#parseProfile({ ...raw, expiresAt: token.expiresAt, updatedAt: this.options.now?.() ?? Date.now() });
    const forced = this.options.forceOrganization?.(); if (forced && forced !== profile.organization.id) { await this.#signOut(signal, token.generation); throw new Error(`Ce poste exige un compte de l’organisation ${forced}.`); }
    ordinaryPrivateFile(this.#profileFile, 32768); writeAtomic(this.#profileFile, Buffer.from(JSON.stringify({ ...profile, generation: token.generation })), currentPlatform(), true); return { profile, generation: token.generation };
  }
  async request(service: CompanyService, path: string, body: unknown, parent: AbortSignal, identity?: { readonly organizationId: string; readonly account?: string }): Promise<unknown> {
    return json(await this.#response(service,path,body,AbortSignal.any([parent,AbortSignal.timeout(15000)]),identity));
  }
  async *events(path:string,after:number,signal:AbortSignal,identity?:{readonly organizationId:string;readonly account?:string}):AsyncGenerator<unknown>{
    if(!Number.isSafeInteger(after)||after<0)throw new Error("Curseur distant invalide.");
    const response=await this.#response("sessions",path+`?after=${after}`,undefined,signal,identity,"text/event-stream");
    yield*remoteEvents(response,signal);
  }
  async #response(service: CompanyService, path: string, body: unknown, parent: AbortSignal, identity?: { readonly organizationId: string; readonly account?: string },accept="application/json"): Promise<Response> {
    const profileRequest = service === "account" && path === "profile", required = this.options.forceOrganization?.();
    let verified = !profileRequest ? required ? await this.#validatedProfile(parent) : await this.#cachedProfile() ?? await this.#validatedProfile(parent) : undefined;
    const assertIdentity=()=>{if(identity&&(!verified||verified.profile.organization.id!==identity.organizationId||identity.account!==undefined&&verified.profile.account!==identity.account))throw new Error("Compte ou organisation modifiés pendant l’opération ; recommencez.");};assertIdentity();
    const base = this.#services.get(service); if (!base) throw new Error("Service absent de la configuration de marque.");
    const prefix = base.pathname.endsWith("/") ? base.pathname : base.pathname + "/", url = new URL(path, base.origin + prefix);
    if (url.origin !== base.origin || !url.pathname.startsWith(prefix) || url.username || url.password || url.hash) throw new Error("Adresse hors du service autorisé.");
    const handshake=new AbortController(),timer=setTimeout(()=>handshake.abort(),15000),signal=AbortSignal.any([parent,handshake.signal]);
    try {
    const authorize = async () => { try { return await this.#oauth.authorize(signal, { expectedGeneration: verified?.generation }); } catch (error) { if (!(error instanceof OAuthGenerationChanged) || profileRequest) throw error; verified = await this.#validatedProfile(signal);assertIdentity(); return this.#oauth.authorize(signal, { expectedGeneration: verified.generation }); } };
    let selected = await authorize();
    if (!selected) throw new Error("Connectez un compte de la société pour utiliser ce service.");
    const run = () => this.options.fetch(url, { method: body === undefined ? "GET" : "POST", headers: { Authorization: selected!.authorization, Accept: accept, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal });
    let response = await run();
    if (response.status === 401) { await response.body?.cancel(); if (!profileRequest) verified = await this.#validatedProfile(signal);assertIdentity(); selected = await this.#oauth.authorize(signal, { force: true, rejected: selected.authorization, rejectedVersion: selected.version, expectedGeneration: verified?.generation }); if (!selected) throw new Error("Connexion expirée ; reconnectez le compte."); response = await run(); }
    return response;
    }finally{clearTimeout(timer);}
  }
}
