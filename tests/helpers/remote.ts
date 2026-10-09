// A remote host of the control channel (SPEC-MOD-007): a WebSocket connection to an engine in server mode, with the
// same correlation helpers as the local host.

import { cli, loadIdentity, type CliRun, type Workspace } from "./env";
import type { ModelProvider } from "../../src/providers/types";
import type { Identity } from "../../src/identity/identity";

export const PREFIX = loadIdentity().get("ENV_PREFIX");
export const TOKEN = "jeton-de-test";

export type Frame = Record<string, unknown> & { type: string };

/** An engine listening on the loopback interface; resolves once it announced its address. */
export async function listeningEngine(
  ws: Workspace,
  provider: ModelProvider,
  o: { argv?: string[]; env?: Record<string, string>; userConfig?: Record<string, unknown>; signal?: AbortSignal; identity?: Identity } = {},
): Promise<{ url: string; run: Promise<CliRun>; stderr: () => string }> {
  let err = "";
  let announced: (url: string) => void;
  const url = new Promise<string>((r) => (announced = r));
  const run = cli(["--non-interactive", "--control-listen=127.0.0.1:0", ...(o.argv ?? [])], ws, {
    provider,
    identity: o.identity,
    env: { [`${PREFIX}CONTROL_TOKEN`]: TOKEN, ...(o.env ?? {}) },
    ...(o.userConfig ? { userConfig: o.userConfig } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
    onErr: (t) => {
      err += t;
      const m = /En écoute sur (wss?:\/\/\S+)/.exec(err);
      if (m) announced(m[1]!);
    },
  });
  const first = await Promise.race([url, run.then((r) => `failed:${r.stderr}`)]);
  if (first.startsWith("failed:")) throw new Error(first);
  return { url: first, run, stderr: () => err };
}

export class RemoteHost {
  readonly frames: Frame[] = [];
  readonly opened: Promise<boolean>;
  readonly closed: Promise<number>;
  readonly #ws: WebSocket;
  #next = 1;
  readonly #waiters: Array<{ test: (f: Frame) => boolean; resolve: (f: Frame) => void }> = [];

  constructor(url: string, o: { token?: string; headers?: Record<string, string> } = {}) {
    this.#ws = new WebSocket(url, { headers: { Authorization: `Bearer ${o.token ?? TOKEN}`, ...(o.headers ?? {}) } } as unknown as string[]);
    this.opened = new Promise((resolve) => {
      this.#ws.onopen = () => resolve(true);
      this.#ws.onerror = () => resolve(false);
    });
    this.closed = new Promise((resolve) => (this.#ws.onclose = (e) => resolve(e.code)));
    this.#ws.onmessage = (e) => {
      const f = JSON.parse(String(e.data)) as Frame;
      this.frames.push(f);
      for (const w of [...this.#waiters]) {
        if (w.test(f)) {
          this.#waiters.splice(this.#waiters.indexOf(w), 1);
          w.resolve(f);
        }
      }
    };
  }

  send(frame: Record<string, unknown>): void {
    this.#ws.send(JSON.stringify(frame));
  }

  sendRaw(text: string): void {
    this.#ws.send(text);
  }

  init(extra: Record<string, unknown> = {}): void {
    this.send({ type: "control_init", protocolVersion: "1.0", demands: [], ...extra });
  }

  async request(request: string, params: Record<string, unknown> = {}): Promise<Frame> {
    const id = `r-${this.#next++}`;
    const response = this.waitFor((f) => f.type === "control_response" && f["id"] === id);
    this.send({ type: "control_request", id, request, params });
    return response;
  }

  waitFor(test: (f: Frame) => boolean, timeoutMs = 10_000): Promise<Frame> {
    const found = this.frames.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`trame attendue non reçue ; reçues : ${this.frames.map((f) => f.type).join(", ")}`)), timeoutMs);
      this.#waiters.push({
        test,
        resolve: (f) => {
          clearTimeout(timer);
          resolve(f);
        },
      });
    });
  }

  /** Highest number received (EF-03). */
  get lastSeq(): number {
    return Math.max(0, ...this.frames.map((f) => (typeof f["seq"] === "number" ? (f["seq"] as number) : 0)));
  }

  close(): void {
    this.#ws.close(1000);
  }
}
