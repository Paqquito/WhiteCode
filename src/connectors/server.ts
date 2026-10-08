// Implements: SPEC-MOD-008 (§ 5.2 capabilities, § 5.3 nominal flow, FA-01 to FA-05, EF-01 to EF-06, EF-08, ERR-01 to ERR-04, RG-01, RG-03, RG-04, ENF-02, § 10)
// The product as a connector server: the standard protocol of the connectors (JSON-RPC 2.0, one message per line on the
// standard streams, or one per message of a persistent connection). Each incoming call goes through the executor of the
// session (hooks, permissions of the automated mode, backups); an error of a call is a result, never a stop (RG-04).

import { PROTOCOL_VERSIONS } from "./stdio-client";

/** The capabilities of § 5.2, in the order they are listed. */
export const SERVE_CAPABILITIES = ["run_agent", "read_file", "find_files", "search_content", "write_file", "edit_file", "run_shell"] as const;
export type ServeCapability = (typeof SERVE_CAPABILITIES)[number];
/** EF-01: reading and `run_agent` by default. */
export const DEFAULT_CAPABILITIES: readonly ServeCapability[] = ["run_agent", "read_file", "find_files", "search_content"];
/** RG-03: writing and running are active only when asked for explicitly at launch. */
export const WRITING_CAPABILITIES: ReadonlySet<string> = new Set(["write_file", "edit_file", "run_shell"]);

export interface CallOutcome {
  readonly text: string;
  readonly isError: boolean;
  readonly structured?: unknown;
}

export interface ServedTool {
  readonly name: ServeCapability;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface ServerHandlers {
  readonly tools: readonly ServedTool[];
  /** A tool of the session, through its executor; the paths are checked beforehand (FA-02). */
  readonly callTool: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<CallOutcome>;
  /** `run_agent`: a complete automated session; `progress` reports its advance (FA-03). */
  readonly runAgent: (input: Record<string, unknown>, signal: AbortSignal, progress: (message: string) => void) => Promise<CallOutcome>;
  readonly maxConcurrency: number;
  /** EF-06: origin, capability, issue. */
  readonly journal: (entry: { readonly client: string; readonly capability: string; readonly outcome: "ok" | "error" | "cancelled"; readonly ms: number }) => void;
  readonly serverInfo: { readonly name: string; readonly version: string };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** FA-04: calls run concurrently, within a bound. */
export class Gate {
  #free: number;
  readonly #waiting: Array<() => void> = [];
  constructor(size: number) {
    this.#free = Math.max(1, size);
  }
  async enter(signal: AbortSignal): Promise<boolean> {
    if (this.#free > 0) {
      this.#free--;
      return true;
    }
    return new Promise((resolve) => {
      const go = () => {
        signal.removeEventListener("abort", stop);
        resolve(true);
      };
      const stop = () => {
        const at = this.#waiting.indexOf(go);
        if (at !== -1) this.#waiting.splice(at, 1);
        resolve(false);
      };
      this.#waiting.push(go);
      signal.addEventListener("abort", stop, { once: true });
    });
  }
  leave(): void {
    const next = this.#waiting.shift();
    if (next) next();
    else this.#free++;
  }
}

/** One connection of a calling client: its own initialization and its own calls. */
export class ConnectorServerSession {
  readonly #h: ServerHandlers;
  readonly #send: (message: Record<string, unknown>) => void;
  readonly #gate: Gate;
  readonly #running = new Map<string, AbortController>();
  #client = "client";
  #closed = false;

  constructor(handlers: ServerHandlers, send: (message: Record<string, unknown>) => void, gate?: Gate) {
    this.#h = handlers;
    this.#send = send;
    this.#gate = gate ?? new Gate(handlers.maxConcurrency);
  }

  /** A message of the client; a malformed one is answered by a protocol error. */
  receive(text: string): void {
    let m: unknown;
    try {
      m = JSON.parse(text);
    } catch {
      return this.#send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    }
    if (!isObject(m) || m["jsonrpc"] !== "2.0" || typeof m["method"] !== "string") {
      if (isObject(m) && "id" in m && !("method" in m)) return; // a response: the server sends no request of its own
      return this.#send({ jsonrpc: "2.0", id: isObject(m) ? (m["id"] ?? null) : null, error: { code: -32600, message: "Invalid request" } });
    }
    const id = m["id"] as string | number | undefined;
    const params = isObject(m["params"]) ? m["params"] : {};
    const reply = (result: unknown) => id !== undefined && this.#send({ jsonrpc: "2.0", id, result });
    switch (m["method"]) {
      case "initialize": {
        const info = isObject(params["clientInfo"]) ? params["clientInfo"] : {};
        if (typeof info["name"] === "string" && info["name"] !== "") this.#client = info["name"];
        const asked = params["protocolVersion"];
        const version = typeof asked === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : PROTOCOL_VERSIONS[0];
        // § 5.3 step 1: the server announces its capabilities.
        return void reply({ protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: this.#h.serverInfo });
      }
      case "ping":
        return void reply({});
      case "tools/list":
        // Step 2, FA-01: the active capabilities only, with their parameters.
        return void reply({ tools: this.#h.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      case "tools/call":
        if (id === undefined) return;
        return void this.#call(id, params);
      case "notifications/cancelled": {
        // FA-03, CA-04: the cancellation of the client stops the call.
        const target = params["requestId"];
        this.#running.get(String(target))?.abort();
        return;
      }
      default:
        if (String(m["method"]).startsWith("notifications/")) return;
        if (id !== undefined) this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${m["method"]}` } });
    }
  }

  async #call(id: string | number, params: Record<string, unknown>): Promise<void> {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const input = isObject(params["arguments"]) ? params["arguments"] : {};
    const meta = isObject(params["_meta"]) ? params["_meta"] : {};
    const token = meta["progressToken"];
    const controller = new AbortController();
    this.#running.set(String(id), controller);
    const started = Date.now();
    const finish = (outcome: CallOutcome | "cancelled") => {
      this.#running.delete(String(id));
      const cancelled = outcome === "cancelled" || controller.signal.aborted;
      this.#h.journal({ client: this.#client, capability: name || "?", outcome: cancelled ? "cancelled" : (outcome as CallOutcome).isError ? "error" : "ok", ms: Date.now() - started });
      // A cancelled call gets no answer (protocol of the connectors).
      if (cancelled || this.#closed) return;
      const o = outcome as CallOutcome;
      this.#send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: o.text }], isError: o.isError, ...(o.structured !== undefined ? { structuredContent: o.structured } : {}) } });
    };
    // FA-01, ERR-01: a capability not listed does not exist for the client.
    if (!this.#h.tools.some((t) => t.name === name)) return finish({ text: "Capability unavailable.", isError: true });
    if (!(await this.#gate.enter(controller.signal))) return finish("cancelled");
    try {
      let step = 0;
      const progress = (message: string) => {
        if (token === undefined || controller.signal.aborted) return;
        this.#send({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: token, progress: ++step, message } });
      };
      const outcome = name === "run_agent" ? await this.#h.runAgent(input, controller.signal, progress) : await this.#h.callTool(name, input, controller.signal);
      finish(outcome);
    } catch (e) {
      finish({ text: `The call failed: ${(e as Error)?.message ?? String(e)}`, isError: true }); // RG-04, ENF-02
    } finally {
      this.#gate.leave();
    }
  }

  /** The connection ends: the running calls stop and free their resources. */
  close(): void {
    this.#closed = true;
    for (const c of this.#running.values()) c.abort();
  }
}

/** One gate for all the connections of a server (FA-04). */
export function sharedGate(size: number): Gate {
  return new Gate(size);
}
