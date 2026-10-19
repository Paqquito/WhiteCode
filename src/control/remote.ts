// Implements: SPEC-MOD-007 (§ 5.2 steps 2 to 7, FA-01 to FA-06, EF-01 to EF-05, EF-07, EF-08, ERR-01, ERR-03 to ERR-05, RG-01 to RG-03, ENF-03, § 10, § 12)
// The control channel over a persistent connection: the same objects as on the standard streams (EF-06), one per
// message. The engine numbers its messages, keeps those the host has not confirmed, and replays them to the
// connection that presents the resumption token. The state of the run stays in the engine (RG-04).

import { randomUUID, timingSafeEqual } from "node:crypto";
import type { WsPeer } from "../platform/websocket";

export interface LinkOptions {
  readonly resumeWindowMs: number;
  readonly keepAliveMs: number;
  readonly maxFrameBytes: number;
  /** ENF-03: messages kept while the host has not confirmed them. */
  readonly maxBuffered: number;
  readonly maxBufferedBytes?: number;
  readonly maxInboundBytes?: number;
  readonly maxPending?: number;
  /** § 10: connection and disconnection, on the machine of the engine. */
  readonly notice: (text: string) => void;
  readonly trace: (event: string, data: Record<string, unknown>) => void;
  readonly now?: () => Date;
}

type State = "waiting" | "attached" | "suspended" | "ended";

/** Lines received from the host, for the control driver. */
class LineQueue implements AsyncIterable<string> {
  readonly #lines: string[] = [];
  #bytes = 0;
  constructor(readonly maxBytes = Infinity) {}
  #wake: (() => void) | undefined;
  #ended = false;
  push(line: string): boolean {
    const bytes = Buffer.byteLength(line);
    if (this.#ended || this.#bytes + bytes > this.maxBytes) return false;
    this.#bytes += bytes;
    this.#lines.push(line);
    this.#wake?.();
    return true;
  }
  end(clear = false): void {
    if (clear) { this.#lines.length = 0; this.#bytes = 0; }
    this.#ended = true;
    this.#wake?.();
  }
  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) {
        this.#bytes -= Buffer.byteLength(line);
        yield line;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = undefined;
    }
  }
}

const MESSAGE_TOO_LARGE = "Message trop volumineux."; // ERR-04

export class FramedLink {
  readonly #o: LinkOptions;
  #state: State = "waiting";
  #peer: WsPeer | undefined;
  /** Connections that must present the resumption token in their first message (FA-02, FA-06). */
  readonly #pending = new Set<WsPeer>();
  readonly #pendingTimers = new Map<WsPeer, ReturnType<typeof setTimeout>>();
  #seq = 0;
  /** Messages not confirmed by the host, in order (EF-03, EF-05). */
  readonly #buffer: Array<{ readonly seq: number; readonly text: string; readonly bytes: number }> = [];
  #bufferBytes = 0;
  readonly #waiters = new Set<{ resolve(): void; reject(reason: Error): void }>();
  /** First number that can still be replayed: older messages left the bounded buffer (ENF-03). */
  #replayableFrom = 1;
  #token = randomUUID();
  #lastReceived = Date.now();
  #connectedAt: Date | undefined;
  readonly #inbound: LineQueue;
  #keepAlive: ReturnType<typeof setInterval> | undefined;
  #resumeTimer: ReturnType<typeof setTimeout> | undefined;
  /** FA-03: the resumption window expired; the run stops and the session stays reopenable. */
  expired = false;
  #closing: { readonly peer: WsPeer; readonly done: () => void } | undefined;

  constructor(options: LinkOptions) {
    this.#o = options;
    this.#inbound = new LineQueue(options.maxInboundBytes);
  }

  get attached(): boolean {
    return this.#state === "attached";
  }

  /** Event-driven admission for work that must wait for the authenticated host to reconnect. */
  async waitAttached(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    while (!this.attached) {
      if (this.ended) throw new Error("Remote link closed.");
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => { this.#waiters.delete(waiter); signal.removeEventListener("abort", abort); };
        const abort = () => { cleanup(); reject(signal.reason ?? new Error("Remote wait aborted.")); };
        const waiter = { resolve: () => { cleanup(); resolve(); }, reject: (reason: Error) => { cleanup(); reject(reason); } };
        this.#waiters.add(waiter); signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      signal.throwIfAborted();
    }
  }

  /** The messages of the host, without the frames of the transport. */
  lines(): AsyncIterable<string> {
    return this.#inbound;
  }

  /** A line of the stream (an event or a message of the channel), numbered (EF-03, RG-03). */
  sendLine(line: string): void {
    if (this.#state === "ended") return;
    const body = line.trim();
    if (!body.startsWith("{")) return;
    const seq = ++this.#seq;
    let text = `{"seq":${seq},${body.slice(1)}`;
    // § 5.2 step 3: the initialization carries the resumption token.
    if (body.includes('"type":"control_init"')) {
      const init = JSON.parse(body) as Record<string, unknown>;
      text = JSON.stringify({ seq, ...init, resumeToken: this.#token });
    }
    const bytes = Buffer.byteLength(text); this.#buffer.push({ seq, text, bytes }); this.#bufferBytes += bytes;
    while (this.#buffer.length > this.#o.maxBuffered || this.#o.maxBufferedBytes !== undefined && this.#bufferBytes > this.#o.maxBufferedBytes) {
      const removed = this.#buffer.shift(); if (!removed) break;
      this.#bufferBytes -= removed.bytes; this.#replayableFrom = removed.seq + 1;
    }
    if (this.#state === "attached") this.#peer!.send(text);
  }

  /** A connection authenticated by the transport (EF-02). */
  open(peer: WsPeer): void {
    if (this.#state === "ended") return peer.close(1001);
    if (this.#state === "waiting") return this.#attach(peer, 0, false);
    if (this.#o.maxPending !== undefined && this.#pending.size >= this.#o.maxPending) return peer.close(4429);
    // RG-02: the first message must resume the session; until then the connection pilots nothing.
    this.#pending.add(peer);
    const timer = setTimeout(() => {
      this.#pendingTimers.delete(peer);
      if (this.#pending.delete(peer)) peer.close(4408);
    }, Math.max(1_000, this.#o.keepAliveMs));
    this.#pendingTimers.set(peer, timer);
  }

  /**
   * Client mode: a connection opened by the engine to the endpoint of the host. A reconnection presents the previous
   * token to the host, which checks it, and replays what the host has not confirmed (FA-02).
   */
  openOutgoing(peer: WsPeer): void {
    if (this.#state === "ended") return peer.close(1000);
    if (this.#state === "waiting") return this.#attach(peer, 0, false);
    this.#attach(peer, this.#replayableFrom - 1, true, true);
  }

  get ended(): boolean {
    return this.#state === "ended";
  }

  receive(peer: WsPeer, text: string): void {
    if (this.#pending.has(peer)) return this.#first(peer, text);
    if (peer !== this.#peer || this.#state !== "attached") return;
    this.#lastReceived = Date.now();
    // FA-05, ERR-04: beyond the maximal size, rejected with an error correlated when possible.
    if (Buffer.byteLength(text, "utf8") > this.#o.maxFrameBytes) {
      const id = /"id"\s*:\s*"([^"\\]{1,200})"/.exec(text.slice(0, 1_000))?.[1];
      this.#o.trace("frame_rejected", { bytes: Buffer.byteLength(text, "utf8") });
      this.sendLine(JSON.stringify(id ? { type: "control_response", id, ok: false, error: { code: "message_too_large", message: MESSAGE_TOO_LARGE } } : { type: "error", code: "message_too_large", message: MESSAGE_TOO_LARGE }));
      return;
    }
    let value: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) value = parsed as Record<string, unknown>;
    } catch {
      // given as is to the driver, which reports it (ERR-01 of SPEC-MOD-003)
    }
    if (value?.["type"] === "ack") return this.#acknowledge(value["seq"]);
    if (value?.["type"] === "keepalive") return;
    if (value?.["type"] === "resume") return; // already attached: nothing to resume
    if (!this.#inbound.push(text)) { peer.close(4429); this.#inbound.end(true); this.close(); }
  }

  closed(peer: WsPeer): void {
    if (this.#closing?.peer === peer) this.#closing.done();
    clearTimeout(this.#pendingTimers.get(peer)); this.#pendingTimers.delete(peer);
    if (this.#pending.delete(peer) || peer !== this.#peer) return;
    this.#peer = undefined;
    if (this.#state !== "attached") return;
    this.#suspend();
  }

  /** EF-04: the host confirms the last number received; the confirmed messages leave the buffer (ENF-03). */
  #acknowledge(seq: unknown): void {
    if (typeof seq !== "number" || !Number.isInteger(seq)) return;
    while (this.#buffer.length > 0 && this.#buffer[0]!.seq <= seq) this.#bufferBytes -= this.#buffer.shift()!.bytes;
    this.#replayableFrom = Math.max(this.#replayableFrom, Math.min(seq + 1, this.#seq + 1));
  }

  #first(peer: WsPeer, text: string): void {
    clearTimeout(this.#pendingTimers.get(peer)); this.#pendingTimers.delete(peer);
    this.#pending.delete(peer);
    let value: Record<string, unknown> | undefined;
    try {
      value = JSON.parse(text) as Record<string, unknown>;
    } catch {
      value = undefined;
    }
    const token = typeof value?.["resumeToken"] === "string" ? (value["resumeToken"] as string) : "";
    // FA-02, RG-02: only the bearer of the token resumes; any other connection is refused (FA-06: no mirror mode).
    if (value?.["type"] !== "resume" || !sameSecret(token, this.#token)) {
      this.#o.trace("connection_refused", { reason: value?.["type"] === "resume" ? "resume_token" : "second_host" });
      return peer.close(4409);
    }
    const lastSeq = typeof value["lastSeq"] === "number" && Number.isInteger(value["lastSeq"]) ? (value["lastSeq"] as number) : this.#replayableFrom - 1;
    if (lastSeq + 1 < this.#replayableFrom) {
      // The missed messages are no longer kept: a resumption would lose events (EF-05).
      this.#o.notice("Reprise impossible : des événements ne sont plus disponibles.");
      peer.close(4410);
      return this.#expire();
    }
    this.#attach(peer, lastSeq, true);
  }

  #attach(peer: WsPeer, lastSeq: number, resumed: boolean, outgoing = false): void {
    const previous = this.#peer;
    this.#peer = peer;
    this.#state = "attached";
    for (const waiter of [...this.#waiters]) waiter.resolve();
    this.#lastReceived = Date.now();
    clearTimeout(this.#resumeTimer);
    this.#resumeTimer = undefined;
    if (previous && previous !== peer) previous.close(4000);
    this.#connectedAt = (this.#o.now ?? (() => new Date()))();
    this.#o.notice(`Hôte distant ${resumed ? "reconnecté" : "connecté"} : ${peer.remoteAddress || "adresse inconnue"} (${this.#connectedAt.toISOString()}).`);
    this.#o.trace(resumed ? "resumed" : "connected", { origin: peer.remoteAddress, lastSeq });
    if (resumed) {
      // § 12: a token is used once; a new one comes with each resumption.
      const previousToken = this.#token;
      this.#token = randomUUID();
      peer.send(JSON.stringify({ type: "resumed", ...(outgoing ? { previousResumeToken: previousToken } : {}), resumeToken: this.#token, lastSeq }));
    }
    // FA-02: what the host did not receive, in order.
    for (const f of this.#buffer) if (f.seq > lastSeq) peer.send(f.text);
    this.#startKeepAlive();
  }

  /** FA-01: the run goes on and its messages are kept, while a resumption is awaited during the window. */
  #suspend(): void {
    this.#state = "suspended";
    this.#stopKeepAlive();
    const seconds = Math.round(this.#o.resumeWindowMs / 1000);
    this.#o.notice(`Hôte distant déconnecté${seconds > 0 ? ` : reprise possible pendant ${seconds} s` : ""}.`);
    this.#o.trace("disconnected", { since: this.#connectedAt?.toISOString() });
    if (this.#o.resumeWindowMs <= 0) return this.#expire();
    this.#resumeTimer = setTimeout(() => this.#expire(), this.#o.resumeWindowMs);
  }

  #expire(): void {
    if (this.#state === "ended") return;
    this.expired = true;
    this.#state = "ended";
    for (const waiter of [...this.#waiters]) waiter.reject(new Error("Remote link closed."));
    this.#stopKeepAlive();
    this.#o.trace("resume_window_expired", {});
    this.#inbound.end(); // FA-03: the driver stops the run
  }

  /** § 5.2 step 6, EF-07: frames in both directions; a connection silent beyond the delay is closed. */
  #startKeepAlive(): void {
    this.#stopKeepAlive();
    this.#keepAlive = setInterval(() => {
      if (this.#state !== "attached" || !this.#peer) return;
      if (Date.now() - this.#lastReceived > 2 * this.#o.keepAliveMs) {
        const peer = this.#peer;
        this.#o.trace("keepalive_timeout", {});
        peer.close(4001);
        this.closed(peer);
        return;
      }
      this.#peer.send(JSON.stringify({ type: "keepalive" }));
    }, this.#o.keepAliveMs);
  }

  #stopKeepAlive(): void {
    clearInterval(this.#keepAlive);
    this.#keepAlive = undefined;
  }

  /**
   * § 5.2 step 7: the end of the run. The last messages are sent, then the connection is closed normally and its end
   * awaited (bounded), so that stopping the transport afterwards loses nothing.
   */
  async drain(timeoutMs = 2_000): Promise<void> {
    const peer = this.#peer;
    if (!peer) return this.close();
    // The last messages leave before the closing: until the host confirmed them, within a short grace period (a closing
    // sent right after them may overtake them on the way and lose them).
    const until = Date.now() + Math.min(500, timeoutMs);
    while (this.#buffer.length > 0 && Date.now() < until && this.#peer === peer) await new Promise((r) => setTimeout(r, 20));
    const ended = new Promise<void>((resolve) => {
      this.#closing = { peer, done: resolve };
      setTimeout(resolve, timeoutMs);
    });
    this.close();
    await ended;
  }

  close(): void {
    this.#state = "ended";
    for (const waiter of [...this.#waiters]) waiter.reject(new Error("Remote link closed."));
    this.#buffer.length = 0; this.#bufferBytes = 0;
    this.#stopKeepAlive();
    clearTimeout(this.#resumeTimer);
    for (const p of this.#pending) p.close(1001);
    for (const timer of this.#pendingTimers.values()) clearTimeout(timer);
    this.#pendingTimers.clear();
    this.#pending.clear();
    this.#peer?.close(1000);
    this.#peer = undefined;
    this.#inbound.end();
  }
}

/** Constant-time comparison of two secrets (RG-01: never shown, never compared in a way that leaks them). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** EF-02: the token is carried by the header of the opening request. */
export function bearerMatches(headers: Headers, token: string): boolean {
  const value = headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(value);
  return m !== null && sameSecret(m[1]!.trim(), token);
}

/** A loopback address: never exposed to the network (EF-01, § 12). */
export function isLoopback(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || /^::ffff:127\./.test(h);
}

/** `<hôte>:<port>`, `[<ipv6>]:<port>`, `<hôte>` or `<port>` (loopback by default, port 0: chosen by the system). */
export function parseListenAddress(value: string): { readonly hostname: string; readonly port: number } | string {
  const v = value.trim();
  if (/^\d+$/.test(v)) return portOf(v, "127.0.0.1");
  const bracket = /^\[([^\]]+)\](?::(\d+))?$/.exec(v);
  if (bracket) return portOf(bracket[2] ?? "0", bracket[1]!);
  const at = v.lastIndexOf(":");
  if (at === -1) return v === "" ? "adresse vide" : { hostname: v, port: 0 };
  if (v.indexOf(":") !== at) return "adresse IPv6 attendue entre crochets";
  return portOf(v.slice(at + 1), v.slice(0, at) || "127.0.0.1");
}

function portOf(text: string, hostname: string): { readonly hostname: string; readonly port: number } | string {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) return `port invalide : ${text}`;
  return { hostname, port };
}

/**
 * EF-08: the connections accepted are those of the loopback interface and of the listed origins (addresses, or values
 * of the `Origin` header). A request of a web page carries an `Origin` header: it is accepted only when listed, so that
 * a page cannot drive the engine through the loopback interface.
 */
export function originAllowed(remoteAddress: string, origin: string | null, allowed: readonly string[]): boolean {
  if (origin !== null) return allowed.includes(origin);
  return isLoopback(remoteAddress) || allowed.includes(remoteAddress.replace(/^::ffff:/, ""));
}
