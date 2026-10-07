// Implements: SPEC-MCP-002 (§ 5.1, § 5.3 steps 1 to 4, FA-01, FA-02, EF-01 to EF-03, ERR-01 to ERR-03, RG-01)
// Supports: SPEC-MCP-009 (§ 5.3 step 3 call, ERR-01 cancellation)
// A connector reached through its standard input and output: JSON-RPC messages, one per line (MCP framing for stdio).

import { launchLine, startChild, type Child } from "../platform/process";
import type { PlatformName } from "../platform/system";

/** Protocol versions this client speaks; the first is proposed at initialisation. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const STDERR_LINES = 40;

export interface McpToolInfo {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: { readonly readOnlyHint?: boolean; readonly destructiveHint?: boolean; readonly idempotentHint?: boolean; readonly openWorldHint?: boolean };
}

export interface McpPromptInfo {
  readonly name: string;
  readonly description?: string;
  readonly arguments?: ReadonlyArray<{ readonly name: string; readonly description?: string; readonly required?: boolean }>;
}

export interface McpContent {
  readonly type: string;
  readonly text?: string;
  readonly data?: string;
  readonly mimeType?: string;
  readonly resource?: { readonly uri?: string; readonly text?: string; readonly blob?: string; readonly mimeType?: string };
  readonly uri?: string;
  readonly name?: string;
}

export interface McpCallResult {
  readonly content: readonly McpContent[];
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

/** Error answered by the server (JSON-RPC error object). */
export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/** The connection is gone, or never came up (ERR-01 to ERR-03); `stderr`: last lines of the server, when known. */
export class ConnectionError extends Error {
  stderr?: readonly string[];
}

export class RequestTimeout extends Error {}

export interface StdioOptions {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly platform: PlatformName;
  /** `mcp.connectTimeout` (step 2). */
  readonly connectTimeoutMs: number;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly onNotification?: (method: string, params: unknown) => void;
  /** The connection ended without being closed by the product (FA-01). */
  readonly onLost?: (reason: string) => void;
  /** The session stops while the connection is being set up: the process is stopped (SPEC-MOD-010 EF-06, CA-05). */
  readonly signal?: AbortSignal;
}

interface Pending {
  readonly resolve: (v: unknown) => void;
  readonly reject: (e: Error) => void;
}

export class StdioConnection {
  readonly #o: StdioOptions;
  readonly #child: Child;
  readonly #pending = new Map<number, Pending>();
  readonly #stderr: string[] = [];
  #stderrPartial = "";
  #buffer = "";
  #nextId = 1;
  #closing = false;
  #lost: string | undefined;
  protocolVersion = "";
  serverInfo: { name?: string; version?: string } = {};
  capabilities: Record<string, unknown> = {};

  private constructor(o: StdioOptions) {
    this.#o = o;
    const line = launchLine(o.command, o.args, o.env); // FA-02
    this.#child = startChild(line.file, line.args, {
      cwd: o.cwd,
      env: o.env,
      keepInputOpen: true,
      onData: (chunk) => this.#receive(chunk),
      onErrorData: (chunk) => this.#keepStderr(chunk), // EF-02
    });
    void this.#child.exited.then((code) => this.#end(code === 127 ? "programme introuvable" : `processus terminé (code ${code ?? "signal"})`));
  }

  /** Steps 1 and 2: the process, then the MCP session negotiated within the connection time limit. */
  static async open(o: StdioOptions): Promise<StdioConnection> {
    const c = new StdioConnection(o);
    try {
      if (o.signal?.aborted) throw new ConnectionError(`Connecteur ${o.name} : démarrage annulé.`);
      const init = (await c.request(
        "initialize",
        { protocolVersion: PROTOCOL_VERSIONS[0], capabilities: {}, clientInfo: o.clientInfo },
        { timeoutMs: o.connectTimeoutMs, signal: o.signal },
      )) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; capabilities?: Record<string, unknown> };
      if (!init || typeof init.protocolVersion !== "string" || !(PROTOCOL_VERSIONS as readonly string[]).includes(init.protocolVersion)) {
        throw new ConnectionError(`Connecteur ${o.name} : version du protocole non prise en charge (${String(init?.protocolVersion)}).`);
      }
      c.protocolVersion = init.protocolVersion;
      c.serverInfo = init.serverInfo ?? {};
      c.capabilities = init.capabilities ?? {};
      c.notify("notifications/initialized", {});
      return c;
    } catch (e) {
      // An interruption cancels the initialisation request; the process is then stopped here, once.
      await c.close(0);
      let error: Error = e instanceof Error ? e : new Error(String(e));
      if (e instanceof RequestTimeout) error = new ConnectionError(`Connecteur ${o.name} : pas de réponse à l'initialisation.`); // ERR-02
      else if (e instanceof ConnectionError && c.#lost === "programme introuvable") error = new ConnectionError(`Connecteur ${o.name} : programme introuvable.`); // ERR-01
      else if (!(e instanceof ConnectionError)) error = new ConnectionError(`Connecteur ${o.name} : ${error.message}`);
      (error as ConnectionError).stderr = c.stderrTail();
      throw error;
    }
  }

  get lost(): string | undefined {
    return this.#lost;
  }

  /** Last lines of the standard error of the server (EF-02). */
  stderrTail(lines = 10): string[] {
    const all = this.#stderrPartial ? [...this.#stderr, this.#stderrPartial] : this.#stderr;
    return all.slice(-lines);
  }

  #keepStderr(chunk: Buffer): void {
    const parts = (this.#stderrPartial + chunk.toString("utf8")).split(/\r?\n/);
    this.#stderrPartial = parts.pop() ?? "";
    this.#stderr.push(...parts.filter((l) => l.trim() !== ""));
    if (this.#stderr.length > STDERR_LINES) this.#stderr.splice(0, this.#stderr.length - STDERR_LINES);
  }

  /** Step 3: one JSON-RPC message per line; anything else closes the connection (ERR-03). */
  #receive(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    let nl: number;
    while ((nl = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, nl).trim();
      this.#buffer = this.#buffer.slice(nl + 1);
      if (line === "") continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg !== "object" || msg === null || msg["jsonrpc"] !== "2.0") throw new Error("not JSON-RPC");
      } catch {
        this.#end("réponse invalide");
        void this.#child.killTree(1_000);
        return;
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: Record<string, unknown>): void {
    const id = msg["id"];
    if (typeof msg["method"] === "string") {
      if (id === undefined) {
        this.#o.onNotification?.(msg["method"], msg["params"]);
        return;
      }
      // Requests from the server: only `ping` is answered; this client declares no other capability.
      if (msg["method"] === "ping") this.#send({ jsonrpc: "2.0", id, result: {} });
      else this.#send({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
      return;
    }
    const pending = typeof id === "number" ? this.#pending.get(id) : undefined;
    if (!pending) return;
    this.#pending.delete(id as number);
    const error = msg["error"] as { message?: string; code?: number } | undefined;
    if (error) pending.reject(new McpError(String(error.message ?? "error"), error.code));
    else pending.resolve(msg["result"]);
  }

  #send(message: Record<string, unknown>): void {
    this.#child.input?.write(`${JSON.stringify(message)}\n`);
  }

  notify(method: string, params: unknown): void {
    if (this.#lost === undefined) this.#send({ jsonrpc: "2.0", method, params });
  }

  /** A request; on its time limit or abort, the server is told that it is cancelled (SPEC-MCP-009 ERR-01). */
  request(method: string, params: unknown, o: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    if (this.#lost !== undefined) return Promise.reject(new ConnectionError(`Connecteur ${this.#o.name} déconnecté : ${this.#lost}.`));
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cancel = (error: Error) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
        if (method !== "initialize") this.notify("notifications/cancelled", { requestId: id, reason: error.message });
        reject(error);
      };
      const onAbort = () => cancel(new Error("interrompu"));
      this.#pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          o.signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
      });
      if (o.timeoutMs !== undefined) timer = setTimeout(() => cancel(new RequestTimeout(`délai de ${Math.round(o.timeoutMs! / 1000)} s dépassé`)), o.timeoutMs);
      if (o.signal?.aborted) onAbort();
      else o.signal?.addEventListener("abort", onAbort, { once: true });
      this.#send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** `tools/list`, every page. */
  async listTools(timeoutMs: number): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {}, { timeoutMs })) as { tools?: McpToolInfo[]; nextCursor?: string };
      tools.push(...(Array.isArray(r?.tools) ? r.tools : []));
      cursor = typeof r?.nextCursor === "string" && r.nextCursor !== "" ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /** `prompts/list`, every page (SPEC-MCP-011). */
  async listPrompts(timeoutMs: number): Promise<McpPromptInfo[]> {
    const prompts: McpPromptInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = (await this.request("prompts/list", cursor ? { cursor } : {}, { timeoutMs })) as { prompts?: McpPromptInfo[]; nextCursor?: string };
      prompts.push(...(Array.isArray(r?.prompts) ? r.prompts.filter((p) => typeof p?.name === "string") : []));
      cursor = typeof r?.nextCursor === "string" && r.nextCursor !== "" ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return prompts;
  }

  /** `prompts/get`: the messages of a prompt for its arguments. */
  async getPrompt(name: string, args: Readonly<Record<string, string>>, o: { timeoutMs: number; signal?: AbortSignal }): Promise<{ messages: ReadonlyArray<{ role?: string; content?: McpContent | readonly McpContent[] }> }> {
    const r = (await this.request("prompts/get", { name, arguments: args }, o)) as { messages?: Array<{ role?: string; content?: McpContent }> };
    return { messages: Array.isArray(r?.messages) ? r.messages : [] };
  }

  async callTool(name: string, args: unknown, o: { timeoutMs: number; signal?: AbortSignal }): Promise<McpCallResult> {
    const r = (await this.request("tools/call", { name, arguments: args ?? {} }, o)) as McpCallResult;
    return { content: Array.isArray(r?.content) ? r.content : [], structuredContent: r?.structuredContent, isError: r?.isError === true };
  }

  #end(reason: string): void {
    if (this.#lost !== undefined) return;
    this.#lost = reason;
    for (const p of this.#pending.values()) p.reject(new ConnectionError(`Connecteur ${this.#o.name} déconnecté : ${reason}.`));
    this.#pending.clear();
    if (!this.#closing) this.#o.onLost?.(reason); // FA-01
  }

  /** Step 4: input closed, a grace period, then the whole process tree stopped (EF-03). */
  async close(graceMs = 2_000): Promise<void> {
    this.#closing = true;
    this.#child.input?.end();
    const ended = await Promise.race([this.#child.exited.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), graceMs))]);
    if (!ended) await this.#child.killTree(1_000);
    this.#end("fermé");
  }
}
