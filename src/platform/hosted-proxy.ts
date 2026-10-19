// Implements: SPEC-PER-023 (protected parent, authenticated persistent upstream, private child trust and mandatory namespace relay).
import { dlopen } from "bun:ffi";
import { X509Certificate, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { connect as connectHttp2, sensitiveHeaders } from "node:http2";
import type { ClientHttp2Session, ClientHttp2Stream } from "node:http2";
import { createServer, request } from "node:http";
import type { Server } from "node:http";
import type { Socket } from "node:net";
import { CommandSandbox } from "./sandbox";
import type { SandboxLaunch } from "./sandbox-kernel";
import { proxyDestination } from "./sandbox-network";
import { currentPlatform, isWithin } from "./system";
export interface HostedUpstreamConfiguration { readonly protocol: "h2-connect-v1"; readonly url: string; readonly tokenFile: string; readonly bootstrapCaFile?: string }
export function upstreamConfiguration(raw: unknown): HostedUpstreamConfiguration {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Hosted upstream configuration required.");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !["protocol", "url", "tokenFile", "bootstrapCaFile"].includes(key)) || value.protocol !== "h2-connect-v1" || typeof value.url !== "string" || typeof value.tokenFile !== "string" || !isAbsolute(value.tokenFile) || value.bootstrapCaFile !== undefined && (typeof value.bootstrapCaFile !== "string" || !isAbsolute(value.bootstrapCaFile))) throw Error("Invalid hosted upstream configuration.");
  const url = new URL(value.url);
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || url.pathname !== "/") throw Error("Hosted upstream requires an HTTPS origin.");
  return { protocol: "h2-connect-v1", url: url.href, tokenFile: value.tokenFile, ...(value.bootstrapCaFile ? { bootstrapCaFile: value.bootstrapCaFile as string } : {}) };
}
/** Per-process kernel protection, applied before reading any upstream credential. Never relaxed during this process. */
export function protectHostedProxyMemory(): void {
  if (currentPlatform() !== "linux" || process.arch !== "x64" || process.execArgv.some(value => /--inspect|--debug/.test(value))) throw Error("Hosted upstream requires native Linux x64 without an inspector.");
  const api = dlopen("libc.so.6", { prctl: { args: ["i32", "u64", "u64", "u64", "u64"], returns: "i32" } });
  try { if (api.symbols.prctl(4, 0, 0, 0, 0) !== 0 || api.symbols.prctl(3, 0, 0, 0, 0) !== 0) throw Error("Hosted upstream memory protection unavailable."); }
  finally { api.close(); }
}
function privateControl(path: string, limit: number) {
  const parent = lstatSync(dirname(path));
  if (realpathSync(dirname(path)) !== dirname(path) || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) throw Error("Private upstream control directory required.");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size < 1 || stat.size > limit) throw Error("Private upstream control file required.");
    const bytes = Buffer.alloc(limit + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    if (length > limit) { bytes.fill(0); throw Error("Upstream control file too large."); }
    return { bytes: bytes.subarray(0, length), stat };
  } finally { closeSync(fd); }
}
interface LaunchInput { readonly command: string; readonly file: string; readonly args: readonly string[]; readonly cwd: string; readonly allowed: readonly string[]; readonly environment: Readonly<Record<string, string>> }
/** The upstream session and its credential remain in the supervisor. Children inherit only namespace-local routing. */
export class HostedProxy {
  readonly #failed = new AbortController(); readonly #token: Buffer; readonly #capability = randomBytes(32).toString("base64url");
  readonly #streams = new Set<ClientHttp2Stream>(); readonly #sockets = new Set<Socket>(); readonly #launches = new Set<SandboxLaunch>();
  readonly #client: ClientHttp2Session; readonly #server: Server; readonly #directory: string; readonly #trust: string;
  #closed = false; #ready = false; #endpoint = ""; #bytes = 0;
  private constructor(readonly configuration: HostedUpstreamConfiguration, readonly runtime: string, directory: string, token: Buffer, ca: string | undefined) {
    this.#directory = directory; this.#trust = join(directory, "trust"); mkdirSync(this.#trust, { mode: 0o755 }); chmodSync(this.#trust, 0o755); this.#token = token;
    this.#client = connectHttp2(configuration.url, { ca, rejectUnauthorized: true, minVersion: "TLSv1.2", settings: { enablePush: false } });
    const fail = () => this.close();
    this.#client.on("error", fail); this.#client.on("close", fail); this.#client.on("goaway", fail); this.#client.on("stream", stream => stream.destroy());
    this.#server = createServer({ maxHeaderSize: 16384 }, (incoming, response) => {
      const cap = incoming.headers["x-relay-capability"];
      if (!this.#ready || incoming.method !== "GET" || incoming.url !== "/_ready" || !this.#accepts(cap)) { response.writeHead(503).end(); return; }
      response.writeHead(200, { "content-type": "application/json", "connection": "close" }).end(JSON.stringify({ ready: true, instance: this.#capability }));
    });
    this.#server.maxConnections = 32;
    this.#server.on("error", fail);
    this.#server.on("connection", socket => { this.#sockets.add(socket); socket.setTimeout(60000, () => socket.destroy()); socket.once("close", () => this.#sockets.delete(socket)); });
    this.#server.on("connect", (incoming, socket, head) => {
      if (!this.#ready || !this.#accepts(incoming.headers["x-relay-capability"]) || head.length > 65536) { socket.end("HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n"); return; }
      void (async () => {
        const target = proxyDestination(`GET http://${incoming.url}/ HTTP/1.1\r\nHost: ${incoming.url}\r\n\r\n`);
        if (![80, 443].includes(target.port)) throw Error();
        const stream = await this.#tunnel(target.host + ":" + target.port);
        if (this.#closed || socket.destroyed) { stream.destroy(); return; }
        socket.on("error", () => stream.destroy()); stream.on("error", () => socket.destroy());
        const count = (bytes: Buffer) => { if ((this.#bytes += bytes.length) > 512 * 1024 * 1024) this.close(); };
        socket.on("data", count); stream.on("data", count);
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) stream.write(head);
        socket.pipe(stream); stream.pipe(socket); socket.once("close", () => stream.destroy());
      })().catch(() => socket.destroy());
    });
  }
  get failure(): AbortSignal { return this.#failed.signal; }
  get metrics() { return { ready: this.#ready && !this.#closed, bytes: this.#bytes, activeTunnels: this.#streams.size }; }
  get endpoint(): string { if (!this.#ready || this.#closed) throw Error("Hosted upstream is not ready."); return this.#endpoint; }
  #accepts(raw: unknown): boolean { return typeof raw === "string" && raw.length === this.#capability.length && /^[A-Za-z0-9_-]+$/.test(raw) && timingSafeEqual(Buffer.from(raw), Buffer.from(this.#capability)); }
  #headers(values: Record<string, string>) { return { ...values, authorization: "Bearer " + this.#token.toString("utf8"), [sensitiveHeaders]: ["authorization"] }; }
  async #document(path: string, signal: AbortSignal, limit: number): Promise<Buffer> {
    const stream = this.#client.request(this.#headers({ ":method": "GET", ":path": path }), { endStream: true }); this.#streams.add(stream);
    try {
      return await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []; let length = 0, accepted = false;
        const fail = () => { stream.destroy(); reject(Error("Upstream handshake refused.")); };
        const abort = () => fail(); signal.addEventListener("abort", abort, { once: true });
        const cleanup = () => signal.removeEventListener("abort", abort);
        stream.once("response", headers => { if (headers[":status"] !== 200 || headers["x-session-relay"] !== "1") fail(); else accepted = true; });
        stream.on("data", bytes => { if ((length += bytes.length) > limit) fail(); else chunks.push(Buffer.from(bytes)); });
        stream.once("error", fail); stream.once("end", () => { cleanup(); accepted ? resolve(Buffer.concat(chunks)) : fail(); });
        stream.once("close", () => { cleanup(); if (!accepted || !stream.readableEnded) reject(Error("Upstream handshake closed.")); });
        if (signal.aborted) fail();
      });
    } finally { this.#streams.delete(stream); stream.destroy(); }
  }
  async #tunnel(authority: string): Promise<ClientHttp2Stream> {
    if (this.#closed || !this.#ready || this.#streams.size >= 32) throw Error("Hosted upstream unavailable.");
    const stream = this.#client.request(this.#headers({ ":method": "CONNECT", ":authority": authority }), { endStream: false }); this.#streams.add(stream);
    stream.on("error", () => {}); stream.once("close", () => this.#streams.delete(stream)); stream.setTimeout(60000, () => stream.destroy());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { stream.destroy(); reject(Error("Upstream tunnel timed out.")); }, 5000);
      stream.once("error", () => { clearTimeout(timer); reject(Error("Upstream tunnel refused.")); });
      stream.once("close", () => { clearTimeout(timer); reject(Error("Upstream tunnel closed.")); });
      stream.once("response", headers => { clearTimeout(timer); if (headers[":status"] === 200) resolve(); else { stream.destroy(); reject(Error("Upstream tunnel refused.")); } });
    });
    return stream;
  }
  static async start(raw: HostedUpstreamConfiguration, options: { runtime: string; trustParent: string; signal: AbortSignal }): Promise<HostedProxy> {
    const configuration = upstreamConfiguration(raw); protectHostedProxyMemory(); options.signal.throwIfAborted();
    const control = privateControl(configuration.tokenFile, 4096); let proxy: HostedProxy | undefined, directory: string | undefined;
    const token = Buffer.from(control.bytes.toString("utf8").trim()); control.bytes.fill(0);
    try {
      if (!/^[\x21-\x7e]{32,4096}$/.test(token.toString("utf8"))) throw Error();
      const parent = lstatSync(options.trustParent); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== process.getuid?.() || (parent.mode & 0o022) !== 0) throw Error();
      const bootstrap = configuration.bootstrapCaFile ? privateControl(configuration.bootstrapCaFile, 262144).bytes.toString("utf8") : undefined;
      directory = mkdtempSync(join(realpathSync(options.trustParent), ".upstream-"));
      // This directory contains public certificates only. UID-isolated bwrap must traverse its pinned mount source.
      chmodSync(directory, 0o711);
      proxy = new HostedProxy(configuration, options.runtime, directory, token, bootstrap);
      const signal = AbortSignal.any([options.signal, proxy.failure, AbortSignal.timeout(2000)]);
      const abort = () => proxy?.close(); options.signal.addEventListener("abort", abort, { once: true }); proxy.failure.addEventListener("abort", () => options.signal.removeEventListener("abort", abort), { once: true });
      const certificate = await proxy.#document("/session-relay/ca.pem", signal, 262144), text = certificate.toString("utf8"), parsed = new X509Certificate(text);
      if (!parsed.ca || (text.match(/-----BEGIN CERTIFICATE-----/g) ?? []).length !== 1 || Date.parse(parsed.validTo) <= Date.now() || Date.parse(parsed.validFrom) > Date.now()) throw Error();
      const system = readFileSync("/etc/ssl/certs/ca-certificates.crt");
      writeFileSync(join(proxy.#trust, "ca.pem"), Buffer.concat([system, Buffer.from("\n" + parsed.toString() + "\n")]), { flag: "wx", mode: 0o644 });
      chmodSync(join(proxy.#trust, "ca.pem"), 0o644);
      const ready = await proxy.#document("/session-relay/ready", signal, 1024); if (ready.toString("utf8") !== "ready\n") throw Error();
      await new Promise<void>((resolve, reject) => { const aborted = () => reject(Error("Relay startup cancelled.")); signal.addEventListener("abort", aborted, { once: true }); proxy!.#server.listen(0, "127.0.0.1", () => { signal.removeEventListener("abort", aborted); resolve(); }); if (signal.aborted) aborted(); });
      const address = proxy.#server.address(); if (!address || typeof address === "string") throw Error();
      proxy.#endpoint = `http://127.0.0.1:${address.port}`; proxy.#ready = true;
      await new Promise<void>((resolve, reject) => {
        const check = request(proxy!.#endpoint + "/_ready", { signal, headers: { "x-relay-capability": proxy!.#capability } }, response => {
          const parts: Buffer[] = []; let length = 0;
          response.on("data", bytes => { if ((length += bytes.length) > 1024) check.destroy(Error("Invalid relay readiness.")); else parts.push(Buffer.from(bytes)); });
          response.once("end", () => { try { const value = JSON.parse(Buffer.concat(parts).toString()); if (response.statusCode !== 200 || value.ready !== true || value.instance !== proxy!.#capability) throw Error(); resolve(); } catch { reject(Error("Invalid relay readiness.")); } });
        }); check.once("error", reject); check.end();
      });
      signal.throwIfAborted();
      const current = lstatSync(configuration.tokenFile);
      if (current.dev !== control.stat.dev || current.ino !== control.stat.ino || current.size !== control.stat.size || current.mtimeMs !== control.stat.mtimeMs || current.ctimeMs !== control.stat.ctimeMs || current.isSymbolicLink()) throw Error();
      unlinkSync(configuration.tokenFile); return proxy;
    } catch {
      token.fill(0); proxy?.close(); if (!proxy && directory) { try { rmdirSync(directory); } catch {} }
      throw Error("Hosted upstream relay unavailable; execution refused.");
    }
  }
  launch(input: LaunchInput): SandboxLaunch {
    if (!this.#ready || this.#closed || input.allowed.some(root => isWithin(this.configuration.tokenFile, root, "linux")) || [input.file, ...input.args, ...Object.values(input.environment)].some(value => value.includes(this.#token.toString("utf8")))) throw Error("Hosted upstream envelope unavailable or unsafe.");
    const ca = join(this.#trust, "ca.pem"), environment = { ...input.environment, HTTP_PROXY: this.endpoint, HTTPS_PROXY: this.endpoint, ALL_PROXY: this.endpoint, http_proxy: this.endpoint, https_proxy: this.endpoint, all_proxy: this.endpoint, NO_PROXY: "", no_proxy: "", SSL_CERT_FILE: ca, CURL_CA_BUNDLE: ca, REQUESTS_CA_BUNDLE: ca, NODE_EXTRA_CA_CERTS: ca, GIT_SSL_CAINFO: ca, npm_config_cafile: ca };
    for (const name of ["NODE_TLS_REJECT_UNAUTHORIZED", "GIT_SSL_NO_VERIFY", "PYTHONHTTPSVERIFY"]) delete (environment as Record<string, string>)[name];
    const sandbox = new CommandSandbox(() => ({ enabled: true, autoAllow: false, allowOutside: false, excludedCommands: [], files: { writable: input.allowed, readable: [this.#trust], hidden: [], readDenied: () => false, writeDenied: () => false }, network: { authorize: async () => !this.#closed, allowsPrivate: () => false, violation: () => {}, transport: (destination, signal) => this.#localTunnel(destination.host + ":" + destination.port, signal) } }), this.runtime);
    const wrapped = sandbox.launch({ ...input, environment });
    const launch: SandboxLaunch = { ...wrapped, close: () => { this.#launches.delete(launch); wrapped.close(); } }; this.#launches.add(launch); return launch;
  }
  #localTunnel(authority: string, signal: AbortSignal): Promise<Socket> {
    return new Promise((resolve, reject) => {
      if (this.#closed) { reject(Error("Hosted upstream unavailable.")); return; }
      const target = new URL(this.endpoint), call = request({ host: target.hostname, port: target.port, method: "CONNECT", path: authority, headers: { host: authority, "x-relay-capability": this.#capability }, signal, timeout: 5000 });
      call.once("timeout", () => call.destroy()); call.once("error", () => reject(Error("Local relay unavailable.")));
      call.once("connect", (response, socket, head) => { if (response.statusCode !== 200 || head.length || this.#closed) { socket.destroy(); reject(Error("Local relay refused tunnel.")); } else resolve(socket); }); call.end();
    });
  }
  close(): void {
    if (this.#closed) return; this.#closed = true; this.#ready = false; this.#failed.abort();
    for (const launch of this.#launches) launch.close(); this.#launches.clear();
    for (const socket of this.#sockets) socket.destroy(); this.#sockets.clear();
    for (const stream of this.#streams) stream.destroy(); this.#streams.clear();
    try { this.#server.close(); } catch {} this.#client.destroy(); this.#token.fill(0);
    try { unlinkSync(join(this.#trust, "ca.pem")); } catch {} try { rmdirSync(this.#trust); rmdirSync(this.#directory); } catch {}
  }
}
