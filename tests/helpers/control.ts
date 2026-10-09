// A simulated host of the control channel (SPEC-MOD-006): it feeds the standard input of an in-process run line by line,
// reads its output as it is written, answers the demands of the engine and correlates its own requests.

import type { CliRun, Workspace } from "./env";
import { cli } from "./env";
import type { ModelProvider } from "../../src/providers/types";
import type { Identity } from "../../src/identity/identity";

/** A live line source: lines pushed by the test, until `end()`. */
export class LineFeed implements AsyncIterable<string> {
  readonly #lines: string[] = [];
  #wake: (() => void) | undefined;
  #ended = false;

  push(line: string): void {
    this.#lines.push(line);
    this.#wake?.();
  }

  end(): void {
    this.#ended = true;
    this.#wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      const line = this.#lines.shift();
      if (line !== undefined) {
        yield line;
        continue;
      }
      if (this.#ended) return;
      await new Promise<void>((r) => (this.#wake = r));
      this.#wake = undefined;
    }
  }
}

export type Message = Record<string, unknown> & { type: string };
export type DemandHandler = (params: Record<string, unknown>, message: Message) => unknown | Promise<unknown> | undefined;

export interface HostOptions {
  readonly identity?: Identity;
  readonly argv?: string[];
  readonly provider: ModelProvider;
  readonly userConfig?: Record<string, unknown>;
  readonly env?: Record<string, string>;
  /** The initialization sent by the host; `null`: none is sent. */
  readonly init?: Record<string, unknown> | null;
  /** Answers of the host by demand; `undefined` returned: no answer at all. */
  readonly answers?: Partial<Record<string, DemandHandler>>;
}

export class Host {
  readonly feed = new LineFeed();
  readonly messages: Message[] = [];
  readonly run: Promise<CliRun>;
  #partial = "";
  #next = 1;
  readonly #waiters: Array<{ test: (m: Message) => boolean; resolve: (m: Message) => void }> = [];
  readonly #answers: Partial<Record<string, DemandHandler>>;

  constructor(ws: Workspace, o: HostOptions) {
    this.#answers = o.answers ?? {};
    this.run = cli(["--non-interactive", "--control-channel", "--request-format", "jsonl", "--result-format", "jsonl", ...(o.argv ?? [])], ws, {
      provider: o.provider,
      identity: o.identity,
      stdinSource: this.feed,
      onOut: (t) => this.#onOut(t),
      ...(o.userConfig ? { userConfig: o.userConfig } : {}),
      ...(o.env ? { env: o.env } : {}),
    });
    if (o.init !== null) this.send({ type: "control_init", protocolVersion: "1.0", demands: ["approval_request", "confirm_escalation", "notify"], ...(o.init ?? {}) });
  }

  send(message: Record<string, unknown>): void {
    this.feed.push(JSON.stringify(message));
  }

  user(content: string): void {
    this.send({ type: "user", content });
  }

  /** A request of the host; resolves with the correlated response. */
  async request(request: string, params: Record<string, unknown> = {}): Promise<Message> {
    const id = `h-${this.#next++}`;
    const response = this.waitFor((m) => m.type === "control_response" && m["id"] === id);
    this.send({ type: "control_request", id, request, params });
    return response;
  }

  /** Resolves with the first message, already received or to come, that satisfies `test`. */
  waitFor(test: (m: Message) => boolean, timeoutMs = 10_000): Promise<Message> {
    const found = this.messages.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`message attendu non reçu ; reçus : ${this.messages.map((m) => m.type + (m["request"] ? `:${m["request"]}` : "")).join(", ")}`)), timeoutMs);
      this.#waiters.push({
        test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  demands(name: string): Message[] {
    return this.messages.filter((m) => m.type === "control_request" && m["request"] === name);
  }

  async finish(): Promise<CliRun> {
    return this.run;
  }

  #onOut(text: string): void {
    this.#partial += text;
    let at: number;
    while ((at = this.#partial.indexOf("\n")) !== -1) {
      const line = this.#partial.slice(0, at);
      this.#partial = this.#partial.slice(at + 1);
      if (line.trim() === "") continue;
      const m = JSON.parse(line) as Message;
      this.messages.push(m);
      for (const w of [...this.#waiters]) {
        if (w.test(m)) {
          this.#waiters.splice(this.#waiters.indexOf(w), 1);
          w.resolve(m);
        }
      }
      if (m.type === "control_request") void this.#answer(m);
    }
  }

  async #answer(m: Message): Promise<void> {
    const handler = this.#answers[String(m["request"])];
    if (!handler) return;
    const result = await handler((m["params"] ?? {}) as Record<string, unknown>, m);
    if (result === undefined) return;
    this.send({ type: "control_response", id: m["id"], ok: true, result });
  }
}
