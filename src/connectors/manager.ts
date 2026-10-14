// Implements: SPEC-MCP-022 (§ 5.1, § 5.3 steps 1 to 4, FA-02, EF-01 to EF-03, ERR-01), SPEC-MCP-001 (§ 5.3 steps 4 and 5, FA-02, EF-02, EF-03),
//             SPEC-MCP-009 (§ 5.2 list changes, FA-01, FA-02, ERR-02), SPEC-MCP-020 (§ 5.3 step 3), SPEC-MCP-002 (ENF-01 launches in parallel),
//             SPEC-MCP-011 (§ 5.3 step 2, EF-01, EF-03, ERR-01)
// The connections of a session: started in parallel without blocking, published to the tool registry once connected,
// reconnected with an exponential delay, closed at the end.
// Supports: SPEC-MCP-003 (CA-01/02/03, HTTP and SSE connections), gap E-146.

import { isAbsolute, resolve } from "node:path";
import type { PlatformName } from "../platform/system";
import type { Tool } from "../tools/types";
import { expand, type ConnectorDeclaration } from "./declarations";
import { ConnectionError, StdioConnection, type McpPromptInfo, type McpToolInfo } from "./stdio-client";
import { AuthenticationRequired, HttpConnection } from "./http-client";
import { connectorTool, qualifiedToolName, schemaProblem } from "./tools";
import { ConnectorHeaders } from "./headers";
import type { ShellChoice } from "../hooks/command";
import type { ConnectorOAuth, OAuthUi } from "./oauth";
import { VaultUnavailable } from "../platform/credential-vault";
// Supports: SPEC-MCP-006, SPEC-MCP-008, SPEC-MCP-022 (CA-03), SPEC-OUT-029; gap E-155.

export type ConnectorState = "pending" | "connecting" | "connected" | "error" | "unavailable" | "auth_required" | "disabled";

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
  /** Shared proxy, authorities and client certificate configuration. */
  readonly fetch?: typeof fetch;
  readonly headerShell?: ShellChoice;
  readonly headersTtlMs?: number;
  readonly headersTimeoutMs?: number;
  readonly oauth?: (declaration: ConnectorDeclaration, url: string) => ConnectorOAuth;
  readonly authUi?: OAuthUi;
  readonly disabledConnectors?: readonly string[];
  readonly elicitation?: (server: string, params: unknown, signal: AbortSignal) => Promise<unknown>;
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
  readonly richOutputMaxLines?: number;
  readonly redact?: (text: string) => string;
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
  | { readonly kind: "resources_changed"; readonly name: string }
  | { readonly kind: "connected"; readonly name: string; readonly tools: readonly string[] }
  | { readonly kind: "tools_changed"; readonly name: string; readonly added: readonly string[]; readonly removed: readonly string[] }
  | { readonly kind: "lost"; readonly name: string; readonly reason: string }
  | { readonly kind: "failed"; readonly name: string; readonly reason: string };

interface Entry {
  readonly d: ConnectorDeclaration;
  state: ConnectorState;
  error?: string;
  conn?: Pick<StdioConnection, "listTools" | "listPrompts" | "getPrompt" | "callTool" | "request" | "close" | "capabilities" | "stderrTail" | "lost">;
  connecting?: Promise<void>;
  reconnecting?: Promise<void>;
  connectionRevision: number;
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
  oauth?: ConnectorOAuth;
  headers?: ConnectorHeaders;
}

const defaultBackoff = (attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 300_000);

export class ConnectorManager {
  readonly #resourceCache = new Map<string, Array<{ server: string; uri: string; name: string; mimeType?: string; description?: string }>>();
  readonly #o: ConnectorManagerOptions;
  readonly #entries = new Map<string, Entry>();
  #active = 0;
  readonly #queue: Array<() => void> = [];
  readonly #connecting = new Set<Promise<void>>();
  readonly #disconnecting = new Set<Promise<void>>();
  #closed = false;
  /** Aborted by `close`: the connections being set up are stopped too (SPEC-MOD-010 CA-05). */
  readonly #shutdown = new AbortController();

  constructor(o: ConnectorManagerOptions) {
    this.#o = o;
    for (const d of o.connectors) {
      let settle!: () => void;
      const settled = new Promise<void>((r) => (settle = r));
      this.#entries.set(d.name, { d, state: o.disabledConnectors?.includes(d.name) && !d.required ? "disabled" : "pending", connectionRevision: 0, tools: new Map(), live: new Set(), prompts: [], attempts: 0, stderr: [], overflows: 0, settled, settle });
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

  /** SPEC-CMD-041 § 5.3 step 3: a new connection, the attempts counted afresh; the state once it is settled. */
  async reconnect(name: string): Promise<ConnectorStatus | undefined> {
    const e = this.#entries.get(name);
    if (!e || this.#closed || e.state === "disabled") return undefined;
    const task = e.reconnecting ?? (async () => {
      clearTimeout(e.timer);
      // Join an initialization already in progress instead of starting another server.
      if (e.connecting) { await e.connecting; return; }
      await e.conn?.close(0);
      e.conn = undefined;
      if (this.#closed) return;
      e.attempts = this.#o.maxReconnects; // a failure of this explicit attempt is final
      e.settled = new Promise<void>((r) => (e.settle = r));
      await this.#trackedConnect(e);
    })();
    e.reconnecting = task;
    try { await task; }
    finally { if (e.reconnecting === task) e.reconnecting = undefined; }
    return this.status().find((s) => s.name === name);
  }

  /** Every tool published so far, connected or not (a call to a disconnected one fails explicitly, FA-01). */
  tools(): Tool<never>[] {
    return [...this.#entries.values()].filter(e => e.state !== "disabled" && e.state !== "auth_required").flatMap((e) => [...e.tools.values()]);
  }

  /** SPEC-PER-028: raw bounded control response; ordinary tool presentation never rewrites a decision. */
  async controlCall(qualified: string, args: unknown, options: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<unknown> {
    options.signal.throwIfAborted();
    const entry = [...this.#entries.values()].find(candidate => candidate.state === "connected" && candidate.live.has(qualified));
    const origin = (entry?.tools.get(qualified) as (Tool<never> & { readonly origin?: string }) | undefined)?.origin;
    if (!entry?.conn || !origin) throw new Error("The designated control tool is unavailable.");
    const result = await entry.conn.callTool(origin, args, { ...options, timeoutMs: Math.min(options.timeoutMs, entry.d.timeoutMs ?? this.#o.toolTimeoutMs) });
    options.signal.throwIfAborted();
    if (result.isError || result.content.some(part => part.type !== "text")) throw new Error("The control component returned an invalid result.");
    const value = result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : result.content.map(part => part.text ?? "").join("\n");
    if (Buffer.byteLength(value) > 65536) throw new Error("The control component response exceeds 64 KiB.");
    return JSON.parse(value) as unknown;
  }

  canSignIn(): readonly string[] { return this.#o.authUi ? [...this.#entries.values()].filter(e => e.state === "auth_required" && e.oauth).map(e => e.d.name) : []; }
  async signIn(name: string, signal: AbortSignal): Promise<ConnectorStatus> {
    const e = this.#entries.get(name);
    if (!e?.oauth || !this.#o.authUi || e.state !== "auth_required") throw new Error("Authentification indisponible pour ce connecteur.");
    await e.oauth.signIn(this.#o.authUi, AbortSignal.any([signal, this.#shutdown.signal]));
    const status = await this.reconnect(name); if (!status || status.state !== "connected") throw new Error("Autorisation reçue, mais connexion au connecteur impossible."); return status;
  }
  async signOut(name: string, signal: AbortSignal): Promise<void> {
    const e = this.#entries.get(name); if (!e?.oauth) throw new Error("Connecteur sans parcours OAuth.");
    await e.oauth.signOut(signal); await e.conn?.close(0); e.conn = undefined; e.live.clear(); this.#authentication(e);
  }
  async enable(name: string, enabled: boolean): Promise<void> {
    const e = this.#entries.get(name); if (!e) throw new Error("Connecteur inconnu."); if (!enabled && e.d.required) throw new Error("Connecteur indispensable imposé par votre organisation.");
    clearTimeout(e.timer);
    if (!enabled) { e.state = "disabled"; e.live.clear(); e.prompts = []; e.settle(); await e.conn?.close(0); e.conn = undefined; }
    else { e.state = "pending"; await this.reconnect(name); }
    this.#o.changed({ kind: "tools_changed", name, added: enabled ? [...e.live] : [], removed: enabled ? [] : [...e.tools.keys()] });
  }

  #schedule(e: Entry): void {
    if (e.state === "disabled") { e.settle(); return; }
    const revision = e.connectionRevision;
    const run = () => {
      // A manual attempt may have superseded this queued job, whether it succeeded or failed.
      if (this.#closed || e.connectionRevision !== revision) { this.#queue.shift()?.(); return; }
      this.#active++;
      void this.#trackedConnect(e).finally(() => {
        this.#active--;
        this.#queue.shift()?.();
      });
    };
    if (this.#active >= this.#o.maxParallel) this.#queue.push(run);
    else run();
  }

  #trackedConnect(e: Entry): Promise<void> {
    if (e.connecting) return e.connecting;
    e.connectionRevision++;
    const task = this.#connect(e);
    e.connecting = task;
    this.#connecting.add(task);
    const finished = () => {
      this.#connecting.delete(task);
      if (e.connecting === task) e.connecting = undefined;
    };
    void task.then(finished, finished);
    return task;
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
    if (this.#closed || e.state === "disabled") return;
    if (!["stdio", "http", "sse"].includes(e.d.transport)) return this.#fail(e, `transport ${e.d.transport} non disponible dans cette version`, false);
    const launch = this.#launch(e);
    if (typeof launch === "string") return this.#fail(e, launch, false);
    e.state = "connecting";
    try {
      const common = {
        name: e.d.name,
        connectTimeoutMs: e.d.timeoutMs ?? this.#o.connectTimeoutMs,
        clientInfo: this.#o.clientInfo,
        onRequest: (_method: string, params: unknown, signal: AbortSignal) => this.#o.elicitation?.(e.d.name, params, AbortSignal.any([signal, this.#shutdown.signal])) ?? Promise.resolve({ action: "cancel" }),
        onNotification: (method: string) => {
          if (method === "notifications/tools/list_changed") void this.#refresh(e);
          if (method === "notifications/prompts/list_changed") void this.#refreshPrompts(e);
          if (method === "notifications/resources/list_changed") void this.resources(e.d.name, this.#shutdown.signal).then(() => this.#o.changed({ kind: "resources_changed", name: e.d.name })).catch(() => this.#o.report("avertissement : liste de ressources indisponible."));
        },
        onLost: (reason: string) => { if (e.state === "connected") this.#lost(e, reason); },
        signal: this.#shutdown.signal,
      };
      const missing = new Set<string>(), url = expand(e.d.url ?? "", this.#o.variables, missing);
      const headers = Object.fromEntries(Object.entries(e.d.headers).map(([k, v]) => [k, expand(v, this.#o.variables, missing)]));
      if (missing.size > 0) return this.#fail(e, `erreur de configuration : variable ${[...missing].join(", ")} non définie`, false);
      if (e.d.transport !== "stdio") {
        e.oauth ??= this.#o.oauth?.(e.d, url);
        if (e.d.headersCommand && !e.headers) {
          if (!this.#o.headerShell) throw new ConnectionError("Programme d'en-têtes : aucun shell disponible.");
          e.headers = new ConnectorHeaders({ name: e.d.name, url, command: e.d.headersCommand, cwd: launch.cwd, env: { ...this.#o.environment(launch.env), MCP_CONNECTOR_NAME: e.d.name, MCP_CONNECTOR_URL: url }, shell: this.#o.headerShell, platform: this.#o.platform, ttlMs: this.#o.headersTtlMs ?? 900000, timeoutMs: this.#o.headersTimeoutMs ?? 10000 });
        }
      }
      const getHeaders = e.oauth || e.headers ? async (signal: AbortSignal, force: boolean) => {
        const dynamic = e.headers ? await e.headers.get(signal, force) : undefined;
        let authorization: string | undefined;
        try { authorization = await e.oauth?.authorization(signal, force); } catch (cause) { if (!(cause instanceof VaultUnavailable)) throw new AuthenticationRequired("Authentification requise (/connectors)."); }
        return dynamic || authorization ? { ...dynamic, ...(authorization ? { Authorization: authorization } : {}) } : undefined;
      } : undefined;
      const conn = e.d.transport === "stdio" ? await StdioConnection.open({
        ...launch,
        env: this.#o.environment(launch.env),
        platform: this.#o.platform,
        ...common,
      }) : await HttpConnection.open({ ...common, url, headers, getHeaders, transport: e.d.transport as "http" | "sse", fetch: this.#o.fetch });
      if (this.#closed || (e.state as ConnectorState) === "disabled") return void (await conn.close(0));
      e.conn = conn;
      const list = await conn.listTools(common.connectTimeoutMs);
      if (this.#closed || (e.state as ConnectorState) === "disabled" || e.conn !== conn) return void (await conn.close(0));
      const published = await this.#publish(e, list);
      if (conn.capabilities["prompts"]) e.prompts = await conn.listPrompts(common.connectTimeoutMs).catch(() => []);
      if (this.#closed || (e.state as ConnectorState) === "disabled" || e.conn !== conn) { e.prompts = []; return void (await conn.close(0)); }
      if (conn.lost === "authentification requise") throw new AuthenticationRequired("Authentification requise (/connectors).");
      if (conn.lost) throw new ConnectionError("Connexion perdue pendant l'initialisation.");
      e.state = "connected";
      e.error = undefined;
      e.attempts = 0;
      if (conn.capabilities["resources"]) await this.resources(e.d.name, this.#shutdown.signal).catch(() => this.#o.report("avertissement : liste de ressources indisponible."));
      if (this.#closed || (e.state as ConnectorState) === "disabled" || e.conn !== conn) return void (await conn.close(0));
      e.settle();
      this.#o.changed({ kind: "connected", name: e.d.name, tools: published });
    } catch (err) {
      const message = err instanceof Error ? err.message.replace(new RegExp(`^Connecteur ${e.d.name} : `), "") : String(err);
      if (err instanceof ConnectionError && err.stderr) e.stderr = err.stderr;
      await e.conn?.close(0);
      e.conn = undefined;
      if (this.#closed && /interrompu|démarrage annulé/.test(message)) { e.settle(); return; }
      if ((e.state as ConnectorState) === "disabled") { e.settle(); return; }
      if (err instanceof AuthenticationRequired) { try { e.oauth?.challenge(err.metadataUrl); } catch {} return this.#authentication(e); }
      this.#fail(e, message, !this.#closed && err instanceof ConnectionError && !/programme introuvable|version du protocole|URL non sécurisée|autre origine|En-têtes.*invalides/.test(message));
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
      richOutputMaxLines: this.#o.richOutputMaxLines,
      redact: this.#o.redact,
      timeoutMs: e.d.timeoutMs ?? this.#o.toolTimeoutMs,
      outputLimit: e.d.maxOutputTokens ?? this.#o.outputInlineLimit,
      estimateTokens: this.#o.estimateTokens,
      store: this.#o.store,
      call: (name, args, o) => {
        if (!e.live.has(qualified)) return Promise.reject(new Error(`the tool ${info.name} is no longer published by the server.`));
        if (!e.conn || e.state !== "connected") return Promise.reject(new Error("disconnected; reconnect or authenticate the connector before using its tools."));
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

  // Supports: SPEC-OUT-028 (CA-01/02, bounded untrusted resources), gap E-151.
  cachedResources(): Array<{ server: string; uri: string; name: string; mimeType?: string; description?: string }> {
    return [...this.#resourceCache].flatMap(([name, rows]) => this.#entries.get(name)?.state === "connected" ? rows.map(row => ({ ...row })) : []);
  }
  async resources(server?: string, signal?: AbortSignal): Promise<Array<{ server: string; uri: string; name: string; mimeType?: string; description?: string }>> {
    if (server !== undefined && !this.#entries.has(server)) throw new Error(`Connecteur ${server} inconnu.`);
    const controller = new AbortController(), abort = () => controller.abort();
    if (signal?.aborted) controller.abort(); else signal?.addEventListener("abort", abort, { once: true });
    const entries = [...this.#entries.values()].filter(entry => (server === undefined || entry.d.name === server) && entry.state === "connected" && entry.conn?.capabilities["resources"] !== undefined);
    try {
    const groups = await Promise.all(entries.map(async entry => {
      const connection = entry.conn!; let cursor: string | undefined; const seen = new Set<string>();
      const rows: Array<{ server: string; uri: string; name: string; mimeType?: string; description?: string }> = [];
      for (let page = 0; page < 100; page++) {
        const response = await connection.request("resources/list", cursor ? { cursor } : {}, { timeoutMs: this.#o.toolTimeoutMs, signal: controller.signal }) as { resources?: unknown[]; nextCursor?: unknown };
        if (!response || !Array.isArray(response.resources)) throw new Error("Liste des ressources invalide.");
        for (const value of response.resources) {
          if (!value || typeof value !== "object") continue;
          const row = value as Record<string, unknown>;
          if (typeof row["uri"] !== "string" || row["uri"].length > 4096 || /[\u0000-\u001f\u007f]/.test(row["uri"]) || !/^[a-z][a-z0-9+.-]*:/i.test(row["uri"]) || typeof row["name"] !== "string") continue;
          rows.push({ server: entry.d.name, uri: row["uri"], name: row["name"].slice(0, 200), ...(typeof row["mimeType"] === "string" ? { mimeType: row["mimeType"].slice(0, 100) } : {}), ...(typeof row["description"] === "string" ? { description: row["description"].slice(0, 2000) } : {}) });
          if (rows.length > 10_000) throw new Error("Trop de ressources publiées.");
        }
        if (typeof response.nextCursor !== "string" || !response.nextCursor) return rows;
        if (seen.has(response.nextCursor)) throw new Error("Pagination des ressources répétée.");
        seen.add(response.nextCursor); cursor = response.nextCursor;
      }
      throw new Error("Pagination des ressources trop longue.");
    }));
    for (let index = 0; index < entries.length; index++) if (entries[index]!.state === "connected") this.#resourceCache.set(entries[index]!.d.name, groups[index]!);
    return groups.flat();
    } finally { controller.abort(); signal?.removeEventListener("abort", abort); }
  }

  async readResource(server: string, uri: string, signal?: AbortSignal): Promise<Array<{ uri: string; text?: string; blob?: string; mimeType?: string }>> {
    const entry = this.#entries.get(server), connection = entry?.conn;
    if (!entry || entry.state !== "connected" || !connection) throw new Error(`Connecteur ${server} indisponible.`);
    if (!(await this.resources(server, signal)).some(resource => resource.uri === uri)) throw new Error("Ressource non publiée par ce connecteur.");
    if (entry.conn !== connection || entry.state !== "connected") throw new Error("Connexion modifiée pendant la lecture.");
    const response = await connection.request("resources/read", { uri }, { timeoutMs: this.#o.toolTimeoutMs, signal }) as { contents?: unknown[] };
    if (!response || !Array.isArray(response.contents) || response.contents.length > 100) throw new Error("Contenu de ressource invalide.");
    const contents: Array<{ uri: string; text?: string; blob?: string; mimeType?: string }> = []; let size = 0;
    for (const value of response.contents) {
      if (!value || typeof value !== "object") throw new Error("Contenu de ressource invalide.");
      const item = value as Record<string, unknown>;
      if (item["uri"] !== uri || (typeof item["text"] !== "string" && typeof item["blob"] !== "string")) throw new Error("Contenu de ressource invalide.");
      const text = typeof item["text"] === "string" ? item["text"] : undefined, blob = typeof item["blob"] === "string" ? item["blob"] : undefined;
      size += Buffer.byteLength(text ?? blob ?? ""); if (size > 5 * 1024 * 1024) throw new Error("Ressource trop volumineuse.");
      if (blob !== undefined && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(blob))) throw new Error("Binaire de ressource mal encodé.");
      contents.push({ uri, ...(text !== undefined ? { text } : { blob }), ...(typeof item["mimeType"] === "string" ? { mimeType: item["mimeType"] } : {}) });
    }
    return contents;
  }

  /** FA-01 of SPEC-MCP-002, step 3: lost connection, reconnection with an exponential delay, bounded (EF-03). */
  #lost(e: Entry, reason: string): void {
    if (this.#closed) return;
    e.stderr = e.conn?.stderrTail() ?? [];
    const closing = e.conn?.close(0);
    if (closing) { this.#disconnecting.add(closing); void closing.finally(() => this.#disconnecting.delete(closing)).catch(() => {}); }
    e.conn = undefined;
    if (reason === "authentification requise") return this.#authentication(e);
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

  #authentication(e: Entry): void {
    clearTimeout(e.timer); e.state = "auth_required"; e.error = "authentification requise (/connectors)";
    e.settle(); this.#o.report(`Connecteur ${e.d.name} : authentification requise (/connectors).`);
    this.#o.changed({ kind: "failed", name: e.d.name, reason: "authentication required" });
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
    await Promise.allSettled([...this.#connecting, ...this.#disconnecting, ...[...this.#entries.values()].flatMap((e) => e.reconnecting ? [e.reconnecting] : [])]);
  }
}
