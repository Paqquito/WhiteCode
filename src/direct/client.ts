// Implements: SPEC-MOD-018 (CA-01, CA-02, authentication, server metadata and bounded reconnection).
// Supports: SPEC-MOD-007 (the same numbered objects, acknowledgements, keepalive and rotating resumption token).
import { compatibleVersion } from "../control/protocol";
import type { NetworkSettings } from "../platform/network";
import { connectNetworkWebSocket } from "../platform/socket-network";
import { connectUnixWebSocket, type WsPeer } from "../platform/websocket";
import type { DirectAddress } from "./address";

export interface DirectMetadata { readonly id: string; readonly cwd: string; readonly version: string; readonly resumeWindowMs: number }
export interface DirectClientOptions {
  readonly address: DirectAddress;
  readonly token: string;
  readonly version: string;
  readonly network: NetworkSettings;
  readonly signal: AbortSignal;
  readonly onMessage: (message: Readonly<Record<string, unknown>>) => void;
  readonly onConnection: (connected: boolean) => void;
  readonly maxFrameBytes: number;
}
export class DirectClient {
  readonly #o: DirectClientOptions;
  #connection?: { close(): void };
  #peer?: WsPeer;
  #metadata?: DirectMetadata;
  #resumeToken = "";
  #lastSeq = 0;
  #next = 0;
  #connected = false;
  #closed = false;
  #disconnectedAt = 0;
  #retry?: ReturnType<typeof setTimeout>;
  #opening?: ReturnType<typeof setTimeout>;
  #resolveReady!: (metadata: DirectMetadata) => void;
  #rejectReady!: (error: Error) => void;
  readonly ready: Promise<DirectMetadata>;
  #resolveDone!: (code: number) => void;
  readonly done: Promise<number>;
  #turn?: { resolve(outcome: { stopCause: string; message?: string }): void; cleanup(): void };
  readonly #responses = new Map<string, { settle(error?: Error, result?: Record<string, unknown>): void }>();
  readonly #abort: () => void;

  constructor(options: DirectClientOptions) {
    this.#o = options;
    this.ready = new Promise((resolve, reject) => { this.#resolveReady = resolve; this.#rejectReady = reject; });
    this.done = new Promise(resolve => { this.#resolveDone = resolve; });
    this.#abort = () => this.close(130);
    options.signal.addEventListener("abort", this.#abort, { once: true });
    if (options.signal.aborted) this.close(130); else this.#connect();
  }
  get connected(): boolean { return this.#connected; }

  #connect(): void {
    if (this.#closed) return;
    let peer: WsPeer | undefined;
    const headers: Record<string, string> = { authorization: `Bearer ${this.#o.token}`, ...(this.#metadata ? { "x-direct-session": this.#metadata.id } : {}) };
    const handlers = {
      onOpen: (opened: WsPeer) => {
        if (this.#closed) return opened.close(1000);
        peer = opened; this.#peer = opened;
        if (this.#metadata) opened.send(JSON.stringify({ type: "resume", resumeToken: this.#resumeToken, lastSeq: this.#lastSeq }));
      },
      onMessage: (text: string) => { if (peer === this.#peer && !this.#closed) this.#receive(text); },
      onClose: () => {
        if (peer && peer !== this.#peer) return;
        this.#peer = undefined; this.#connected = false; clearTimeout(this.#opening);
        if (this.#closed) return;
        this.#o.onConnection(false);
        if (this.#closed) return;
        if (!this.#metadata) return this.#fail("Accès au serveur refusé ou serveur inaccessible.");
        this.#disconnectedAt ||= Date.now();
        if (Date.now() - this.#disconnectedAt >= this.#metadata.resumeWindowMs) return this.#fail("Fenêtre de reprise de la session expirée.");
        this.#retry = setTimeout(() => this.#connect(), 200);
      },
    };
    this.#opening = setTimeout(() => { this.#connection?.close(); if (!this.#metadata) this.#fail("Initialisation du serveur hors délai."); }, 10000);
    try { this.#connection = this.#o.address.kind === "unix" ? connectUnixWebSocket(this.#o.address.path, headers, handlers) : connectNetworkWebSocket(this.#o.address.url, headers, handlers, this.#o.network); }
    catch { this.#fail("Connexion directe impossible ; vérifiez l’adresse et les certificats."); }
  }
  #receive(text: string): void {
    if (Buffer.byteLength(text) > this.#o.maxFrameBytes) return this.#fail("Message du serveur trop volumineux.");
    let value: Record<string, unknown>;
    try { value = JSON.parse(text.split(this.#o.token).join("[masqué]")) as Record<string, unknown>; }
    catch { return this.#fail("Message du serveur invalide."); }
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value["type"] !== "string") return this.#fail("Message du serveur invalide.");
    if (value["type"] === "keepalive") { this.#peer?.send(JSON.stringify({ type: "keepalive" })); return; }
    if (value["type"] === "resumed") {
      if (!this.#metadata || typeof value["resumeToken"] !== "string") return this.#fail("Reprise de session invalide.");
      this.#resumeToken = value["resumeToken"]; this.#attached(); return;
    }
    const seq = value["seq"];
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return this.#fail("Numéro de message invalide.");
    if (seq <= this.#lastSeq) { this.#peer?.send(JSON.stringify({ type: "ack", seq: this.#lastSeq })); return; }
    if (seq !== this.#lastSeq + 1) return this.#fail("La reprise ne contient pas tous les événements attendus.");
    if (!this.#metadata) {
      const metadata = value["directServer"] as Partial<DirectMetadata> | undefined;
      if (value["type"] !== "control_init" || typeof value["protocolVersion"] !== "string" || !compatibleVersion(value["protocolVersion"]) || typeof value["resumeToken"] !== "string" || !metadata || typeof metadata.id !== "string" || !/^[0-9a-f-]{36}$/.test(metadata.id) || typeof metadata.cwd !== "string" || metadata.cwd.length > 4096 || /[\u0000-\u001f\u007f]/.test(metadata.cwd) || typeof metadata.version !== "string" || metadata.version.split(".")[0] !== this.#o.version.split(".")[0] || typeof metadata.resumeWindowMs !== "number" || !Number.isFinite(metadata.resumeWindowMs) || metadata.resumeWindowMs < 0 || metadata.resumeWindowMs > 86400000) return this.#fail(`Serveur incompatible : client ${this.#o.version}, serveur ${typeof metadata?.version === "string" ? metadata.version.slice(0, 40).replace(/[^\w.+-]/g, "?") : "inconnu"}.`);
      this.#metadata = metadata as DirectMetadata; this.#resumeToken = value["resumeToken"]; this.#attached(); this.#resolveReady(this.#metadata);
    }
    this.#lastSeq = seq; this.#peer?.send(JSON.stringify({ type: "ack", seq }));
    // Transport secrets are consumed here and never reach the UI, stdout or a model.
    const { resumeToken: _token, directServer: _server, ...publicValue } = value;
    if (value["type"] === "control_response" && typeof value["id"] === "string") {
      const pending = this.#responses.get(value["id"]);
      if (pending) {
        if (value["ok"] === true && value["result"] && typeof value["result"] === "object" && !Array.isArray(value["result"])) pending.settle(undefined, value["result"] as Record<string, unknown>);
        else { const error = value["error"] as Record<string, unknown> | undefined; pending.settle(new Error(typeof error?.["message"] === "string" ? error["message"] : "Requête refusée par le serveur.")); }
      }
    }
    this.#o.onMessage(publicValue);
    if (value["type"] === "control_request" && value["request"] === "notify") {
      const params = value["params"] as Record<string, unknown> | undefined;
      if (params?.["kind"] === "turn_completed") this.#finishTurn({ stopCause: String(params["haltReason"] ?? "completed") });
    }
    if (value["type"] === "error" && value["code"] === "invalid_command") this.#finishTurn({ stopCause: "error", message: String(value["message"] ?? "Message refusé.") });
    if (value["type"] === "command_output") this.#finishTurn({ stopCause: "completed" });
    if (value["type"] === "run_completed") this.close(typeof value["exitCode"] === "number" ? value["exitCode"] : 1);
  }
  #attached(): void { clearTimeout(this.#opening); this.#opening = undefined; this.#connected = true; this.#disconnectedAt = 0; this.#o.onConnection(true); }
  send(value: Record<string, unknown>): void {
    if (!this.#connected || !this.#peer || this.#closed) throw new Error("Connexion suspendue ; attendez la reprise.");
    const text = JSON.stringify(value);
    if (Buffer.byteLength(text) > this.#o.maxFrameBytes) throw new Error("Message trop volumineux.");
    this.#peer.send(text);
  }
  request(request: string, params: Record<string, unknown> = {}): void { this.send({ type: "control_request", id: `direct-${++this.#next}`, request, params }); }
  requestResult(request: string, params: Record<string, unknown>, timeoutMs: number): Promise<Record<string, unknown>> {
    if (this.#responses.size >= 8) return Promise.reject(new Error("Trop de requêtes directes en attente."));
    return new Promise((resolve, reject) => {
      const id = `direct-${++this.#next}`;
      const timer = setTimeout(() => settle(new Error("Réponse du serveur hors délai.")), timeoutMs);
      const settle = (error?: Error, result?: Record<string, unknown>) => { if (!this.#responses.delete(id)) return; clearTimeout(timer); if (error) reject(error); else resolve(result ?? {}); };
      this.#responses.set(id, { settle });
      try { this.send({ type: "control_request", id, request, params }); } catch (error) { settle(error as Error); }
    });
  }
  initialize(): void { this.send({ type: "control_init", protocolVersion: "1.0", demands: ["approval_request", "confirm_escalation", "notify"], decisionAuthority: true, requests: [] }); }
  turn(content: string, signal: AbortSignal): Promise<{ stopCause: string; message?: string }> {
    if (this.#turn) return Promise.reject(new Error("Un tour est déjà en cours."));
    signal.throwIfAborted();
    return new Promise(resolve => {
      const cancel = () => { try { this.request("cancel_turn"); } catch { this.close(130); } };
      this.#turn = { resolve, cleanup: () => signal.removeEventListener("abort", cancel) };
      signal.addEventListener("abort", cancel, { once: true });
      try { this.send({ type: "user", content }); } catch (error) { this.#finishTurn({ stopCause: "error", message: (error as Error).message }); }
    });
  }
  #finishTurn(outcome: { stopCause: string; message?: string }): void { const turn = this.#turn; this.#turn = undefined; turn?.cleanup(); turn?.resolve(outcome); }
  #fail(message: string): void { this.#rejectReady(new Error(message)); this.#o.onMessage({ type: "error", code: "direct_connection", message }); this.close(1); }
  close(code = 0): void {
    if (this.#closed) return;
    this.#closed = true; this.#connected = false; clearTimeout(this.#retry); clearTimeout(this.#opening);
    this.#o.signal.removeEventListener("abort", this.#abort); this.#connection?.close();
    for (const pending of [...this.#responses.values()]) pending.settle(new Error("Connexion directe fermée."));
    this.#finishTurn({ stopCause: code === 130 ? "interrupted" : "error", message: "Connexion directe fermée." });
    if (!this.#metadata) this.#rejectReady(new Error("Connexion directe fermée."));
    this.#resolveDone(code);
  }
}
