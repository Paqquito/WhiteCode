// Supports: SPEC-MOD-013 (CA-02, outbound environment registration), SPEC-CMD-104 (resident lifetime).
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CompanyAccount } from "../auth/company-account";
import type { CredentialVault } from "../platform/credential-vault";
import type { WsClientHandlers, WsPeer } from "../platform/websocket";
import { ResidentCapacityError, type ResidentWorker } from "../services/worker";
import { bindPrivateStorage } from "../session/private-storage";
import { maskSecrets } from "../shared/secrets";

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const identifier = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v);
const credential = (v: unknown, kind: string): v is string => typeof v === "string" && new RegExp(`^${kind}_[A-Za-z0-9_-]{32,256}$`).test(v);
const expiry = (v: unknown, days: number): v is number => typeof v === "number" && Number.isFinite(v) && v > Date.now() && v <= Date.now() + days * 86400000;
const keyPath = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;
export function environmentDirectory(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value) || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw Error("Dossier inscrit absolu requis.");
  const path = resolve(value), stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || keyPath(realpathSync.native(path)) !== keyPath(path)) throw Error("Dossier inscrit lié ou indisponible.");
  return path;
}
interface Owner { account: string; organizationId: string }
interface Device { id: string; token: string; expiresAt: number; service: string; owner: Owner }
interface Account {
  profile(): Promise<{ account: string; organization: { id: string } } | undefined>;
  sessionBinding(): Promise<string | undefined>;
  trustedDeviceRequest: CompanyAccount["trustedDeviceRequest"];
}
export interface EnvironmentOptions {
  readonly account: Account;
  /** Hash of the login generation already confirmed by the requesting client. */
  readonly initialBinding: string;
  readonly serviceUrl: string;
  readonly webUrl: string;
  readonly vault: CredentialVault;
  readonly vaultService: string;
  readonly root: string;
  readonly name: string;
  readonly capacity: number;
  readonly workers: {
    create(id: string, cwd: string, prompt: string, binding: string): ResidentWorker;
    list(binding: string): readonly ResidentWorker[];
  };
  readonly connect: (url: string, headers: Record<string, string>, handlers: WsClientHandlers) => { close(): void };
  readonly assertPolicy: () => void;
  readonly redact: (value: string) => string;
  readonly report: (message: string) => void;
  readonly intervalMs?: number;
}

/** The authenticated service may enqueue user requests; it cannot configure tools, modes or local permission rules. */
export class RemoteEnvironment {
  readonly #controller = new AbortController();
  readonly #root: string;
  readonly #rootOwner: NonNullable<ReturnType<typeof lstatSync>>;
  #owner?: Owner;
  readonly #instance = randomUUID();
  #id?: string;
  #url?: string;
  #binding = "";
  #device?: Device;
  #channel?: { url: string; token: string; expiresAt: number };
  #connection?: { close(): void };
  #peer?: WsPeer;
  #epoch = 0;
  #after = 0;
  #failures = 0;
  #queuedBytes = 0;
  #queued = 0;
  #processing = Promise.resolve();
  #tickTask?: Promise<void>;
  #timer?: ReturnType<typeof setInterval>;
  #retry?: ReturnType<typeof setTimeout>;
  #closed = false;
  #closeTask?: Promise<void>;
  readonly #eventAcks = new Map<string, number>();
  constructor(readonly options: EnvironmentOptions) {
    if (!/^[a-f0-9]{64}$/.test(options.initialBinding) || !Number.isSafeInteger(options.capacity) || options.capacity < 1 || options.capacity > 16 || !options.name.trim() || options.name.length > 240 || /[\x00-\x1f\x7f]/.test(options.name)) throw Error("Nom ou capacité d’environnement invalide.");
    this.#root = environmentDirectory(options.root); this.#rootOwner = lstatSync(this.#root);
  }
  get state() {
    return { active: !!this.#id && !this.#closed, connected: !!this.#peer, id: this.#id, instance: this.#instance, binding: this.options.initialBinding, url: this.#closed ? undefined : this.#url, root: this.#root, name: this.options.name, capacity: this.options.capacity, pid: process.pid,
      sessions: this.options.workers.list(this.#binding).map(worker => ({ id: worker.record.id, pid: worker.pid, status: worker.record.status })) };
  }
  #redact(value: string): string { return maskSecrets(this.options.redact(value).split(this.#device?.token ?? "\u0000").join("[redacted device]").split(this.#channel?.token ?? "\u0000").join("[redacted environment]")); }
  async #current(signal: AbortSignal): Promise<Owner> {
    signal.throwIfAborted(); this.options.assertPolicy();
    const root = environmentDirectory(this.#root), stat = lstatSync(root);
    if (stat.dev !== this.#rootOwner.dev || stat.ino !== this.#rootOwner.ino) throw Error("Dossier inscrit remplacé.");
    const profile = await this.options.account.profile(), generation = await this.options.account.sessionBinding();
    signal.throwIfAborted();
    if (!profile || !generation) throw Error("Connexion à un compte de la société requise.");
    const owner = { account: profile.account, organizationId: profile.organization.id };
    if (createHash("sha256").update(generation).digest("hex") !== this.options.initialBinding || this.#owner && (owner.account !== this.#owner.account || owner.organizationId !== this.#owner.organizationId)) throw Error("Compte remplacé ; environnement arrêté.");
    return owner;
  }
  async start(parent: AbortSignal): Promise<void> {
    const signal = AbortSignal.any([parent, this.#controller.signal]);
    this.#owner = await this.#current(signal);
    const key = "remote-device-v1-" + createHash("sha256").update(this.options.serviceUrl + "\0" + JSON.stringify(this.#owner)).digest("hex");
    const stored = await this.options.vault.read(this.options.vaultService, key);
    if (stored) {
      let raw: unknown; try { raw = JSON.parse(stored); } catch { throw Error("Capacité d’appareil enregistrée invalide."); }
      if (!this.#validDevice(raw)) { await this.options.vault.remove(this.options.vaultService, key); throw Error("Capacité d’appareil expirée ou invalide supprimée ; recommencez l’inscription."); }
      this.#device = raw;
    }
    const raw = await this.options.account.trustedDeviceRequest("environments/register", { idempotencyKey: randomUUID(), name: this.options.name, directory: this.#root, capacity: this.options.capacity, ...(this.#device ? { deviceId: this.#device.id } : {}) }, signal, this.#owner, this.#device?.token);
    await this.#current(signal);
    if (!object(raw) || !identifier(raw.id) || raw.eligible !== true || raw.trustedDevice !== true || raw.account !== this.#owner!.account || raw.organizationId !== this.#owner!.organizationId || typeof raw.url !== "string" || !object(raw.channel) || typeof raw.channel.url !== "string" || !credential(raw.channel.token, "environment") || !expiry(raw.channel.expiresAt, 1) || !this.#validDevice(raw.device)) throw Error("Inscription refusée : compte non éligible, appareil non enregistré ou réponse invalide.");
    const url = new URL(raw.url), web = new URL(this.options.webUrl), channel = new URL(raw.channel.url), service = new URL(this.options.serviceUrl);
    const channelPath = service.pathname.replace(/\/?$/, "/") + `environments/${raw.id}/channel`;
    if (url.protocol !== "https:" || url.origin !== web.origin || url.username || url.password || url.search || url.hash || url.href.length > 4096 || channel.protocol !== "wss:" || channel.host !== service.host || channel.pathname !== channelPath || channel.username || channel.password || channel.search || channel.hash) throw Error("Lien de contrôle hors service autorisé.");
    this.#id = raw.id; this.#url = url.href; this.#device = raw.device; this.#channel = { url: channel.href, token: raw.channel.token, expiresAt: raw.channel.expiresAt };
    this.#binding = createHash("sha256").update(JSON.stringify([this.#owner, this.options.initialBinding, this.#instance, this.#id, this.#root])).digest("hex");
    await this.options.vault.write(this.options.vaultService, key, JSON.stringify(this.#device));
    await this.#current(signal);
    await this.#connect(signal);
    this.#timer = setInterval(() => { if (!this.#tickTask && !this.#closed) this.#tickTask = this.#tick().catch(() => { void this.close(); }).finally(() => { this.#tickTask = undefined; }); }, this.options.intervalMs ?? 1000);
    this.options.report("Environnement distant inscrit.");
  }
  #validDevice(raw: unknown): raw is Device {
    return object(raw) && identifier(raw.id) && credential(raw.token, "device") && expiry(raw.expiresAt, 31) && raw.service === this.options.serviceUrl && object(raw.owner) && raw.owner.account === this.#owner?.account && raw.owner.organizationId === this.#owner?.organizationId;
  }
  #connect(parent: AbortSignal): Promise<void> {
    const channel = this.#channel!, epoch = ++this.#epoch;
    return new Promise<void>((resolveOpen, reject) => {
      let opened = false;
      const timer = setTimeout(() => { reject(Error("Canal distant indisponible.")); this.#connection?.close(); }, 5000);
      const abort = () => { clearTimeout(timer); reject(Error("Inscription interrompue.")); this.#connection?.close(); };
      parent.addEventListener("abort", abort, { once: true });
      this.#connection = this.options.connect(channel.url, { Authorization: "Environment " + channel.token, "X-Trusted-Device": this.#device!.token }, {
        onOpen: peer => {
          if (this.#closed || parent.aborted || epoch !== this.#epoch) { peer.close(); return; }
          opened = true; clearTimeout(timer); parent.removeEventListener("abort", abort); this.#peer = peer; this.#failures = 0;
          this.#send({ type: "hello", environment: this.#id, after: this.#after }); this.#publish(); resolveOpen();
        },
        onMessage: bindPrivateStorage(text => {
          if (this.#closed || epoch !== this.#epoch) return;
          const bytes = Buffer.byteLength(text);
          if (bytes > 65536 || ++this.#queued > 64 || (this.#queuedBytes += bytes) > 1048576) { void this.close(); return; }
          this.#processing = this.#processing.then(() => this.#receive(text)).catch(() => { void this.close(); }).finally(() => { this.#queued--; this.#queuedBytes -= bytes; });
        }),
        onClose: () => {
          if (epoch !== this.#epoch) return;
          clearTimeout(timer); parent.removeEventListener("abort", abort); this.#peer = undefined;
          if (!opened) reject(Error("Authentification du canal distant refusée."));
          if (!this.#closed && opened) {
            if (++this.#failures > 5) { void this.close(); return; }
            this.#retry = setTimeout(() => { if (!this.#closed) void this.#connect(this.#controller.signal).catch(() => this.close()); }, Math.min(30000, 1000 * 2 ** this.#failures));
          }
        },
      });
      if (parent.aborted) abort();
    });
  }
  #send(value: unknown): boolean {
    if (!this.#peer || this.#closed) return false;
    const text = this.#redact(JSON.stringify(value));
    if (Buffer.byteLength(text) > 262144) return false;
    this.#peer.send(text); return true;
  }
  #publish(): void {
    for (const worker of this.options.workers.list(this.#binding)) {
      const state = { type: "session", id: worker.record.id, status: worker.record.status, pid: worker.pid, latest: worker.latestSequence };
      const events = worker.events(this.#eventAcks.get(worker.record.id) ?? 0);
      if (!this.#send({ ...state, events })) this.#send({ ...state, events: [], eventsTruncated: true });
      for (const pending of worker.approvals) this.#send({ type: "approval", id: worker.record.id, approval: pending });
    }
  }
  async #tick(): Promise<void> {
    await this.#current(this.#controller.signal);
    if (!this.#channel || this.#channel.expiresAt <= Date.now() || !this.#device || this.#device.expiresAt <= Date.now()) throw Error("Capacité distante expirée.");
    await this.options.account.trustedDeviceRequest(`environments/${this.#id}/heartbeat`, { after: this.#after }, this.#controller.signal, this.#owner!, this.#device.token);
    this.#publish();
  }
  async #receive(text: string): Promise<void> {
    const raw: unknown = JSON.parse(text), signal = this.#controller.signal;
    await this.#current(signal);
    if (!object(raw) || !Number.isSafeInteger(raw.seq) || Number(raw.seq) < 1 || raw.environment !== this.#id || raw.account !== this.#owner!.account || raw.organizationId !== this.#owner!.organizationId) throw Error("Autorité du travail distant invalide.");
    const seq = Number(raw.seq);
    if (seq <= this.#after) { this.#send({ type: "ack", seq, duplicate: true }); return; }
    if (seq !== this.#after + 1) throw Error("Curseur de travail distant discontinu.");
    if (Object.keys(raw).some(key => !["seq", "type", "environment", "account", "organizationId", "id", "prompt", "directory", "requestId", "answer", "after"].includes(key)) || !uuid(raw.id)) throw Error("Travail distant invalide.");
    const workers = this.options.workers.list(this.#binding), worker = workers.find(item => item.record.id === raw.id);
    let result: Record<string, unknown> = { status: "rejected" };
    if (raw.type === "create") {
      if (worker) result = { status: "existing", id: worker.record.id, pid: worker.pid };
      else if (workers.filter(item => !["stopped", "completed", "error"].includes(item.record.status)).length >= this.options.capacity) result = { status: "capacity" };
      else if (typeof raw.prompt === "string" && raw.prompt.trim() && raw.prompt.length <= 32000 && !/[\x00\x1b]/.test(raw.prompt) && (raw.directory === undefined || typeof raw.directory === "string" && !isAbsolute(raw.directory))) {
        const directory = environmentDirectory(resolve(this.#root, typeof raw.directory === "string" ? raw.directory : ".")), rel = relative(this.#root, directory);
        if (isAbsolute(rel) || rel === ".." || rel.startsWith(".." + sep)) throw Error("Dossier hors environnement inscrit.");
        try {
          const created = this.options.workers.create(raw.id, directory, raw.prompt, this.#binding);
          result = { status: "created", id: created.record.id, pid: created.pid };
        } catch (error) { if (!(error instanceof ResidentCapacityError)) throw error; result = { status: "capacity" }; }
      }
    } else if (worker && raw.type === "message" && typeof raw.prompt === "string" && raw.prompt.trim() && raw.prompt.length <= 32000) {
      result = { status: "queued", id: worker.enqueue(raw.prompt) };
    } else if (worker && raw.type === "answer" && typeof raw.requestId === "string" && ["allow", "deny"].includes(String(raw.answer))) {
      result = { status: worker.answer(raw.requestId, raw.answer === "allow") ? "resolved" : "stale" };
    } else if (worker && raw.type === "stop") {
      await worker.close(); result = { status: "stopped" };
    } else if (worker && raw.type === "ack_events" && Number.isSafeInteger(raw.after) && Number(raw.after) >= (this.#eventAcks.get(raw.id) ?? 0) && Number(raw.after) <= worker.latestSequence) {
      this.#eventAcks.set(raw.id, Number(raw.after)); result = { status: "acknowledged" };
    }
    this.#after = seq; this.#send({ type: "ack", seq, ...result }); this.#publish();
  }
  close(): Promise<void> { return this.#closeTask ??= this.#close(); }
  async #close(): Promise<void> {
    this.#closed = true; this.#controller.abort(); clearInterval(this.#timer); clearTimeout(this.#retry); this.#connection?.close(); this.#peer = undefined;
    await this.#processing;
    await this.#tickTask;
    await Promise.allSettled(this.options.workers.list(this.#binding).map(worker => worker.close()));
    if (this.#id && this.#owner) try { await this.options.account.trustedDeviceRequest(`environments/${this.#id}/unregister`, {}, AbortSignal.timeout(2000), this.#owner, this.#device?.token); } catch {}
    this.options.report("Environnement distant arrêté.");
  }
}
