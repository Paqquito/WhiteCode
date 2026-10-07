// Implements: SPEC-MCP-022 (§ 5.1, § 5.3 steps 1 to 4, FA-02, EF-01 to EF-03, ERR-01), SPEC-MCP-001 (§ 5.3 steps 4 and 5, FA-02, EF-02, EF-03),
//             SPEC-MCP-009 (§ 5.2 list changes, FA-01, FA-02, ERR-02), SPEC-MCP-020 (§ 5.3 step 3), SPEC-MCP-002 (ENF-01 launches in parallel),
//             SPEC-MCP-011 (§ 5.3 step 2, EF-01, EF-03, ERR-01)
// The connections of a session: started in parallel without blocking, published to the tool registry once connected,
// reconnected with an exponential delay, closed at the end.

import { isAbsolute, resolve } from "node:path";
import type { PlatformName } from "../platform/system";
import type { Tool } from "../tools/types";
import { expand, type ConnectorDeclaration } from "./declarations";
import { ConnectionError, StdioConnection, type McpPromptInfo, type McpToolInfo } from "./stdio-client";
import { connectorTool, qualifiedToolName, schemaProblem } from "./tools";

export type ConnectorState = "pending" | "connecting" | "connected" | "error" | "unavailable";

export interface ConnectorStatus {
  readonly name: string;
  readonly scope: string;
  readonly source: string;
  readonly state: ConnectorState;
  readonly error?: string;
  /** Last lines of the standard error of a `stdio` server (SPEC-MCP-002 EF-02). */
  readonly stderr: readonly string[];
  readonly tools: number;
}

export interface ConnectorManagerOptions {
  readonly connectors: readonly ConnectorDeclaration[];
  readonly projectRoot: string;
  readonly platform: PlatformName;
  /** Environment of a server process: the product environment without its own variables nor secrets, plus `env` (RG-01). */
  readonly environment: (declared: Readonly<Record<string, string>>) => Record<string, string>;
  /** Variables for `${VAR}` (EF-02). */
  readonly variables: Readonly<Record<string, string | undefined>>;
  readonly connectTimeoutMs: number;
  readonly toolTimeoutMs: number;
  readonly maxParallel: number;
  readonly maxReconnects: number;
  readonly descriptionMax: number;
  readonly outputInlineLimit: number;
  readonly clientInfo: { readonly name: string; readonly version: string };
  readonly estimateTokens: (text: string) => number;
  readonly store: (key: string, text: string) => string;
  /** Messages for the user. */
  readonly report: (message: string) => void;
  /** The published tools changed: a connection, a list change, a loss (FA-02). */
  readonly changed: (event: ConnectorEvent) => void;
  /** Delay before the reconnection `attempt` (1-based): 1 s doubling up to 5 min by default (step 3). */
  readonly backoffMs?: (attempt: number) => number;
}

export type ConnectorEvent =
  | { readonly kind: "connected"; readonly name: string; readonly tools: readonly string[] }
  | { readonly kind: "tools_changed"; readonly name: string; readonly added: readonly string[]; readonly removed: readonly string[] }
  | { readonly kind: "lost"; readonly name: string; readonly reason: string }
  | { readonly kind: "failed"; readonly name: string; readonly reason: string };

interface Entry {
  readonly d: ConnectorDeclaration;
  state: ConnectorState;
  error?: string;
  conn?: StdioConnection;
  /** Tools of the server, by qualified name; kept after a loss so that the definitions already sent stay valid. */
  tools: Map<string, Tool<never>>;
  /** Names currently published by the server. */
  live: Set<string>;
  /** Prompts of the server, exposed as commands (SPEC-MCP-011). */
  prompts: readonly McpPromptInfo[];
  attempts: number;
  /** Last lines of the standard error, kept after a loss (SPEC-MCP-002 EF-02, CA-03). */
  stderr: readonly string[];
  timer?: ReturnType<typeof setTimeout>;
  overflows: number;
  settled: Promise<void>;
  settle: () => void;
}

const defaultBackoff = (attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 300_000);

export class ConnectorManager {
  readonly #o: ConnectorManagerOptions;
  readonly #entries = new Map<string, Entry>();
  #active = 0;
  readonly #queue: Array<() => void> = [];
  #closed = false;
  /** Aborted by `close`: the connections being set up are stopped too (SPEC-MOD-010 CA-05). */
  readonly #shutdown = new AbortController();

  constructor(o: ConnectorManagerOptions) {
    this.#o = o;
    for (const d of o.connectors) {
      let settle!: () => void;
      const settled = new Promise<void>((r) => (settle = r));
      this.#entries.set(d.name, { d, state: "pending", tools: new Map(), live: new Set(), prompts: [], attempts: 0, stderr: [], overflows: 0, settled, settle });
    }
  }

  /** Step 1: every connection in parallel, at most `mcp.maxParallelConnects` at once; never awaited (EF-01). */
  start(): void {
    for (const e of this.#entries.values()) this.#schedule(e);
  }

  /** FA-02 (`--wait-for-mcp`): waits until every connector is connected or failed, within `timeoutMs`. */
  async waitAll(timeoutMs: number, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    // SPEC-MOD-010 EF-06: an interruption ends the wait at once.
    const aborted = new Promise<void>((r) => (signal?.aborted ? r() : signal?.addEventListener("abort", () => r(), { once: true })));
    await Promise.race([Promise.all([...this.#entries.values()].map((e) => e.settled)), new Promise((r) => (timer = setTimeout(r, timeoutMs))), aborted]);
    clearTimeout(timer);
  }

  status(): ConnectorStatus[] {
    return [...this.#entries.values()].map((e) => ({ name: e.d.name, scope: e.d.scope, source: e.d.source, state: e.state, error: e.error, stderr: e.conn?.stderrTail() ?? e.stderr, tools: e.live.size }));
  }

  /** Every tool published so far, connected or not (a call to a disconnected one fails explicitly, FA-01). */
  tools(): Tool<never>[] {
    return [...this.#entries.values()].flatMap((e) => [...e.tools.values()]);
  }

  #schedule(e: Entry): void {
    const run = () => {
      this.#active++;
      void this.#connect(e).finally(() => {
        this.#active--;
        this.#queue.shift()?.();
      });
    };
    if (this.#active >= this.#o.maxParallel) this.#queue.push(run);
    else run();
  }

  /** Step 4 of SPEC-MCP-001: variables expanded at connection; an undefined one without default is a configuration error (FA-02). */
  #launch(e: Entry): { command: string; args: string[]; env: Record<string, string>; cwd: string } | string {
    const missing = new Set<string>();
    const x = (t: string) => expand(t, this.#o.variables, missing);
    const command = x(e.d.command ?? "");
    const args = e.d.args.map(x);
    const env = Object.fromEntries(Object.entries(e.d.env).map(([k, v]) => [k, x(v)]));
    const cwd = e.d.cwd ? x(e.d.cwd) : this.#o.projectRoot;
    if (missing.size > 0) return `erreur de configuration : variable${missing.size > 1 ? "s" : ""} ${[...missing].join(", ")} non définie${missing.size > 1 ? "s" : ""}`;
    return { command, args, env, cwd: isAbsolute(cwd) ? cwd : resolve(this.#o.projectRoot, cwd) };
  }

  async #connect(e: Entry): Promise<void> {
    if (this.#closed) return;
    if (e.d.transport !== "stdio") return this.#fail(e, `transport ${e.d.transport} non disponible dans cette version`, false);
    const launch = this.#launch(e);
    if (typeof launch === "string") return this.#fail(e, launch, false);
    e.state = "connecting";
    try {
      const conn = await StdioConnection.open({
        name: e.d.name,
        ...launch,
        env: this.#o.environment(launch.env),
        platform: this.#o.platform,
        connectTimeoutMs: this.#o.connectTimeoutMs,
        clientInfo: this.#o.clientInfo,
        onNotification: (method) => {
          if (method === "notifications/tools/list_changed") void this.#refresh(e);
          if (method === "notifications/prompts/list_changed") void this.#refreshPrompts(e); // EF-03 of SPEC-MCP-011
        },
        onLost: (reason) => this.#lost(e, reason),
        signal: this.#shutdown.signal,
      });
      if (this.#closed) return void (await conn.close(0));
      e.conn = conn;
      const published = await this.#publish(e, await conn.listTools(this.#o.connectTimeoutMs));
      if (conn.capabilities["prompts"]) e.prompts = await conn.listPrompts(this.#o.connectTimeoutMs).catch(() => []);
      e.state = "connected";
      e.error = undefined;
      e.attempts = 0;
      e.settle();
      this.#o.changed({ kind: "connected", name: e.d.name, tools: published });
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(new RegExp(`^Connecteur ${e.d.name} : `), "") : String(err);
      if (err instanceof ConnectionError && err.stderr) e.stderr = err.stderr;
      await e.conn?.close(0);
      e.conn = undefined;
      this.#fail(e, message, err instanceof ConnectionError && !/programme introuvable|version du protocole/.test(message));
    }
  }

  /** The tools of the server as registry tools; an invalid schema leaves its tool out (ERR-02). Returns the new names. */
  async #publish(e: Entry, list: readonly McpToolInfo[]): Promise<string[]> {
    const taken = new Set([...this.#entries.values()].flatMap((x) => (x === e ? [] : [...x.tools.keys()])));
    const live = new Set<string>();
    const added: string[] = [];
    for (const info of [...list].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (typeof info?.name !== "string") continue;
      const problem = schemaProblem(info.inputSchema);
      if (problem) {
        this.#o.report(`avertissement : outil ${info.name} du connecteur ${e.d.name} non exposé : ${problem}.`);
        continue;
      }
      const existing = [...e.tools.entries()].find(([, t]) => (t as Tool<never> & { origin?: string }).origin === info.name)?.[0];
      const qualified = existing ?? qualifiedToolName(e.d.name, info.name, taken);
      taken.add(qualified);
      live.add(qualified);
      if (!e.tools.has(qualified) || JSON.stringify(e.tools.get(qualified)!.inputSchema) !== JSON.stringify(info.inputSchema)) {
        if (!e.tools.has(qualified)) added.push(qualified);
        e.tools.set(qualified, Object.assign(this.#tool(e, info, qualified), { origin: info.name }));
      }
    }
    e.live = live;
    return added;
  }

  #tool(e: Entry, info: McpToolInfo, qualified: string): Tool<never> {
    return connectorTool(info, qualified, {
      server: e.d.name,
      descriptionMax: this.#o.descriptionMax,
      timeoutMs: this.#o.toolTimeoutMs,
      outputLimit: e.d.maxOutputTokens ?? this.#o.outputInlineLimit,
      estimateTokens: this.#o.estimateTokens,
      store: this.#o.store,
      call: (name, args, o) => {
        if (!e.live.has(qualified)) return Promise.reject(new Error(`the tool ${info.name} is no longer published by the server.`));
        if (!e.conn || e.state !== "connected") return Promise.reject(new Error(`disconnected${e.error ? ` (${e.error})` : ""}; reconnection in progress.`));
        return e.conn.callTool(name, args, o);
      },
      overflowed: () => {
        // SPEC-MCP-020 step 3: beyond 3 large results in the session, the user is told.
        if (++e.overflows === 4) this.#o.report(`avertissement : le connecteur ${e.d.name} a dépassé plus de 3 fois le seuil des sorties volumineuses (mcp.outputInlineLimit) ; ses résultats sont enregistrés dans des fichiers.`);
      },
    });
  }

  /** FA-02 of SPEC-MCP-009: the list changed on the server. */
  async #refresh(e: Entry): Promise<void> {
    if (!e.conn || this.#closed) return;
    try {
      const before = new Set(e.live);
      const added = await this.#publish(e, await e.conn.listTools(this.#o.connectTimeoutMs));
      const removed = [...before].filter((n) => !e.live.has(n));
      const revived = [...e.live].filter((n) => !before.has(n) && !added.includes(n));
      if (added.length + removed.length + revived.length > 0) this.#o.changed({ kind: "tools_changed", name: e.d.name, added: [...added, ...revived], removed });
    } catch (err) {
      this.#o.report(`avertissement : connecteur ${e.d.name} : liste des outils illisible (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  async #refreshPrompts(e: Entry): Promise<void> {
    if (!e.conn || this.#closed) return;
    try {
      e.prompts = await e.conn.listPrompts(this.#o.connectTimeoutMs);
    } catch (err) {
      this.#o.report(`avertissement : connecteur ${e.d.name} : liste des prompts illisible (${err instanceof Error ? err.message : String(err)}).`);
    }
  }

  /**
   * SPEC-MCP-011 EF-01: the prompts of every connector, as commands `cnx_<server>_<prompt>`; a prompt of a connector that
   * is not connected stays listed, unavailable (ERR-01).
   */
  prompts(): Array<{ readonly server: string; readonly command: string; readonly prompt: McpPromptInfo; readonly available: boolean }> {
    const taken = new Set<string>();
    const out: Array<{ server: string; command: string; prompt: McpPromptInfo; available: boolean }> = [];
    for (const e of this.#entries.values())
      for (const p of [...e.prompts].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const command = qualifiedToolName(e.d.name, p.name, taken);
        taken.add(command);
        out.push({ server: e.d.name, command, prompt: p, available: e.state === "connected" && e.conn !== undefined });
      }
    return out;
  }

  /** § 5.3 step 2: the content of a prompt, as the text of a message of the user. */
  async getPrompt(server: string, name: string, args: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string> {
    const e = this.#entries.get(server);
    if (!e?.conn || e.state !== "connected") throw new Error(`Connecteur ${server} indisponible.`); // ERR-01
    const r = await e.conn.getPrompt(name, args, { timeoutMs: this.#o.toolTimeoutMs, signal });
    const parts: string[] = [];
    for (const m of r.messages) {
      const contents = Array.isArray(m.content) ? m.content : m.content ? [m.content] : [];
      for (const c of contents) {
        if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
        else if (c.type === "resource" && typeof c.resource?.text === "string") parts.push(c.resource.text);
      }
    }
    return parts.join("\n\n");
  }

  /** FA-01 of SPEC-MCP-002, step 3: lost connection, reconnection with an exponential delay, bounded (EF-03). */
  #lost(e: Entry, reason: string): void {
    if (this.#closed) return;
    e.stderr = e.conn?.stderrTail() ?? [];
    e.conn = undefined;
    const last = e.stderr.slice(-5);
    this.#o.report(`avertissement : connecteur ${e.d.name} : connexion perdue (${reason}) ; reconnexion automatique.${last.length ? ` Dernières lignes d'erreur : ${last.join(" | ")}` : ""}`); // CA-03
    this.#o.changed({ kind: "lost", name: e.d.name, reason });
    this.#fail(e, `connexion perdue : ${reason}`, true);
  }

  #fail(e: Entry, reason: string, retry: boolean): void {
    e.state = "error";
    e.error = reason;
    const last = (e.conn?.stderrTail() ?? e.stderr).slice(-5);
    if (!retry || e.attempts >= this.#o.maxReconnects) {
      if (retry) {
        e.state = "unavailable";
        this.#o.report(`Connecteur ${e.d.name} indisponible : reconnexion depuis /connectors.`); // ERR-01
      } else this.#o.report(`avertissement : connecteur ${e.d.name} : ${reason}.${last.length ? ` Dernières lignes d'erreur : ${last.join(" | ")}` : ""}`);
      e.settle();
      this.#o.changed({ kind: "failed", name: e.d.name, reason });
      return;
    }
    e.attempts++;
    if (e.attempts === 1) e.settle(); // a first failure ends the wait of `--wait-for-mcp`
    const delay = (this.#o.backoffMs ?? defaultBackoff)(e.attempts);
    e.timer = setTimeout(() => this.#schedule(e), delay);
  }

  /** Step 4: every connection closed, every server process stopped (SPEC-MCP-002 EF-03). */
  async close(): Promise<void> {
    this.#closed = true;
    this.#shutdown.abort();
    this.#queue.length = 0;
    await Promise.all(
      [...this.#entries.values()].map(async (e) => {
        clearTimeout(e.timer);
        await e.conn?.close();
        e.conn = undefined;
      }),
    );
  }
}
