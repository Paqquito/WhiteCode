// Implements: SPEC-PER-015 (bounded domain proxy, pinned DNS and no direct-address or plaintext CONNECT escape).
import { Socket, connect, isIP } from "node:net";
import { sandboxChannel } from "./sandbox-channel";
import { lookup } from "node:dns/promises";
import { forbiddenAddress } from "../hooks/http";
import type { Duplex } from "node:stream";
export interface ProxyDestination { readonly host: string; readonly port: number; readonly url: string; readonly tunnel: boolean; readonly header: string }
export function proxyDestination(header: string): ProxyDestination {
  if (Buffer.byteLength(header) > 16384 || !header.endsWith("\r\n\r\n")) throw Error("Invalid proxy header.");
  const lines = header.slice(0, -4).split("\r\n"), first = /^(CONNECT|GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS) (\S+) HTTP\/1\.[01]$/.exec(lines.shift() ?? "");
  if (!first || lines.some(line => !/^[!#$%&'*+.^_`|~\w-]+: [^\r\n]*$/.test(line))) throw Error("Invalid proxy request.");
  const tunnel = first[1] === "CONNECT", url = new URL(tunnel ? "https://" + first[2] : first[2]!);
  if (url.username || url.password || url.hash || (tunnel ? url.protocol !== "https:" || url.port !== "" && url.port !== "443" || url.pathname !== "/" || !!url.search : url.protocol !== "http:")) throw Error("Only web proxy destinations are accepted.");
  const host = url.hostname.toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host) || isIP(host) || /^[\d.]+$/.test(host)) throw Error("Direct network addresses are forbidden.");
  const hosts = lines.filter(line => /^host:/i.test(line));
  if (hosts.length > 1 || !tunnel && hosts.length !== 1) throw Error("Proxy authority mismatch.");
  if (hosts.length) { const authority = hosts[0]!.slice(5).trim().toLowerCase(); if (!/^[a-z0-9.-]+(?::\d+)?$/.test(authority) || new URL(url.protocol + "//" + authority).host !== url.host) throw Error("Proxy authority mismatch."); }
  const forwarded = lines.filter(line => !/^(?:proxy-authorization|proxy-connection|connection):/i.test(line));
  return { host, port: Number(url.port || (tunnel ? 443 : 80)), url: url.href, tunnel, header: `${first[1]} ${url.pathname}${url.search} HTTP/1.1\r\n${forwarded.join("\r\n")}\r\nConnection: close\r\n\r\n` };
}
/** Wait for one complete, bounded ClientHello; require visible SNI and reject encrypted-name substitution. */
export function tlsServerName(bytes: Buffer): string | undefined {
  if (bytes.length > 65536) throw Error("TLS hello too large.");
  if (!bytes.length) return undefined;
  if (bytes[0] !== 22) throw Error("TLS client hello required.");
  if (bytes.length < 5) return undefined;
  const end = 5 + bytes.readUInt16BE(3); if (end > 65536) throw Error("TLS hello too large."); if (bytes.length < end) return undefined;
  if (end < 47 || bytes[5] !== 1 || bytes.readUIntBE(6, 3) + 9 > end) throw Error("Complete TLS client hello required.");
  let at = 43;
  const take = (count: number) => { const start = at; at += count; if (at > end) throw Error("Malformed TLS hello."); return start; };
  take(1 + bytes[at]!); const cipher = bytes.readUInt16BE(take(2)); take(cipher); take(1 + bytes[at]!);
  const extensions = bytes.readUInt16BE(take(2)), limit = at + extensions; if (limit > end) throw Error("Malformed TLS extensions.");
  let serverName: string | undefined;
  while (at < limit) {
    const type = bytes.readUInt16BE(take(2)), size = bytes.readUInt16BE(take(2)), start = take(size);
    if (type === 0xfe0d) throw Error("Encrypted TLS names are not allowed by the domain guard.");
    if (type === 0) { if (serverName || size < 5 || bytes[start + 2] !== 0 || bytes.readUInt16BE(start) !== size - 2 || bytes.readUInt16BE(start + 3) !== size - 5) throw Error("Malformed TLS server name."); serverName = bytes.subarray(start + 5, start + size).toString("latin1").toLowerCase(); }
  }
  if (!serverName || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(serverName)) throw Error("Valid TLS server name required."); return serverName;
}
export interface SandboxNetworkPolicy {
  authorize(url: string, signal: AbortSignal): Promise<boolean>;
  revalidate?: (url: string) => boolean;
  allowsPrivate(host: string): boolean;
  violation(message: string): void;
  resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  transport?: (destination: ProxyDestination, signal: AbortSignal) => Promise<Duplex>;
}
interface Frame { id: number; open?: boolean; data?: string; end?: boolean }
/** One preconnected stream per command. The guest cannot ask this endpoint to open a host Unix socket. */
export function sandboxNetwork(fd: number, policy: SandboxNetworkPolicy): { close(): void } {
  const controller = new AbortController();
  const peers = new Map<number, { buffer: Buffer; destination?: ProxyDestination; remote?: Duplex; pending: boolean }>();
  let lines = "", total = 0, lastId = 0, closed = false;
  const send = (frame: Frame) => { if (!closed) channel.write(JSON.stringify(frame) + "\n"); };
  const finish = (id: number) => { const peer = peers.get(id); peers.delete(id); peer?.remote?.destroy(); send({ id, end: true }); };
  const close = () => { if (closed) return; closed = true; controller.abort(); for (const peer of peers.values()) peer.remote?.destroy(); peers.clear(); channel.close(); };
  const reject = (id: number, message: string) => { policy.violation("Sandbox network violation: " + message); send({ id, data: Buffer.from("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n").toString("base64") }); finish(id); };
  const forward = async (id: number) => {
    const peer = peers.get(id); if (!peer || peer.pending || peer.remote) return;
    try {
      if (!peer.destination) {
        const end = peer.buffer.indexOf("\r\n\r\n"); if (end === -1) { if (peer.buffer.length > 16384) throw Error("proxy header too large"); return; }
        peer.destination = proxyDestination(peer.buffer.subarray(0, end + 4).toString("latin1")); peer.buffer = peer.buffer.subarray(end + 4); peer.pending = true;
        if (!await policy.authorize(peer.destination.url, controller.signal)) throw Error("domain refused: " + peer.destination.host);
        peer.pending = false; if (closed || !peers.has(id)) return;
        if (peer.destination.tunnel) send({ id, data: Buffer.from("HTTP/1.1 200 Connection Established\r\n\r\n").toString("base64") });
      }
      const destination = peer.destination;
      if (destination.tunnel) { const name = tlsServerName(peer.buffer); if (name === undefined) return; if (name !== destination.host) throw Error("TLS domain differs from the authorized tunnel"); }
      peer.pending = true;
      const addresses = policy.transport ? [] : await (policy.resolve ?? (host => lookup(host, { all: true })))(destination.host);
      if (!policy.transport && (!addresses.length || addresses.some(row => !isIP(row.address) || forbiddenAddress(row.address) && !policy.allowsPrivate(destination.host)))) throw Error("destination resolves to a forbidden address");
      if (closed || !peers.has(id)) return;
      if (policy.revalidate && !policy.revalidate(destination.url)) throw Error("network permission changed before connection");
      const remote = policy.transport ? await policy.transport(destination, controller.signal) : connect({ host: addresses[0]!.address, port: destination.port, family: addresses[0]!.family });
      if (closed || !peers.has(id)) { remote.destroy(); return; }
      if (policy.revalidate && !policy.revalidate(destination.url)) { remote.destroy(); throw Error("network permission changed before forwarding"); } peer.remote = remote;
      if (remote instanceof Socket) remote.setTimeout(60000, () => finish(id)); remote.on("error", () => finish(id)); remote.on("end", () => finish(id));
      remote.on("data", bytes => { if ((total += bytes.length) > 32 * 1024 * 1024) { close(); return; } send({ id, data: bytes.toString("base64") }); });
      const start = () => { if (!destination.tunnel) remote.write(destination.header); remote.write(peer.buffer); peer.buffer = Buffer.alloc(0); peer.pending = false; };
      if (policy.transport) start(); else remote.on("connect", start);
    } catch (error) { reject(id, error instanceof Error ? error.message : "connection refused"); }
  };
  const channel = sandboxChannel(fd, bytes => {
    if ((total += bytes.length) > 32 * 1024 * 1024 || (lines += bytes.toString()).length > 131072) { close(); return; }
    for (;;) {
      const cut = lines.indexOf("\n"); if (cut === -1) break;
      try {
        const frame = JSON.parse(lines.slice(0, cut)) as Frame; lines = lines.slice(cut + 1);
        if (!Number.isSafeInteger(frame.id) || frame.id < 1 || Object.keys(frame).some(key => !["id", "open", "data", "end"].includes(key))) throw Error();
        if (frame.open) { if (frame.id <= lastId || peers.size >= 32) throw Error(); lastId = frame.id; peers.set(frame.id, { buffer: Buffer.alloc(0), pending: false }); }
        // Client close/data can cross a server close already sent down the channel. Retired IDs are never reused.
        const peer = peers.get(frame.id); if (!peer) { if (frame.id <= lastId) continue; throw Error(); }
        if (frame.end) { finish(frame.id); continue; }
        if (frame.data !== undefined) {
          if (typeof frame.data !== "string" || frame.data.length > 90000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw Error();
          const payload = Buffer.from(frame.data, "base64");
          if (peer.remote && !peer.pending) peer.remote.write(payload);
          else { peer.buffer = Buffer.concat([peer.buffer, payload]); if (peer.buffer.length > 1048576) throw Error(); void forward(frame.id); }
        }
      } catch { policy.violation("Sandbox network violation: invalid relay frame"); close(); break; }
    }
  }, close);
  return { close };
}
