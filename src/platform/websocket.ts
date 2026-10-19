// Supports: SPEC-MOD-007 (§ 5.1 server and client modes, EF-01, EF-02, ERR-02), SPEC-MOD-008 (EF-07)
// The WebSocket transport of the runtime, kept here so that the rest of the product never names it. Text messages only;
// the protocol fragments and reassembles large messages itself (FA-05 of SPEC-MOD-007).

export interface WsPeer {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  /** Address of the other side, as the network gives it. */
  readonly remoteAddress: string;
}

export interface WsOpeningRequest { readonly headers: Headers; readonly remoteAddress: string }

import { chmodSync, lstatSync, mkdtempSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface WsServerOptions {
  readonly hostname: string;
  readonly port: number;
  readonly unix?: string;
  /** PEM texts; without them the server is not encrypted. */
  readonly tls?: { readonly cert: string; readonly key: string };
  readonly maxPayloadLength: number;
  /** Decides before the upgrade, so that nothing applicative is exchanged with a refused peer (EF-02). */
  readonly authorize: (request: WsOpeningRequest) => boolean;
  readonly onOpen: (peer: WsPeer, opening: WsOpeningRequest) => void;
  readonly onMessage: (peer: WsPeer, text: string) => void;
  readonly onClose: (peer: WsPeer) => void;
}

export interface WsServer {
  readonly hostname: string;
  readonly port: number;
  stop(): void;
  /** Joins the runtime listener and its owned local endpoint cleanup. */
  stopJoined?(): Promise<void>;
}

interface PeerData {
  peer?: WsPeer;
  readonly remoteAddress: string;
  readonly opening: WsOpeningRequest;
}

/** The runtime unlinks its socket unconditionally. Keep that physical name inside a private owned directory, and
 * publish only a separately owned symlink so a replacement at the user's address can never be removed by stop(). */
function ownedUnixListener(path: string): { socket: string; publish(): void; cleanup(): void } {
  try { lstatSync(path); throw new Error("Adresse de socket déjà occupée."); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const directory = mkdtempSync(join(tmpdir(), "direct-listener-")), owner = lstatSync(directory), socket = join(directory, "socket");
  let publicOwner: ReturnType<typeof lstatSync> | undefined;
  const cleanup = () => {
    if (publicOwner) try {
      const current = lstatSync(path);
      if (current.isSymbolicLink() && current.dev === publicOwner.dev && current.ino === publicOwner.ino && readlinkSync(path) === socket) unlinkSync(path);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    try {
      const current = lstatSync(directory);
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === owner.dev && current.ino === owner.ino) rmdirSync(directory);
    } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
  };
  try { chmodSync(directory, 0o700); } catch (error) { cleanup(); throw error; }
  return { socket, publish: () => { chmodSync(socket, 0o600); symlinkSync(socket, path); publicOwner = lstatSync(path); }, cleanup };
}

/** Listens; throws when the address is not available (ERR-02 of SPEC-MOD-007). */
export function listenWebSocket(o: WsServerOptions): WsServer {
  const local = o.unix ? ownedUnixListener(o.unix) : undefined;
  let runtime: ReturnType<typeof Bun.serve<PeerData, never>>;
  try { runtime = Bun.serve<PeerData, never>({
    ...(local ? { unix: local.socket } : { hostname: o.hostname, port: o.port }),
    ...(o.tls ? { tls: { cert: o.tls.cert, key: o.tls.key } } : {}),
    fetch(req, srv) {
      const remoteAddress = o.unix ? "local-socket" : srv.requestIP(req)?.address ?? "";
      // ERR-01: a refusal tells nothing of its cause.
      if (!o.authorize({ headers: req.headers, remoteAddress })) return new Response("Connexion refusée.", { status: 401 });
      if (srv.upgrade(req, { data: { remoteAddress, opening: { headers: new Headers(req.headers), remoteAddress } } })) return undefined;
      return new Response("Connexion refusée.", { status: 400 });
    },
    websocket: {
      maxPayloadLength: o.maxPayloadLength,
      idleTimeout: 0,
      open(ws) {
        const peer: WsPeer = { send: (t) => void ws.send(t), close: (code, reason) => ws.close(code, reason), remoteAddress: ws.data.remoteAddress };
        ws.data.peer = peer;
        o.onOpen(peer, ws.data.opening);
      },
      message(ws, message) {
        if (ws.data.peer) o.onMessage(ws.data.peer, typeof message === "string" ? message : Buffer.from(message).toString("utf8"));
      },
      close(ws) {
        if (ws.data.peer) o.onClose(ws.data.peer);
      },
    },
  }); } catch (error) { local?.cleanup(); throw error; }
  const server = runtime;
  try { local?.publish(); }
  catch (error) { void Promise.resolve(server.stop(true)).finally(() => local?.cleanup()).catch(() => {}); throw error; }
  let stopped: Promise<void> | undefined;
  const stopJoined = () => stopped ??= Promise.resolve(server.stop(true)).then(() => local?.cleanup());
  return { hostname: server.hostname ?? o.hostname, port: server.port ?? o.port, stopJoined, stop: () => { void stopJoined().catch(() => {}); } };
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

/** Local Unix sockets use the same authenticated WebSocket opening, without any TCP or proxy fallback. */
export function connectUnixWebSocket(path: string, headers: Record<string, string>, h: WsClientHandlers): { close(): void } {
  // The runtime does not decode URL-escaped socket names. A private symlink gives arbitrary physical names an
  // unambiguous transport address, without changing or replacing the supplied socket itself.
  const ambiguous = (value: string) => /[^\x21-\x7e]|[?#%:]/.test(value);
  let directory: string | undefined, alias: string | undefined, owned: ReturnType<typeof lstatSync> | undefined;
  const cleanup = () => {
    if (!directory || !owned) return;
    try {
      const current = lstatSync(directory);
      if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) return;
      if (alias) try { unlinkSync(alias); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      rmdirSync(directory);
    } catch (error) { if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    finally { directory = undefined; alias = undefined; owned = undefined; }
  };
  let ws: WebSocket;
  try {
    if (ambiguous(path)) {
      const temporary = tmpdir(); directory = mkdtempSync(join(ambiguous(temporary) ? "/tmp" : temporary, "direct-socket-"));
      owned = lstatSync(directory); chmodSync(directory, 0o700); alias = join(directory, "socket"); symlinkSync(path, alias);
    }
    ws = new WebSocket(`ws+unix://${alias ?? path}`, { headers });
  } catch (error) { cleanup(); throw error; }
  const peer: WsPeer = { send: text => void ws.send(text), close: (code, reason) => ws.close(code, reason), remoteAddress: "local-socket" };
  let ended = false;
  const end = () => { if (!ended) { ended = true; cleanup(); h.onClose(); } };
  ws.onopen = () => h.onOpen(peer);
  ws.onmessage = event => { if (typeof event.data !== "string") { ws.close(1003); end(); } else h.onMessage(event.data); };
  ws.onclose = end; ws.onerror = end;
  return { close: () => { ws.close(1000); end(); } };
}
