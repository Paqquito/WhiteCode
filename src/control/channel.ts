// Implements: SPEC-MOD-006 (§ 5.4 steps 2 and 3, FA-02, FA-04, EF-01 to EF-04, EF-06, EF-08, ERR-01 to ERR-03, RG-02, RG-03, RG-06, edge cases: double answer, request after `shutdown`, many simultaneous requests)
// The control channel, without its transport: correlation of the requests and of the responses, delays, negotiated
// capabilities. The requests of the host run concurrently (EF-02); a demand of the engine never waits beyond its delay (EF-03).

import { CONTROL_PROTOCOL_VERSION, CONTROL_TYPES, ControlError, EMITTED_DEMANDS, HOST_REQUESTS, compatibleVersion, parseControlMessage, type EngineDemand, type HostRequest } from "./protocol";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };

export type RequestHandler = (params: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<unknown>;

export type DemandOutcome =
  | { readonly kind: "answer"; readonly ok: true; readonly result: unknown; readonly elapsedMs: number }
  | { readonly kind: "answer"; readonly ok: false; readonly error: { readonly code: string; readonly message: string }; readonly elapsedMs: number }
  /** The host did not declare this demand at the initialization (FA-01, EF-04). */
  | { readonly kind: "unsupported" }
  | { readonly kind: "timeout" }
  | { readonly kind: "aborted" }
  | { readonly kind: "closed" };

export interface ChannelOptions {
  /** Writes one object; the transport frames it. */
  readonly send: (message: Record<string, unknown>) => void;
  readonly handlers: Partial<Record<HostRequest, RequestHandler>>;
  /** `engine.control.responseTimeoutMs`, used when the host gives no delay at the initialization. */
  readonly defaultTimeoutMs: number;
  /** `engine.control.maxInFlight`. */
  readonly maxInFlight: number;
  readonly warn: (message: string) => void;
  /** EF-08: every request of the host, every demand and its issue. */
  readonly trace: (event: string, data: Record<string, unknown>) => void;
  /** ERR-01: the initialization is refused, the run stops. */
  readonly fatal: (message: string) => void;
}

export interface HostCapabilities {
  readonly sdkServers?: readonly import("../connectors/sdk").SdkServer[];
  readonly toolProgress?: boolean;
  readonly demands: ReadonlySet<string>;
  readonly timeoutMs: number;
  /** The host declares itself as the decision authority; the policy decides whether it is designated (RG-05). */
  readonly declaresAuthority: boolean;
}

interface Pending {
  readonly demand: EngineDemand;
  readonly started: number;
  readonly settle: (outcome: DemandOutcome) => void;
}

export class ControlChannel {
  readonly #o: ChannelOptions;
  #host: HostCapabilities | undefined;
  #initialized!: () => void;
  /** Resolved when the host has sent its capabilities (§ 5.4 step 3). */
  readonly initialized: Promise<void> = new Promise((r) => (this.#initialized = r));
  /** RG-03: the identifiers of the host, unique for the whole connection. */
  readonly #hostIds = new Set<string>();
  readonly #pending = new Map<string, Pending>();
  /** Demands already settled: a second answer, or a late one, is without effect (RG-06). */
  readonly #settled = new Set<string>();
  readonly #abort = new AbortController();
  #inFlight = 0;
  #next = 1;
  #closing = false;

  constructor(options: ChannelOptions) {
    if (!buildFlag("engine_control_channel")) throw new ControlError("unavailable_build", "Control channel unavailable in this build.");
    this.#o = options;
  }

  get host(): HostCapabilities | undefined {
    return this.#host;
  }

  /** § 5.4 step 2: version, capabilities and session, before any other message of the channel. */
  sendInit(sessionId: string): void {
    this.#o.send({ type: "control_init", protocolVersion: CONTROL_PROTOCOL_VERSION, requests: [...HOST_REQUESTS], demands: [...EMITTED_DEMANDS], sessionId });
  }

  /** True for an object of the channel; the other objects (user messages) belong to the input stream. */
  static isControl(value: Record<string, unknown>): boolean {
    return CONTROL_TYPES.has(String(value["type"]));
  }

  receive(value: Record<string, unknown>): void {
    const message = parseControlMessage(value);
    if ("error" in message) {
      // ERR-03: correlated when the identifier could be read; otherwise a warning on the stream.
      if (message.id !== undefined && value["type"] === "control_request") this.#respond(message.id, new ControlError("invalid_request", `Requête de contrôle invalide : ${message.error}.`));
      else this.#o.warn(`Message de contrôle invalide ignoré : ${message.error}.`);
      return;
    }
    switch (message.type) {
      case "control_init": {
        if (this.#host) return this.#o.warn("Initialisation répétée du canal de contrôle ignorée.");
        if (!compatibleVersion(message.protocolVersion)) return this.#o.fatal(`Version de protocole non prise en charge : ${message.protocolVersion}.`); // ERR-01
        const unknown = message.demands.filter((d) => !(EMITTED_DEMANDS as readonly string[]).includes(d) && !["request_user_choice", "open_resource"].includes(d));
        if (unknown.length > 0) this.#o.warn(`Capacités inconnues de l'hôte ignorées : ${unknown.join(", ")}.`);
        this.#host = {
          demands: new Set(message.demands),
          timeoutMs: message.responseTimeoutMs ?? this.#o.defaultTimeoutMs,
          declaresAuthority: message.decisionAuthority === true,
          toolProgress: message.toolProgress === true,
          sdkServers: message.sdkServers,
        };
        this.#o.trace("initialized", { demands: message.demands, timeoutMs: this.#host.timeoutMs, declaresAuthority: this.#host.declaresAuthority });
        this.#initialized();
        return;
      }
      case "control_request":
        return this.#request(message.id, message.request, message.params);
      case "control_response": {
        const pending = this.#pending.get(message.id);
        if (!pending) {
          // Edge case: a second answer to the same demand is ignored; ERR-02: a response without request is reported.
          if (this.#settled.has(message.id)) this.#o.trace("duplicate_response", { id: message.id });
          else this.#o.warn("Réponse orpheline ignorée.");
          return;
        }
        const elapsedMs = Date.now() - pending.started;
        pending.settle(message.ok ? { kind: "answer", ok: true, result: message.result, elapsedMs } : { kind: "answer", ok: false, error: message.error ?? { code: "error", message: "refus sans motif" }, elapsedMs });
        return;
      }
    }
  }

  #request(id: string, name: string, params: Readonly<Record<string, unknown>>): void {
    // RG-03: an identifier already used is refused, correlated with the new request.
    if (this.#hostIds.has(id)) return this.#respond(id, new ControlError("duplicate_id", "Requête de contrôle invalide : identifiant déjà utilisé."));
    this.#hostIds.add(id);
    this.#o.trace("request", { id, request: name }); // EF-08
    if (this.#closing) return this.#respond(id, new ControlError("shutting_down", "Requête refusée : l'exécution se termine.")); // edge case: after `shutdown`
    if (!this.#host) return this.#respond(id, new ControlError("not_initialized", "Requête de contrôle invalide : initialisation de l'hôte attendue."));
    const handler = (HOST_REQUESTS as readonly string[]).includes(name) ? this.#o.handlers[name as HostRequest] : undefined;
    if (!handler) return this.#respond(id, new ControlError("unknown_request", `Requête de contrôle inconnue : ${name}.`)); // FA-04
    if (this.#inFlight >= this.#o.maxInFlight) return this.#respond(id, new ControlError("too_many_requests", `Trop de requêtes en cours (${this.#o.maxInFlight} au plus).`));
    this.#inFlight++;
    handler(params, this.#abort.signal)
      .then(
        (result) => this.#respond(id, undefined, result),
        (error: unknown) => this.#respond(id, error instanceof ControlError ? error : new ControlError("internal_error", `La requête a échoué : ${(error as Error)?.message ?? String(error)}`)),
      )
      .finally(() => this.#inFlight--);
  }

  #respond(id: string, error: ControlError | undefined, result?: unknown): void {
    if (error) this.#o.trace("refused", { id, code: error.code });
    this.#o.send(error ? { type: "control_response", id, ok: false, error: { code: error.code, message: error.message } } : { type: "control_response", id, ok: true, result: result ?? {} });
  }

  /**
   * A demand of the engine, correlated with its response (EF-01). It never waits beyond the delay (EF-03, FA-02); an
   * interruption settles it at once and a later answer is without effect (RG-06).
   */
  demand(name: EngineDemand, params: Record<string, unknown>, signal?: AbortSignal, timeoutMs = this.#host?.timeoutMs): Promise<DemandOutcome> {
    if (this.#closing && name !== "notify") return Promise.resolve({ kind: "closed" });
    if (!this.#host?.demands.has(name)) return Promise.resolve({ kind: "unsupported" }); // EF-04
    if (signal?.aborted) return Promise.resolve({ kind: "aborted" });
    const id = `e-${this.#next++}`;
    const started = Date.now();
    return new Promise<DemandOutcome>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle({ kind: "aborted" });
      const settle = (outcome: DemandOutcome) => {
        if (!this.#pending.has(id)) return;
        this.#pending.delete(id);
        this.#settled.add(id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.#o.trace("demand_settled", { id, demand: name, outcome: outcome.kind === "answer" ? (outcome.ok ? "answered" : "error") : outcome.kind, elapsedMs: Date.now() - started });
        resolve(outcome);
      };
      this.#pending.set(id, { demand: name, started, settle });
      timer = setTimeout(() => settle({ kind: "timeout" }), timeoutMs);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#o.trace("demand", { id, demand: name });
      this.#o.send({ type: "control_request", id, request: name, params });
    });
  }

  /** `notify`: an optional acknowledgement, never awaited. */
  notify(params: Record<string, unknown>): void {
    if (!this.#host?.demands.has("notify")) return;
    const id = `e-${this.#next++}`;
    this.#settled.add(id);
    this.#o.send({ type: "control_request", id, request: "notify", params });
  }

  /** `shutdown` received: the requests that follow are refused (edge case). */
  beginShutdown(): void {
    this.#closing = true;
  }

  /** The channel ends: every pending demand is settled as refused (RG-02), the running requests are aborted. */
  close(): void {
    this.#closing = true;
    this.#abort.abort();
    for (const p of [...this.#pending.values()]) p.settle({ kind: "closed" });
  }
}
