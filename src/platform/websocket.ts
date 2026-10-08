// Supports: SPEC-MOD-007 (§ 5.1 server and client modes, EF-01, EF-02, ERR-02), SPEC-MOD-008 (EF-07)
// The WebSocket transport of the runtime, kept here so that the rest of the product never names it. Text messages only;
// the protocol fragments and reassembles large messages itself (FA-05 of SPEC-MOD-007).

export interface WsPeer {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Address of the other side, as the network gives it. */
  readonly remoteAddress: string;
}

export interface WsServerOptions {
  readonly hostname: string;
  readonly port: number;
  /** PEM texts; without them the server is not encrypted. */
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly maxPayloadLength: number;
  /** Decides before the upgrade, so that nothing applicative is exchanged with a refused peer (EF-02). */
  readonly authorize: (request: { readonly headers: Headers; readonly remoteAddress: string }) => boolean;
  readonly onOpen: (peer: WsPeer) => void;
  readonly onMessage: (peer: WsPeer, text: string) => void;
  readonly onClose: (peer: WsPeer) => void;
}

export interface WsServer {
  readonly hostname: string;
  readonly port: number;
  stop(): void;
}

interface PeerData {
  peer?: WsPeer;
  readonly remoteAddress: string;
}

/** Listens; throws when the address is not available (ERR-02 of SPEC-MOD-007). */
export function listenWebSocket(o: WsServerOptions): WsServer {
  const server = Bun.serve<PeerData, never>({
    hostname: o.hostname,
    port: o.port,
    ...(o.tls ? { tls: { cert: o.tls.cert, key: o.tls.key } } : {}),
    fetch(req, srv) {
      const remoteAddress = srv.requestIP(req)?.address ?? "";
      // ERR-01: a refusal tells nothing of its cause.
      if (!o.authorize({ headers: req.headers, remoteAddress })) return new Response("Connexion refusée.", { status: 401 });
      if (srv.upgrade(req, { data: { remoteAddress } })) return undefined;
      return new Response("Connexion refusée.", { status: 400 });
    },
    websocket: {
      maxPayloadLength: o.maxPayloadLength,
      idleTimeout: 0,
      open(ws) {
        const peer: WsPeer = { send: (t) => void ws.send(t), close: (code, reason) => ws.close(code, reason), remoteAddress: ws.data.remoteAddress };
        ws.data.peer = peer;
        o.onOpen(peer);
      },
      message(ws, message) {
        if (ws.data.peer) o.onMessage(ws.data.peer, typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
      },
      close(ws) {
        if (ws.data.peer) o.onClose(ws.data.peer);
      },
    },
  });
  return { hostname: server.hostname ?? o.hostname, port: server.port ?? o.port, stop: () => void server.stop(true) };
}

export interface WsClientHandlers {
  readonly onOpen: (peer: WsPeer) => void;
  readonly onMessage: (text: string) => void;
  /** The connection ended or could not be opened. */
  readonly onClose: () => void;
}

/** Opens a connection with the given headers (the authentication of SPEC-MOD-007 § 5.2 step 2). */
export function connectWebSocket(url: string, headers: Record<string, string>, h: WsClientHandlers): { close(): void } {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  const peer: WsPeer = { send: (t) => ws.send(t), close: (code, reason) => ws.close(code, reason), remoteAddress: new URL(url).hostname };
  let closed = false;
  ws.onopen = () => h.onOpen(peer);
  ws.onmessage = (e) => h.onMessage(typeof e.data === "string" ? e.data : Buffer.from(e.data as ArrayBuffer).toString("utf8"));
  const end = () => {
    if (closed) return;
    closed = true;
    h.onClose();
  };
  ws.onclose = end;
  ws.onerror = end;
  return { close: () => ws.close(1000) };
}
