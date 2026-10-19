// Supports: SPEC-AGT-012, SPEC-AGT-015 (bounded authenticated process transport).
import { randomUUID } from "node:crypto";
import { LocalPeers, type PeerMessage } from "../session/peers";

const LIMIT = 16 * 1024 * 1024, CHUNK = 40000;
/** Reuses the owner-only, mutually authenticated local peer transport; no public listener. */
export class TeamChannel {
  readonly peers: LocalPeers;
  readonly #pending = new Map<string, { peer: string; resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  readonly #incoming = new Map<string, { from: string; chunks: string[]; bytes: number; total: number; timer: ReturnType<typeof setTimeout> }>();
  readonly #executing = new Map<string, AbortController>();
  #closed = false;
  #handling = 0;
  constructor(folder: string, cwd: string, name: string, readonly handle: (from: string, method: string, value: unknown, signal: AbortSignal) => Promise<unknown>) {
    this.peers = new LocalPeers({ folder, cwd, name: () => name, enabled: () => !this.#closed, maxBytes: () => 65536, redact: text => text, warn: () => {}, receive: message => this.#receive(message) });
  }
  get ready() { return this.peers.ready; }
  // The registration is discoverable only inside the owner-only rendezvous directory.
  self(): string { return this.peers.address; }
  async #send(to: string, value: unknown, signal: AbortSignal): Promise<void> {
    const body = Buffer.from(JSON.stringify(value)); if (body.length > LIMIT) throw new Error("Team IPC payload exceeds its limit.");
    const id = randomUUID(), encoded = body.toString("base64"), total = Math.ceil(encoded.length / CHUNK);
    for (let index = 0; index < total; index++) await this.peers.send(to, JSON.stringify({ id, index, total, chunk: encoded.slice(index * CHUNK, (index + 1) * CHUNK) }), signal);
  }
  #receive(message: PeerMessage): boolean {
    try {
      const value = JSON.parse(message.message) as { id: string; index: number; total: number; chunk: string };
      if (!/^[a-f0-9-]{36}$/.test(value.id) || !Number.isSafeInteger(value.total) || value.total < 1 || value.total > Math.ceil(LIMIT * 4 / 3 / CHUNK) || !Number.isSafeInteger(value.index) || value.index < 0 || value.index >= value.total || typeof value.chunk !== "string" || value.chunk.length > CHUNK || !/^[A-Za-z0-9+/=]*$/.test(value.chunk)) return false;
      const key = message.from + value.id;
      let entry = this.#incoming.get(key);
      if (!entry) {
        if (value.index !== 0 || this.#incoming.size >= 4) return false;
        const timer = setTimeout(() => this.#incoming.delete(key), 10000); timer.unref();
        entry = { from: message.from, chunks: [], total: value.total, bytes: 0, timer }; this.#incoming.set(key, entry);
      }
      if (entry.total !== value.total || entry.chunks.length !== value.index) return false;
      entry.bytes += value.chunk.length; if (entry.bytes > Math.ceil(LIMIT * 4 / 3) + 4) return false;
      entry.chunks.push(value.chunk);
      if (entry.chunks.length === entry.total) {
        clearTimeout(entry.timer); this.#incoming.delete(key);
        const raw = Buffer.from(entry.chunks.join(""), "base64"); if (raw.length > LIMIT) return false;
        const data = JSON.parse(raw.toString("utf8")) as { id: string; method?: string; value?: unknown; error?: string; cancel?: boolean };
        if (!/^[a-f0-9-]{36}$/.test(data.id)) return false;
        if (data.cancel === true) { this.#executing.get(message.from + data.id)?.abort(); return true; }
        if (typeof data.method === "string") {
          if (data.method.length > 64 || this.#handling >= 16) return false;
          this.#handling++;
          const key = message.from + data.id, controller = new AbortController();
          if (this.#executing.has(key)) { this.#handling--; return false; } this.#executing.set(key, controller);
          const refuse = () => this.#send(message.from, { id: data.id, error: "Team operation refused, interrupted or too large." }, AbortSignal.timeout(10000));
          void this.handle(message.from, data.method, data.value, controller.signal).then(value => this.#send(message.from, { id: data.id, value }, AbortSignal.timeout(10000)).catch(refuse), refuse).catch(() => {}).finally(() => { this.#handling--; this.#executing.delete(key); });
        } else {
          const pending = this.#pending.get(data.id); if (!pending || pending.peer !== message.from) return false;
          this.#pending.delete(data.id); data.error ? pending.reject(new Error(data.error)) : pending.resolve(data.value);
        }
      }
      return true;
    } catch { return false; }
  }
  async request(to: string, method: string, value: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted(); if (this.#closed || this.#pending.size >= 16) throw new Error("Team channel closed or busy.");
    const id = randomUUID(); let abort = () => {};
    const answer = new Promise<unknown>((resolve, reject) => { this.#pending.set(id, { peer: to, resolve, reject }); abort = () => { this.#pending.delete(id); void this.#send(to, { id, cancel: true }, AbortSignal.timeout(2000)).catch(() => {}); reject(new Error("Team request interrupted; it was not replayed.")); }; signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); });
    void this.#send(to, { id, method, value }, signal).catch(() => { this.#pending.get(id)?.reject(new Error("Team destination unavailable; request was not replayed.")); this.#pending.delete(id); });
    try { return await answer; } finally { signal.removeEventListener("abort", abort); this.#pending.delete(id); }
  }
  disconnected(peer: string): void { for (const [id, pending] of this.#pending) if (pending.peer === peer) { this.#pending.delete(id); void this.#send(peer, { id, cancel: true }, AbortSignal.timeout(2000)).catch(() => {}); pending.reject(new Error("Team leader disconnected; request was not replayed.")); } }
  async close(): Promise<void> { this.#closed = true; for (const controller of this.#executing.values()) controller.abort(); for (const entry of this.#incoming.values()) clearTimeout(entry.timer); this.#incoming.clear(); for (const pending of this.#pending.values()) pending.reject(new Error("Team channel ended.")); this.#pending.clear(); await this.peers.close(); }
}
