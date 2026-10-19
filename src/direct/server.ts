// Implements: SPEC-MOD-019 (CA-01, CA-02, EF-01 to EF-03, local session ownership and bounded shutdown).
// Supports: SPEC-MOD-007 (existing framed protocol and replay), SPEC-MOD-018 (server-owned folder metadata).
import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { FramedLink, bearerMatches, originAllowed } from "../control/remote";
import type { StandardStreams } from "../platform/io";
import { listenWebSocket, type WsPeer } from "../platform/websocket";
import type { DirectListen } from "./address";

export interface DirectSession {
  readonly root: string;
  readonly signal: AbortSignal;
  readonly streams: StandardStreams;
  readonly waitConnected: (signal: AbortSignal) => Promise<void>;
  readonly privateFiles: readonly string[];
}
export interface DirectServerOptions {
  readonly root: string;
  readonly privateFiles?: readonly string[];
  readonly listen: DirectListen;
  readonly token: string;
  readonly version: string;
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly maxFrameBytes: number;
  readonly keepAliveMs: number;
  readonly resumeWindowMs: number;
  readonly allowedOrigins: readonly string[];
  readonly refusal: () => string | undefined;
  readonly runSession: (session: DirectSession) => Promise<number>;
  readonly notice: (message: string) => void;
}
interface OwnedSession { readonly link: FramedLink; readonly abort: AbortController; readonly done: Promise<void> }

/** One authenticated opening owns one driver. Reconnection additionally proves the rotating FramedLink token. */
export function startDirectServer(options: DirectServerOptions): { readonly url: string; readonly sessionCount: number; stop(): Promise<void> } {
  const root = realpathSync.native(options.root);
  if (!statSync(root).isDirectory()) throw new Error("Racine servie introuvable.");
  const sessions = new Map<string, OwnedSession>(), peers = new Map<WsPeer, OwnedSession>();
  let stopping = false;
  const server = listenWebSocket({
    hostname: options.listen.kind === "tcp" ? options.listen.hostname : "127.0.0.1", port: options.listen.kind === "tcp" ? options.listen.port : 0,
    ...(options.listen.kind === "unix" ? { unix: options.listen.path } : {}), ...(options.tls ? { tls: options.tls } : {}), maxPayloadLength: options.maxFrameBytes,
    authorize: opening => {
      if (stopping || options.refusal() || !bearerMatches(opening.headers, options.token)) return false;
      if (options.listen.kind !== "unix" && !originAllowed(opening.remoteAddress, opening.headers.get("origin"), options.allowedOrigins)) return false;
      const id = opening.headers.get("x-direct-session");
      return id ? /^[0-9a-f-]{36}$/.test(id) && sessions.has(id) : sessions.size < 16;
    },
    onOpen: (peer, opening) => {
      if (stopping || options.refusal()) return peer.close(1001);
      const previous = opening.headers.get("x-direct-session");
      if (previous) {
        const owned = sessions.get(previous);
        if (!owned) return peer.close(4409);
        peers.set(peer, owned); owned.link.open(peer); return;
      }
      if (sessions.size >= 16) return peer.close(4429);
      const id = randomUUID(), abort = new AbortController();
      const link = new FramedLink({ maxFrameBytes: options.maxFrameBytes, maxBuffered: 10000, maxBufferedBytes: 16 * 1024 * 1024, maxInboundBytes: 4 * 1024 * 1024, maxPending: 4, keepAliveMs: options.keepAliveMs, resumeWindowMs: options.resumeWindowMs, notice: options.notice, trace: () => {} });
      let partial = "";
      const streams: StandardStreams = {
        stdinIsTTY: false, stdoutIsTTY: false, readAllStdin: async () => "", stdinLines: () => link.lines(),
        writeErr: () => {}, // Session diagnostics travel on the authenticated event stream, never a shared console.
        writeOut: text => {
          partial += text;
          if (Buffer.byteLength(partial) > 2 * options.maxFrameBytes) { abort.abort(); link.close(); return; }
          let end: number;
          while ((end = partial.indexOf("\n")) !== -1) {
            const line = partial.slice(0, end); partial = partial.slice(end + 1);
            if (!line.trim()) continue;
            const value = JSON.parse(line) as Record<string, unknown>;
            if (value["type"] === "control_init") value["directServer"] = { id, cwd: root, version: options.version, resumeWindowMs: options.resumeWindowMs };
            link.sendLine(JSON.stringify(value));
          }
        },
      };
      // Register before composing the engine; even synchronous startup output belongs to this owned session.
      let settle!: () => void;
      const done = new Promise<void>(resolve => { settle = resolve; }), owned = { link, abort, done };
      sessions.set(id, owned); peers.set(peer, owned); link.open(peer);
      options.notice("Session directe ouverte.");
      void Promise.resolve().then(() => options.runSession({ root, privateFiles: options.privateFiles ?? [], streams, signal: abort.signal, waitConnected: signal => link.waitAttached(signal) })).catch(() => {
        link.sendLine(JSON.stringify({ type: "error", code: "direct_session", message: "Session directe interrompue." }));
      }).finally(async () => {
        try { await link.drain(); }
        finally {
          link.close(); sessions.delete(id);
          for (const [connection, session] of peers) if (session === owned) peers.delete(connection);
          settle();
        }
      }).catch(() => { abort.abort(); link.close(); settle(); });
    },
    onMessage: (peer, text) => peers.get(peer)?.link.receive(peer, text),
    onClose: peer => { const session = peers.get(peer); peers.delete(peer); session?.link.closed(peer); },
  });
  const url = options.listen.kind === "unix" ? `unix:${options.listen.path}` : `${options.tls ? "wss" : "ws"}://${server.hostname.includes(":") ? `[${server.hostname}]` : server.hostname}:${server.port}/`;
  let closing: Promise<void> | undefined;
  return { url, get sessionCount() { return sessions.size; }, stop: () => closing ??= (async () => {
    stopping = true;
    const running = [...sessions.values()];
    let stopError: unknown;
    let transport: Promise<void> = Promise.resolve();
    try { if (server.stopJoined) transport = server.stopJoined(); else server.stop(); } catch (error) { stopError = error; }
    for (const session of running) { session.abort.abort(); session.link.close(); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([Promise.all([transport, ...running.map(session => session.done)]), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Arrêt des sessions directes hors délai.")), 10000); })]); }
    finally { clearTimeout(timer); }
    if (stopError) throw stopError;
  })() };
}
