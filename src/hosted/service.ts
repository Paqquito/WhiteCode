// Implements: SPEC-API-029 (delegated keys, ownership, encrypted storage and revocation), SPEC-PLA-002 (service scheduler).
// Supports: SPEC-MOD-014, SPEC-MOD-005 (session creation and service-owned budget admission).
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ModelEntry } from "../providers/catalog";
import { BudgetLedger, costOf } from "../engine/budget";
import type { BudgetState } from "../engine/budget";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";
import { securePrivateDirectory } from "../platform/private-file";
import { tryFileLock } from "../platform/file-lock";
import { handoffState, handoffHistory, handoffDigest, type HandoffState } from "../remote/handoff-state";
import type { HistoryMessage } from "../providers/types";

export interface HostedPrincipal { readonly account: string; readonly organizationId: string; readonly administrator: boolean }
export interface HostedProvider { readonly id: string; readonly baseUrl: string; readonly model: ModelEntry }
export interface HostedEnvironment { readonly id: string; readonly provider: string; readonly tools: readonly string[]; readonly connectors: readonly string[] }
interface Options {
  readonly directory: string; readonly encryptionKey: Uint8Array; readonly publicBaseUrl: string; readonly workerToken: string;
  readonly authenticate: (authorization: string | null) => Promise<HostedPrincipal | undefined>;
  readonly providers: readonly HostedProvider[]; readonly environments: readonly HostedEnvironment[]; readonly currency: string;
  readonly repositoryAccessible: (repository: string, owner: HostedPrincipal) => Promise<boolean>;
  readonly resolvePrincipal?: (account: string, organizationId: string) => Promise<HostedPrincipal | undefined>;
  readonly now?: () => number; readonly fetch?: typeof fetch; readonly scheduleIntervalMs?: number;
}
interface Ciphertext { nonce: string; ciphertext: string; tag: string }
interface Key { id: string; provider: string; label: string; lastFour: string; account?: string; organizationId: string; owner: "personal" | "organization"; maxCost?: number; encrypted?: Ciphertext }
interface Session {
  id: string; owner: HostedPrincipal; input: SessionInput; keyId: string; provider: string; status: "queued" | "running" | "completed" | "failed" | "stopped";
  createdAt: number; finishedAt?: number; reason?: string; result?: string; leaseHash?: string; leaseExpiresAt?: number; budget: BudgetState; effectiveMaxCost?: number; handoffPhase?: "preparing" | "ready" | "active"; workerStopped?: boolean;
}
interface SessionInput { repository: string; branch: string; commit: string; prompt: string; environment: string; tools: string[]; connectors: string[]; maxCost?: number; clientMaxCost?: number; maxDurationSeconds?: number; handoff?: {state:HandoffState;messages:HistoryMessage[];digest:string} }
interface History { date: number; duration: number; status: string; sessionId?: string; url?: string; reason?: string }
interface Trigger { id: string; owner: HostedPrincipal; input: SessionInput; name: string; cron: string; timeZone: string; paused: boolean; nextAt: number; lastWall?: string; history: History[] }
interface State { version: 1; keys: Key[]; policies: Record<string, { enforcedKey: boolean; managedMaxCost?: number }>; sessions: Session[]; triggers: Trigger[]; idempotency: Record<string, { digest: string; id: string }> }
class ServiceError extends Error { constructor(readonly status: number, message: string) { super(message); } }
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(v);
const text = (v: unknown, max: number): v is string => typeof v === "string" && !!v.trim() && v.length <= max && !/[\u0000\u001b]/.test(v);
const positive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const sameOwner = (a: HostedPrincipal, b: HostedPrincipal) => a.account === b.account && a.organizationId === b.organizationId;
const fail = (status: number, message: string): never => { throw new ServiceError(status, message); };
function endpoint(raw: string): URL {
  const url = new URL(raw);
  if (url.username || url.password || url.hash || url.search || url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname))) fail(400, "Adresse HTTPS de service requise.");
  return new URL(url.href.replace(/\/?$/, "/"));
}
function wallTime(time: number, timeZone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(time).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
function nextAt(cron: string, timeZone: string, after: number, lastWall?: string): number {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|[0-6])$/.exec(cron);
  if (!match || Number(match[1]) > 59 || Number(match[2]) > 23) return fail(400, "Planification quotidienne ou hebdomadaire invalide.");
  let format: Intl.DateTimeFormat;
  try { format = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }); } catch { return fail(400, "Fuseau horaire IANA invalide."); }
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  for (let time = Math.floor(after / 60000) * 60000 + 60000; time <= after + 8 * 86400000; time += 60000) {
    const parts = Object.fromEntries(format.formatToParts(time).map(part => [part.type, part.value]));
    if (Number(parts.minute) === Number(match[1]) && Number(parts.hour) === Number(match[2]) && (match[3] === "*" || parts.weekday === days[Number(match[3])]) && (!lastWall || wallTime(time, timeZone) > lastWall)) return time;
  }
  return fail(400, "Aucune échéance dans les huit prochains jours.");
}
/** The broker owns the provider credential. Workers receive a revocable capability for exactly one session. */
export class HostedService {
  readonly #file: string; readonly #key: Buffer; readonly #state: State; readonly #release: () => void;
  readonly #providers = new Map<string, HostedProvider>(); readonly #environments = new Map<string, HostedEnvironment>();
  readonly #requests = new Map<string, Set<AbortController>>(); readonly #ledgers = new Map<string, BudgetLedger>();
  readonly #handling = new Set<Promise<Response>>(); readonly #creating = new Set<string>();
  #timer?: ReturnType<typeof setInterval>; #ticking?: Promise<void>; #closed = false;
  constructor(readonly options: Options) {
    if (options.encryptionKey.length !== 32 || !/^[A-Z]{3}$/.test(options.currency) || !text(options.workerToken, 256) || options.workerToken.length < 32) throw Error("Configuration privée du service invalide.");
    endpoint(options.publicBaseUrl); this.#key = Buffer.from(options.encryptionKey);
    for (const provider of options.providers) {
      if (!identifier(provider.id) || this.#providers.has(provider.id) || provider.model.provider !== "openai_compatible") throw Error("Fournisseur de service invalide ou non pris en charge.");
      endpoint(provider.baseUrl); this.#providers.set(provider.id, provider);
    }
    for (const environment of options.environments) {
      if (!identifier(environment.id) || this.#environments.has(environment.id) || !this.#providers.has(environment.provider) || ![...environment.tools, ...environment.connectors].every(identifier)) throw Error("Environnement hébergé invalide.");
      this.#environments.set(environment.id, environment);
    }
    mkdirSync(options.directory, { recursive: true, mode: 0o700 }); securePrivateDirectory(options.directory);
    this.#file = join(options.directory, "state.json"); ordinaryPrivateFile(this.#file, 16 * 1024 * 1024);
    const release = tryFileLock(this.#file + ".lock"); if (!release) throw Error("Le service possède déjà un propriétaire actif."); this.#release = release;
    try {
      this.#state = existsSync(this.#file) ? JSON.parse(readPrivateText(this.#file, 16 * 1024 * 1024)) as State : { version: 1, keys: [], policies: {}, sessions: [], triggers: [], idempotency: {} };
      const s = this.#state;
      if (s.version !== 1 || !Array.isArray(s.keys) || !Array.isArray(s.sessions) || !Array.isArray(s.triggers) || !object(s.policies) || !object(s.idempotency)) throw Error("État du service invalide.");
      s.policies = Object.assign(Object.create(null) as State["policies"], s.policies);
      // Authenticate every stored ciphertext before the service accepts a request.
      for (const key of s.keys) if (key.encrypted) this.#decrypt(key);
      for (const session of s.sessions) {
        const ledger = new BudgetLedger(session.effectiveMaxCost, options.currency); ledger.restore(session.budget); this.#ledgers.set(session.id, ledger);
        ledger.journal(state => { session.budget = state; this.#save(); return true; });
        if (["queued", "running"].includes(session.status)) this.#finish(session, "stopped", "Service redémarré : exécution interrompue, état conservé.");
      }
      this.#save();
    } catch (error) { release(); this.#key.fill(0); throw error; }
  }
  #now() { return this.options.now?.() ?? Date.now(); }
  #save() {
    ordinaryPrivateFile(this.#file, 16 * 1024 * 1024);
    const bytes = Buffer.from(JSON.stringify(this.#state)); if (bytes.length > 16 * 1024 * 1024) throw Error("Capacité du magasin hébergé atteinte.");
    writeAtomic(this.#file, bytes, currentPlatform(), true);
  }
  #encrypt(secret: string, id: string): Ciphertext {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.#key, nonce); cipher.setAAD(Buffer.from(id));
    return { nonce: nonce.toString("base64"), ciphertext: Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]).toString("base64"), tag: cipher.getAuthTag().toString("base64") };
  }
  #decrypt(key: Key): string {
    if (!key.encrypted) return fail(409, "ERR-01 — Aucune clé de fournisseur confiée au service.");
    const decipher = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(key.encrypted.nonce, "base64")); decipher.setAAD(Buffer.from(key.id)); decipher.setAuthTag(Buffer.from(key.encrypted.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(key.encrypted.ciphertext, "base64")), decipher.final()]).toString("utf8");
  }
  #visible(key: Key, principal: HostedPrincipal) { return key.owner === "personal" ? key.account === principal.account : key.organizationId === principal.organizationId && principal.administrator; }
  #safeKey(key: Key) { return { id: key.id, provider: key.provider, label: key.label, lastFour: key.lastFour, owner: key.owner, revoked: !key.encrypted, ...(key.maxCost ? { maxCost: key.maxCost } : {}) }; }
  #resolve(owner: HostedPrincipal, provider: string): { key: Key; notice?: string } {
    const keys = this.#state.keys.filter(key => key.encrypted && key.provider === provider && (key.owner === "personal" ? key.account === owner.account : key.organizationId === owner.organizationId)), policy = this.#state.policies[owner.organizationId];
    const org = keys.find(key => key.owner === "organization"), personal = keys.find(key => key.owner === "personal" && key.account === owner.account);
    const key = policy?.enforcedKey ? org : personal ?? org;
    if (!key) return fail(409, "ERR-01 — Aucune clé de fournisseur confiée au service : déposez-en une dans la console.");
    return { key, ...(policy?.enforcedKey ? { notice: "ERR-04 — Votre organisation impose sa clé pour les exécutions distantes." } : {}) };
  }
  #sessionInput(raw: unknown): SessionInput {
    if (!object(raw) || !text(raw.repository, 4096) || !text(raw.branch, 240) || raw.branch.startsWith("-") || typeof raw.commit !== "string" || !/^[a-f0-9]{40,64}$/.test(raw.commit) || !text(raw.prompt, 32000)) return fail(400, "Demande de session distante invalide.");
    endpoint(raw.repository);
    const environment = typeof raw.environment === "string" ? this.#environments.get(raw.environment) : this.#environments.size === 1 ? [...this.#environments.values()][0] : undefined;
    if (!environment) return fail(400, "Environnement hébergé requis ou inconnu.");
    for (const cap of [raw.maxCost, raw.clientMaxCost]) if (cap !== undefined && !positive(cap)) return fail(400, "Plafond de coût invalide.");
    if (raw.currency !== undefined && raw.currency !== this.options.currency) return fail(400, "Devise différente de celle du service.");
    if (raw.maxDurationSeconds !== undefined && (!Number.isSafeInteger(raw.maxDurationSeconds) || Number(raw.maxDurationSeconds) < 1 || Number(raw.maxDurationSeconds) > 86400)) return fail(400, "Durée maximale invalide.");
    const selected = (name: "tools" | "connectors") => {
      const value = raw[name] ?? environment[name];
      if (!Array.isArray(value) || value.length > 100 || !value.every(entry => identifier(entry) && environment[name].includes(entry)) || new Set(value).size !== value.length) return fail(403, "Outils ou connecteurs hors de l’environnement autorisé.");
      return [...value] as string[];
    };
    let handoff: SessionInput["handoff"];
    if(raw.handoff!==undefined){
      if(!object(raw.handoff))return fail(400,"Transfert invalide.");
      const state=handoffState(raw.handoff.state),messages=handoffHistory(raw.handoff.messages),digest=handoffDigest(state,messages);
      if(raw.handoff.digest!==digest||state.repository!==raw.repository||state.transferBranch!==raw.branch||state.snapshot!==raw.commit)return fail(400,"État de transfert incohérent.");
      handoff={state,messages,digest};
    }
    return { repository: raw.repository, branch: raw.branch, commit: raw.commit, prompt: raw.prompt, environment: environment.id, tools: selected("tools"), connectors: selected("connectors"), ...(positive(raw.maxCost) ? { maxCost: raw.maxCost } : {}), ...(positive(raw.clientMaxCost) ? { clientMaxCost: raw.clientMaxCost } : {}), ...(raw.maxDurationSeconds ? { maxDurationSeconds: Number(raw.maxDurationSeconds) } : {}),...(handoff?{handoff}:{}) };
  }
  #session(id: string, owner: HostedPrincipal) { const session = this.#state.sessions.find(row => row.id === id && sameOwner(row.owner, owner)); if (!session) return fail(404, "Session inconnue."); return session; }
  #safeSession(session: Session) { return { id: session.id, url: new URL("sessions/" + session.id, endpoint(this.options.publicBaseUrl)).href, status: session.status, ...(session.effectiveMaxCost !== undefined ? { effectiveMaxCost: session.effectiveMaxCost } : {}), ...(session.reason ? { reason: session.reason } : {}), ...(session.result ? { result: session.result } : {}),...(session.input.handoff?{handoffPhase:session.handoffPhase,handoffDigest:session.input.handoff.digest,workerStopped:session.workerStopped===true}:{}), cost: this.#ledgers.get(session.id)?.snapshot.confirmed ?? 0 }; }
  #finish(session: Session, status: Session["status"], reason?: string) {
    if (["completed", "failed", "stopped"].includes(session.status)) return;
    session.status = status; session.finishedAt = this.#now(); if (reason) session.reason = reason;
    for (const request of this.#requests.get(session.id) ?? []) request.abort();
    for (const trigger of this.#state.triggers) for (const entry of trigger.history) if (entry.sessionId === session.id) { entry.status = status; entry.duration = Math.max(0, session.finishedAt - entry.date); if (reason) entry.reason = reason; }
    this.#save();
  }
  async #create(owner: HostedPrincipal, input: SessionInput, transaction?: { path?: string; body?: Record<string, unknown>; created?: (session: Session) => void }) {
    if (!await this.options.repositoryAccessible(input.repository, owner)) return fail(403, "Dépôt inaccessible au service.");
    if (this.options.resolvePrincipal && !await this.options.resolvePrincipal(owner.account, owner.organizationId)) return fail(403, "Membre absent de l’organisation.");
    if (this.#closed) return fail(503, "Service arrêté.");
    const provider = this.#providers.get(this.#environments.get(input.environment)!.provider)!, selected = this.#resolve(owner, provider.id);
    const caps = [input.maxCost, input.clientMaxCost, selected.key.maxCost, this.#state.policies[owner.organizationId]?.managedMaxCost].filter(positive), cap = caps.length ? Math.min(...caps) : undefined;
    if (cap !== undefined && !provider.model.pricing) return fail(409, "Plafond invérifiable : tarif du modèle absent du catalogue du service.");
    if (this.#state.sessions.length >= 10000) return fail(409, "Capacité de sessions atteinte.");
    const ledger = new BudgetLedger(cap, this.options.currency), session: Session = { id: randomUUID(), owner: { ...owner }, input, keyId: selected.key.id, provider: provider.id, status: "queued", createdAt: this.#now(), budget: ledger.state, ...(cap !== undefined ? { effectiveMaxCost: cap } : {}) };
    this.#state.sessions.push(session); this.#ledgers.set(session.id, ledger);
    if(input.handoff)session.handoffPhase="preparing";
    if (transaction?.path && transaction.body) this.#remember(transaction.path, owner, transaction.body, session.id, false);
    transaction?.created?.(session);
    ledger.journal(state => { session.budget = state; this.#save(); return true; }); this.#save();
    return { ...this.#safeSession(session), key: this.#safeKey(selected.key), ...(selected.notice ? { notice: selected.notice } : {}) };
  }
  async #body(request: Request): Promise<Record<string, unknown>> {
    if (request.method === "GET") return {};
    if (request.method !== "POST" || !request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) return fail(415, "Corps JSON requis.");
    const bytes = await request.arrayBuffer(); if (bytes.byteLength > 1024 * 1024) return fail(413, "Demande trop volumineuse.");
    try { const body: unknown = JSON.parse(Buffer.from(bytes).toString("utf8")); if (object(body)) return body; } catch {} return fail(400, "Objet JSON invalide.");
  }
  #work(id: string, authorization: string | null): Session {
    const token = authorization?.replace(/^Bearer /, "") ?? "", session = this.#state.sessions.find(row => row.id === id);
    const digest = hash(token); if (!session?.leaseHash || !timingSafeEqual(Buffer.from(session.leaseHash, "hex"), Buffer.from(digest, "hex"))) return fail(403, "Bail de travail invalide.");
    if (session.status !== "running" || !session.leaseExpiresAt || session.leaseExpiresAt <= this.#now()) { this.#finish(session, "stopped", "Bail expiré ou exécution arrêtée."); return fail(409, "Exécution arrêtée."); }
    if (!this.#state.keys.find(key => key.id === session.keyId)?.encrypted) { this.#finish(session, "stopped", "ERR-03 — Clé confiée révoquée."); return fail(409, "ERR-03 — Clé confiée révoquée."); }
    return session;
  }
  async #proxy(session: Session, body: Record<string, unknown>): Promise<Response> {
    const provider = this.#providers.get(session.provider)!, key = this.#state.keys.find(row => row.id === session.keyId)!, secret = this.#decrypt(key), ledger = this.#ledgers.get(session.id)!;
    if (body.model !== provider.model.id || !Array.isArray(body.messages) || body.messages.length > 2000) return fail(400, "Modèle ou messages hors du contrat de session.");
    const outputParameter = provider.model.providerOptions?.maxTokensParameter === "max_completion_tokens" ? "max_completion_tokens" : "max_tokens";
    if (body.n !== undefined && body.n !== 1 || body.best_of !== undefined || body.max_tokens !== undefined && body.max_completion_tokens !== undefined) return fail(400, "Une seule réponse et une seule limite de sortie sont autorisées.");
    const requested = Number(body.max_tokens ?? body.max_completion_tokens ?? provider.model.maxOutputTokens);
    if (!Number.isSafeInteger(requested) || requested < 1 || requested > provider.model.maxOutputTokens) return fail(400, "Limite de sortie hors catalogue.");
    const pricing = provider.model.pricing, bound = pricing ? (Math.min(Buffer.byteLength(JSON.stringify(body)), provider.model.contextWindow) * Math.max(pricing.inputPerMTok, pricing.cacheReadPerMTok, pricing.cacheWritePerMTok) + requested * pricing.outputPerMTok) / 1000000 : undefined;
    const admission = ledger.admit(bound, "hosted-proxy"); if (!admission.admitted) { this.#finish(session, "stopped", admission.message); return fail(409, admission.message); }
    this.#save();
    const controller = new AbortController(); const running = this.#requests.get(session.id) ?? new Set<AbortController>(); running.add(controller); this.#requests.set(session.id, running);
    try {
      const forwarded = { ...body }; delete forwarded.max_tokens; delete forwarded.max_completion_tokens; forwarded[outputParameter] = requested;
      const response = await (this.options.fetch ?? fetch)(new URL("chat/completions", endpoint(provider.baseUrl)), { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + secret }, body: JSON.stringify(forwarded), redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]) });
      if (!response.ok) {
        await response.body?.cancel(); ledger.keepConservatively(admission.reservation);
        if ([401, 403].includes(response.status)) { key.encrypted = undefined; for (const affected of this.#state.sessions) if (affected.keyId === key.id) this.#finish(affected, "failed", "ERR-02 — Clé confiée refusée par le fournisseur."); this.#save(); }
        return new Response(JSON.stringify({ error: { message: "Appel fournisseur refusé ou indisponible." } }), { status: response.status, headers: { "content-type": "application/json" } });
      }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (!reader) throw Error("Empty response");
      try { for (;;) { const part = await reader.read(); if (part.done) break; if ((size += part.value.byteLength) > 8 * 1024 * 1024) throw Error("Oversized response"); chunks.push(part.value); } } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const content = Buffer.concat(chunks).toString("utf8");
      let usage: Record<string, unknown> | undefined;
      for (const line of response.headers.get("content-type")?.includes("event-stream") ? content.split(/\r?\n/).filter(line => line.startsWith("data: ")).map(line => line.slice(6)) : [content]) try { const value: unknown = JSON.parse(line); if (object(value) && object(value.usage)) usage = value.usage; } catch {}
      const conservativePricing = pricing ? { ...pricing, inputPerMTok: Math.max(pricing.inputPerMTok, pricing.cacheReadPerMTok, pricing.cacheWritePerMTok) } : undefined;
      if (usage && Number.isSafeInteger(usage.prompt_tokens) && Number(usage.prompt_tokens) >= 0 && Number.isSafeInteger(usage.completion_tokens) && Number(usage.completion_tokens) >= 0) ledger.settle(admission.reservation, costOf(conservativePricing, { inputTokens: Number(usage.prompt_tokens), outputTokens: Number(usage.completion_tokens), cacheReadTokens: 0, cacheWriteTokens: 0 })); else ledger.keepConservatively(admission.reservation);
      return new Response(content.split(secret).join("[redacted provider credential]"), { status: response.status, headers: { "content-type": response.headers.get("content-type") ?? "application/json" } });
    } catch { ledger.keepConservatively(admission.reservation); return fail(session.status === "running" ? 502 : 409, "Appel fournisseur interrompu ; état conservé."); }
    finally { running.delete(controller); }
  }
  handle(request: Request): Promise<Response> {
    const pending = this.#handle(request); this.#handling.add(pending); void pending.finally(() => this.#handling.delete(pending)); return pending;
  }
  async #handle(request: Request): Promise<Response> {
    try {
      if (this.#closed) return fail(503, "Service arrêté.");
      const url = new URL(request.url), eventsPath = /^\/sessions\/[a-zA-Z0-9_-]+\/events$/.test(url.pathname);
      if (url.hash || url.search && (!eventsPath || [...url.searchParams.keys()].some(key => key !== "after") || url.searchParams.getAll("after").length !== 1 || !/^\d{1,10}$/.test(url.searchParams.get("after") ?? ""))) return fail(400, "Paramètres d’adresse non pris en charge.");
      const path = url.pathname.replace(/^\//, ""), body = await this.#body(request), authorization = request.headers.get("authorization");
      if (request.method === "GET" && !/^(?:sessions\/[a-zA-Z0-9_-]+\/(?:status|events)|sessions\/environments|triggers\/list|console\/keys\/list)$/.test(path)) return fail(405, "Cette action exige POST.");
      const closed=/^work\/([a-zA-Z0-9_-]{1,128})\/closed$/.exec(path);
      if(closed){const session=this.#state.sessions.find(s=>s.id===closed[1]),digest=hash(authorization?.replace(/^Bearer /,"")??"");if(!session?.leaseHash||!timingSafeEqual(Buffer.from(session.leaseHash,"hex"),Buffer.from(digest,"hex")))return fail(403,"Bail de travail invalide.");session.workerStopped=true;this.#save();return Response.json({workerStopped:true});}
      const work = /^work\/([a-zA-Z0-9_-]{1,128})\/(v1\/chat\/completions|status|result|handoff-ready)$/.exec(path);
      if (work) {
        const session = this.#work(work[1]!, authorization);
        if (this.options.resolvePrincipal && !await this.options.resolvePrincipal(session.owner.account, session.owner.organizationId)) { this.#finish(session, "stopped", "Membre absent de l’organisation."); return fail(403, "Membre absent de l’organisation."); }
        this.#work(work[1]!, authorization);
        if(work[2]==="handoff-ready") {if(!session.input.handoff||session.handoffPhase!=="preparing"&&session.handoffPhase!=="ready"||body.digest!==session.input.handoff.digest)return fail(409,"Reprise incohérente.");session.handoffPhase="ready";this.#save();}
        if (work[2] === "v1/chat/completions") {if(session.input.handoff&&session.handoffPhase!=="active")return fail(409,"Transfert non activé.");return await this.#proxy(session, body);}
        if (work[2] === "result") { if (!Number.isSafeInteger(body.code) || !text(body.result, 128000)) return fail(400, "Résultat de travail invalide."); session.result = body.result; this.#finish(session, body.code === 0 ? "completed" : "failed"); }
        return Response.json(this.#safeSession(session));
      }
      if (path === "workers/next") {
        if (!authorization || !timingSafeEqual(Buffer.from(hash(authorization)), Buffer.from(hash("Bearer " + this.options.workerToken)))) return fail(403, "Identité de travailleur invalide.");
        let session: Session | undefined;
        for (const candidate of this.#state.sessions.filter(row => row.status === "queued")) {
          if (this.options.resolvePrincipal && !await this.options.resolvePrincipal(candidate.owner.account, candidate.owner.organizationId)) { this.#finish(candidate, "stopped", "Membre absent de l’organisation."); continue; }
          if (candidate.status !== "queued" || this.#closed) continue;
          session = candidate; break;
        }
        if (!session) return Response.json({ work: null });
        const lease = randomBytes(32).toString("hex"); session.leaseHash = hash(lease); session.leaseExpiresAt = this.#now() + (session.input.maxDurationSeconds ?? 3600) * 1000; session.status = "running"; this.#save();
        return Response.json({ id: session.id, ...session.input, model: this.#providers.get(session.provider)!.model, currency: this.options.currency, lease, ...(session.effectiveMaxCost !== undefined ? { maxCost: session.effectiveMaxCost } : {}) });
      }
      const owner = await this.options.authenticate(authorization); if (!owner || !identifier(owner.account) || !identifier(owner.organizationId)) return fail(401, "Compte de la société requis.");
      if (this.#closed) return fail(503, "Service arrêté.");
      if (path === "console/keys/deposit") {
        if (!identifier(body.provider) || !this.#providers.has(body.provider) || !text(body.label, 240) || typeof body.secret !== "string" || !/^[\x21-\x7e]{8,4096}$/.test(body.secret) || /["\\]/.test(body.secret) || !["personal", "organization"].includes(String(body.owner)) || body.maxCost !== undefined && !positive(body.maxCost)) return fail(400, "Dépôt de clé invalide.");
        if (body.owner === "organization" && !owner.administrator) return fail(403, "Administration d’organisation requise.");
        if (body.owner === "personal" && this.#state.policies[owner.organizationId]?.enforcedKey) return fail(403, "ERR-04 — Clé d’organisation imposée.");
        const provider = this.#providers.get(body.provider)!, secret = body.secret;
        const response = await (this.options.fetch ?? fetch)(new URL("chat/completions", endpoint(provider.baseUrl)), { method: "POST", headers: { authorization: "Bearer " + secret, "content-type": "application/json" }, body: JSON.stringify({ model: provider.model.id, messages: [{ role: "user", content: "Reply OK." }], max_tokens: 1 }), redirect: "error", signal: AbortSignal.timeout(15000) });
        await response.body?.cancel(); if (!response.ok) return fail(400, "Clé refusée ou vérification fournisseur indisponible.");
        if (this.#closed) return fail(503, "Service arrêté.");
        const current = await this.options.authenticate(authorization);
        if (!current || !sameOwner(current, owner) || body.owner === "organization" && !current.administrator) return fail(403, "Droits modifiés pendant la vérification de la clé.");
        if (body.owner === "personal" && this.#state.policies[owner.organizationId]?.enforcedKey) return fail(403, "ERR-04 — Clé d’organisation imposée.");
        for (const key of this.#state.keys.filter(key => key.provider === body.provider && key.owner === body.owner && (key.owner === "organization" ? key.organizationId === owner.organizationId : key.account === owner.account))) this.#revoke(key);
        const id = randomUUID(), key: Key = { id, provider: body.provider, label: body.label, lastFour: secret.slice(-4), owner: body.owner as Key["owner"], organizationId: owner.organizationId, ...(body.owner === "personal" ? { account: owner.account } : {}), ...(positive(body.maxCost) ? { maxCost: body.maxCost } : {}), encrypted: this.#encrypt(secret, id) };
        this.#state.keys.push(key); this.#save(); return Response.json(this.#safeKey(key));
      }
      if (path === "console/keys/list") return Response.json({ keys: this.#state.keys.filter(key => this.#visible(key, owner)).map(key => this.#safeKey(key)) });
      if (path === "console/keys/usage") { const key = this.#state.keys.find(key => key.id === body.id && this.#visible(key, owner)); if (!key) return fail(404, "Clé inconnue."); return Response.json({ items: this.#state.sessions.filter(session => session.keyId === key.id).map(session => ({ date: session.createdAt, ...this.#safeSession(session) })) }); }
      if (path === "console/keys/revoke") { const key = this.#state.keys.find(key => key.id === body.id && this.#visible(key, owner)); if (!key) return fail(404, "Clé inconnue."); this.#revoke(key); return Response.json({ revoked: true }); }
      if (path === "console/organization") {
        if (!owner.administrator) return fail(403, "Administration d’organisation requise.");
        if (typeof body.enforcedKey !== "boolean" || body.managedMaxCost !== undefined && !positive(body.managedMaxCost)) return fail(400, "Politique d’organisation invalide.");
        this.#state.policies[owner.organizationId] = { enforcedKey: body.enforcedKey, ...(positive(body.managedMaxCost) ? { managedMaxCost: body.managedMaxCost } : {}) }; this.#save(); return Response.json({ updated: true });
      }
      if (path === "sessions/repository-access") return Response.json({ accessible: text(body.repository, 4096) && await this.options.repositoryAccessible(body.repository, owner) });
      if (path === "sessions/environments") return Response.json({ environments: [...this.#environments.keys()].map(id => ({ id, name: id })) });
      if (path === "sessions/key-status") {
        const environment = this.#environments.get(typeof body.environment === "string" ? body.environment : [...this.#environments.keys()][0] ?? "");
        let key: Key | undefined; try { if (environment) key = this.#resolve(owner, environment.provider).key; } catch {}
        return Response.json({ delegatedKey: !!key, repositoryAccessible: text(body.repository, 4096) && await this.options.repositoryAccessible(body.repository, owner), ...(key?.maxCost ? { keyLimit: key.maxCost } : {}), ...(this.#state.policies[owner.organizationId]?.managedMaxCost ? { managedLimit: this.#state.policies[owner.organizationId]!.managedMaxCost } : {}) });
      }
      if (path === "sessions/create" || path === "sessions/handoff") {
        if(path==="sessions/handoff"&&!body.handoff||path==="sessions/create"&&body.handoff)return fail(400,"Route de transfert explicite requise.");
        const input = this.#sessionInput(body), found = this.#idempotent(path, owner, body); if (found) return Response.json(this.#safeSession(this.#session(found, owner)), { status: 200 });
        const creation = hash(JSON.stringify([path, owner.account, owner.organizationId, body.idempotencyKey]));
        if (this.#creating.has(creation)) return fail(409, "Création déjà en cours pour cette clé d’idempotence.");
        this.#creating.add(creation);
        try { const created = await this.#create(owner, input, { path, body }); return Response.json(created, { status: 201 }); }
        finally { this.#creating.delete(creation); }
      }
      const sessionPath = /^sessions\/([a-zA-Z0-9_-]{1,128})\/(status|stop)$/.exec(path);
      if (sessionPath) { const session = this.#session(sessionPath[1]!, owner); if (sessionPath[2] === "stop") this.#finish(session, "stopped", "Arrêt demandé par le propriétaire."); return Response.json(this.#safeSession(session)); }
      const activation=/^sessions\/([a-zA-Z0-9_-]{1,128})\/handoff-activate$/.exec(path);
      if(activation){const session=this.#session(activation[1]!,owner);if(session.status!=="running"||!session.input.handoff||!["ready","active"].includes(session.handoffPhase??"")||body.digest!==session.input.handoff.digest||!session.leaseExpiresAt||session.leaseExpiresAt<=this.#now()||!this.#state.keys.find(key=>key.id===session.keyId)?.encrypted)return fail(409,"Transfert non prêt.");session.handoffPhase="active";this.#save();return Response.json(this.#safeSession(session));}
      const eventPath = /^sessions\/([a-zA-Z0-9_-]{1,128})\/events$/.exec(path);
      if (eventPath) return this.#events(this.#session(eventPath[1]!, owner), Number(url.searchParams.get("after") ?? 0));
      if (path.startsWith("triggers/")) return await this.#trigger(path.slice(9), owner, body);
      return fail(404, "Route inconnue.");
    } catch (error) { return Response.json({ error: error instanceof ServiceError ? error.message : "Service indisponible ; opération non confirmée." }, { status: error instanceof ServiceError ? error.status : 500 }); }
  }
  #events(session: Session, after: number): Response {
    let timer: ReturnType<typeof setInterval> | undefined, closed = false;
    const encoder = new TextEncoder(), stop = () => { closed = true; clearInterval(timer); };
    const stream = new ReadableStream<Uint8Array>({ start: controller => {
      const emit = () => {
        if (closed) return;
        const events: Array<{ seq: number; type: string; text?: string }> = [{ seq: 1, type: "queued" }];
        if (session.leaseHash) events.push({ seq: 2, type: "started" });
        if (["completed", "failed", "stopped"].includes(session.status)) events.push({ seq: events.length + 1, type: session.status, text: session.reason ?? session.result ?? "Exécution terminée." });
        try {
          for (const event of events) if (event.seq > after) { controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); after = event.seq; }
          if (this.#closed || ["completed", "failed", "stopped"].includes(session.status)) { stop(); controller.close(); } else controller.enqueue(encoder.encode(": keep-alive\n\n"));
        } catch { stop(); }
      };
      emit(); if (!closed) { timer = setInterval(emit, 250); timer.unref(); }
    }, cancel: stop });
    return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
  }
  #revoke(key: Key) { key.encrypted = undefined; this.#save(); for (const session of this.#state.sessions) if (session.keyId === key.id) this.#finish(session, "stopped", "ERR-03 — Clé confiée révoquée : exécution arrêtée."); }
  #idempotent(path: string, owner: HostedPrincipal, body: Record<string, unknown>): string | undefined {
    if (!text(body.idempotencyKey, 128)) return fail(400, "Clé d’idempotence requise.");
    const previous = this.#state.idempotency[hash(JSON.stringify([path, owner.account, owner.organizationId, body.idempotencyKey]))];
    if (previous && previous.digest !== hash(JSON.stringify(body))) return fail(409, "Clé d’idempotence réutilisée avec un autre contenu."); return previous?.id;
  }
  #remember(path: string, owner: HostedPrincipal, body: Record<string, unknown>, id: string, save = true) { this.#state.idempotency[hash(JSON.stringify([path, owner.account, owner.organizationId, body.idempotencyKey]))] = { digest: hash(JSON.stringify(body)), id }; if (save) this.#save(); }
  async #trigger(operation: string, owner: HostedPrincipal, body: Record<string, unknown>): Promise<Response> {
    if (operation === "list") return Response.json({ items: this.#state.triggers.filter(trigger => sameOwner(trigger.owner, owner)).map(trigger => ({ id: trigger.id, name: trigger.name, paused: trigger.paused, nextAt: trigger.nextAt })) });
    const existing = this.#state.triggers.find(trigger => trigger.id === body.id && sameOwner(trigger.owner, owner));
    if (operation === "create" || operation === "update") {
      const input = this.#sessionInput(body); if (!text(body.cron, 128) || !text(body.timeZone, 128) || body.name !== undefined && !text(body.name, 240) || body.paused !== undefined && typeof body.paused !== "boolean") return fail(400, "Déclencheur invalide.");
      const due = nextAt(body.cron, body.timeZone, this.#now()); if (!await this.options.repositoryAccessible(input.repository, owner)) return fail(403, "Dépôt inaccessible.");
      if (operation === "update" && !existing) return fail(404, "Déclencheur inconnu.");
      const found = this.#idempotent("triggers/" + operation, owner, body); if (found) return Response.json({ id: found });
      if (this.#state.triggers.length >= 1000 && !existing) return fail(409, "Capacité de déclencheurs atteinte.");
      const trigger: Trigger = { id: existing?.id ?? randomUUID(), owner: { ...owner }, input, name: typeof body.name === "string" ? body.name : "Déclencheur distant", cron: body.cron, timeZone: body.timeZone, paused: body.paused === true, nextAt: due, history: existing?.history ?? [] };
      if (existing) this.#state.triggers.splice(this.#state.triggers.indexOf(existing), 1, trigger); else this.#state.triggers.push(trigger);
      this.#remember("triggers/" + operation, owner, body, trigger.id); return Response.json({ id: trigger.id, nextAt: trigger.nextAt }, { status: existing ? 200 : 201 });
    }
    if (!existing) return fail(404, "Déclencheur inconnu.");
    if (operation === "get") return Response.json(structuredClone(existing));
    if (operation === "delete") { this.#state.triggers.splice(this.#state.triggers.indexOf(existing), 1); this.#save(); return Response.json({ deleted: true }); }
    if (operation === "run") return Response.json(await this.#runTrigger(existing), { status: 201 });
    return fail(404, "Action de déclencheur inconnue.");
  }
  async #runTrigger(trigger: Trigger) {
    const date = this.#now(); if (trigger.history.length >= 1000) trigger.history.shift();
    try {
      const owner = this.options.resolvePrincipal ? await this.options.resolvePrincipal(trigger.owner.account, trigger.owner.organizationId) : trigger.owner;
      if (!owner) return fail(403, "Membre absent de l’organisation.");
      return await this.#create(owner, trigger.input, { created: session => { const created = this.#safeSession(session); trigger.history.push({ date, duration: 0, status: created.status, sessionId: created.id, url: created.url }); } });
    } catch (error) {
      const reason = error instanceof ServiceError ? error.message : "Exécution indisponible.";
      if (reason.includes("Dépôt inaccessible")) trigger.paused = true;
      trigger.history.push({ date, duration: Math.max(0, this.#now() - date), status: "failed", reason }); this.#save(); throw error;
    }
  }
  tick(): Promise<void> {
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#tick().finally(() => { this.#ticking = undefined; }); return this.#ticking;
  }
  async #tick() {
    if (this.#closed) return;
    for (const session of this.#state.sessions) if (session.status === "running" && session.leaseExpiresAt! <= this.#now()) this.#finish(session, "stopped", "Durée maximale atteinte.");
    for (const trigger of this.#state.triggers) if (!trigger.paused && trigger.nextAt <= this.#now()) {
      trigger.lastWall = wallTime(trigger.nextAt, trigger.timeZone);
      trigger.nextAt = nextAt(trigger.cron, trigger.timeZone, this.#now(), trigger.lastWall); this.#save();
      try { await this.#runTrigger(trigger); } catch { /* The persisted history is the user-visible failure. */ }
    }
  }
  start() { if (!this.#timer && !this.#closed) { this.#timer = setInterval(() => { void this.tick().catch(() => {}); }, this.options.scheduleIntervalMs ?? 1000); this.#timer.unref(); } }
  async close() { if (this.#closed) return; this.#closed = true; clearInterval(this.#timer); for (const session of this.#state.sessions) this.#finish(session, "stopped", "Service arrêté : état conservé."); await this.#ticking; await Promise.allSettled([...this.#handling]); this.#release(); this.#key.fill(0); }
}
