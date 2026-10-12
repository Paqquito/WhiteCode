// Implements: SPEC-INT-006 (LSP framing, initialization, bounded requests, process teardown).
// Supports: SPEC-OUT-040 (read-only server requests), gap E-143.
import { launchLine, startChild, type Child } from "../platform/process";

export function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
interface Pending { resolve(value: unknown): void; reject(error: Error): void; finish(): void }
const MAX_BODY = 8 * 1024 * 1024, MAX_HEADER = 8192;

/** Standard LSP on UTF-8 pipes, independent of connector transports. */
export class LanguageClient {
  readonly #child: Child;
  readonly #pending = new Map<number, Pending>();
  #buffer = Buffer.alloc(0);
  #next = 0;
  #closed = false;
  #dead = false;
  initialized = false;

  constructor(command: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>, notify: (method: string, params: unknown) => void, died: (code: number | null) => void) {
    const line = launchLine(command, args, env);
    this.#child = startChild(line.file, line.args, { cwd, env, keepInputOpen: true, onErrorData: () => {}, onData: (chunk) => {
      try {
        this.#buffer = Buffer.concat([this.#buffer, chunk]);
        while (!this.#closed) {
          const end = this.#buffer.indexOf("\r\n\r\n");
          if (end < 0) { if (this.#buffer.length > MAX_HEADER) throw new Error(); break; }
          if (end > MAX_HEADER) throw new Error();
          const headers = this.#buffer.subarray(0, end).toString("ascii");
          const lengths = [...headers.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)];
          if (lengths.length !== 1 || /charset=(?!utf-?8(?:\s|;|$))/i.test(headers)) throw new Error();
          const length = Number(lengths[0]![1]);
          if (length < 1 || length > MAX_BODY) throw new Error();
          if (this.#buffer.length < end + 4 + length) break;
          const message = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.#buffer.subarray(end + 4, end + 4 + length))));
          this.#buffer = this.#buffer.subarray(end + 4 + length);
          if (!message || message["jsonrpc"] !== "2.0") throw new Error();
          if (typeof message["method"] === "string") {
            if (message["id"] !== undefined) this.#serverRequest(message);
            else notify(message["method"], message["params"]);
          } else if (typeof message["id"] === "number") {
            const pending = this.#pending.get(message["id"]);
            if (pending) { pending.finish(); object(message["error"]) ? pending.reject(new Error("The language server rejected the request.")) : pending.resolve(message["result"]); }
          }
        }
      } catch { this.#dead = true; this.#fail(); void this.#child.killTree(100); }
    } });
    void this.#child.exited.then((code) => { this.#dead = true; this.#fail(); if (!this.#closed) died(code); });
  }
  #send(message: Record<string, unknown>): void {
    if (this.#closed || this.#dead) return;
    const body = JSON.stringify({ jsonrpc: "2.0", ...message });
    this.#child.input?.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
  }
  #serverRequest(message: Record<string, unknown>): void {
    // Servers cannot turn read-only analysis into writes, shell commands or user interaction.
    const method = message["method"];
    if (method === "workspace/applyEdit") this.#send({ id: message["id"], result: { applied: false, failureReason: "The analysis client does not apply server edits." } });
    else if (method === "workspace/configuration") {
      const items = object(message["params"])?.["items"];
      this.#send({ id: message["id"], result: Array.isArray(items) ? items.slice(0, 1000).map(() => null) : [] });
    } else if (["client/registerCapability", "client/unregisterCapability", "window/workDoneProgress/create"].includes(String(method))) this.#send({ id: message["id"], result: null });
    else this.#send({ id: message["id"], error: { code: -32601, message: "Unsupported server request." } });
  }
  notify(method: string, params: unknown): void { this.#send({ method, params }); }
  request(method: string, params: unknown, timeout: number, signal?: AbortSignal): Promise<unknown> {
    if (this.#closed || this.#dead || signal?.aborted) return Promise.reject(new Error("Language server request interrupted."));
    return new Promise((resolve, reject) => {
      const id = ++this.#next;
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); this.#pending.delete(id); };
      const aborted = () => { this.notify("$/cancelRequest", { id }); finish(); reject(new Error("Language server request interrupted.")); };
      const timer = setTimeout(() => { this.notify("$/cancelRequest", { id }); finish(); reject(new Error("The language server did not respond within the time limit.")); }, Math.max(1, timeout));
      this.#pending.set(id, { resolve, reject, finish }); signal?.addEventListener("abort", aborted, { once: true }); this.#send({ id, method, params });
    });
  }
  #fail(): void {
    for (const p of [...this.#pending.values()]) { p.finish(); p.reject(new Error("The language server is unavailable.")); }
    this.#buffer = Buffer.alloc(0);
  }
  async close(): Promise<void> {
    if (this.#closed) return;
    if (this.initialized) { try { await this.request("shutdown", null, 500); } catch {} this.#send({ method: "exit" }); }
    this.#closed = true; this.#fail(); this.#child.input?.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.#child.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); })]);
    clearTimeout(timer); await this.#child.killTree(100);
  }
}
