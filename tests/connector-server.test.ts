// The product exposed as a connector (SPEC-MOD-008): `connector-server start` answers the standard protocol of the
// connectors on its standard streams, or over an authenticated persistent connection.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EnvironmentView } from "../src/config/environment";
import { cli, workspace, type CliRun, type Workspace } from "./helpers/env";
import { LineFeed } from "./helpers/control";
import { productEnv } from "./helpers/hooks";
import { PREFIX, TOKEN } from "./helpers/remote";
import { ScriptedProvider } from "./helpers/scripted-provider";

type Message = Record<string, unknown>;

class Client {
  readonly feed = new LineFeed();
  readonly messages: Message[] = [];
  readonly run: Promise<CliRun>;
  #err = "";
  #next = 1;
  readonly #waiters: Array<{ test: (m: Message) => boolean; resolve: (m: Message) => void }> = [];

  constructor(ws: Workspace, argv: string[], o: { provider?: ScriptedProvider; env?: Record<string, string>; userConfig?: Record<string, unknown> } = {}) {
    let partial = "";
    this.run = cli(["connector-server", "start", ...argv], ws, {
      provider: o.provider ?? new ScriptedProvider([]),
      stdinSource: this.feed,
      env: o.env ?? productEnv(ws),
      ...(o.userConfig ? { userConfig: o.userConfig } : {}),
      onErr: (t) => (this.#err += t),
      onOut: (t) => {
        partial += t;
        let at: number;
        while ((at = partial.indexOf("\n")) !== -1) {
          const m = JSON.parse(partial.slice(0, at)) as Message;
          partial = partial.slice(at + 1);
          this.messages.push(m);
          for (const w of [...this.#waiters]) {
            if (w.test(m)) {
              this.#waiters.splice(this.#waiters.indexOf(w), 1);
              w.resolve(m);
            }
          }
        }
      },
    });
  }

  get stderr(): string {
    return this.#err;
  }

  send(message: Message): void {
    this.feed.push(JSON.stringify(message));
  }

  request(method: string, params: Message = {}, id: number = this.#next++): Promise<Message> {
    const answer = this.waitFor((m) => m["id"] === id);
    this.send({ jsonrpc: "2.0", id, method, params });
    return answer;
  }

  async initialize(): Promise<Message> {
    const r = await this.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "agent-appelant", version: "1" } });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }

  async call(name: string, args: Message, meta?: Message): Promise<{ text: string; isError: boolean; structured?: unknown }> {
    const r = await this.request("tools/call", { name, arguments: args, ...(meta ? { _meta: meta } : {}) });
    const result = r["result"] as { content: Array<{ text: string }>; isError: boolean; structuredContent?: unknown };
    return { text: result.content.map((c) => c.text).join("\n"), isError: result.isError, structured: result.structuredContent };
  }

  waitFor(test: (m: Message) => boolean, timeoutMs = 10_000): Promise<Message> {
    const found = this.messages.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`réponse attendue non reçue ; erreurs : ${this.#err}`)), timeoutMs);
      this.#waiters.push({
        test,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
    });
  }

  async end(): Promise<CliRun> {
    this.feed.end();
    return this.run;
  }
}

const toolNames = (m: Message) => ((m["result"] as { tools: Array<{ name: string }> }).tools ?? []).map((t) => t.name);

test("SPEC-MOD-012/CA-11 — a connector service announces its role and local execution before handling protocol messages", async () => {
  const provider = new ScriptedProvider([]); const client = new Client(workspace(), [], { provider });
  const initialized = await client.initialize();
  expect(initialized["result"]).toBeDefined();
  const announcement = "Rôle : service de connecteur ; lieu d’exécution : poste local.";
  expect(client.stderr).toContain(announcement);
  expect(client.stderr.indexOf(announcement)).toBeLessThan(client.stderr.indexOf("Serveur de connecteur prêt"));
  expect(provider.requests).toHaveLength(0);
  expect((await client.end()).code).toBe(0);
});

describe("SPEC-MOD-008 capabilities and limits", () => {
  test("SPEC-MOD-008/CA-01 — a server launched without capabilities: only reading and run_agent are listed", async () => {
    const ws = workspace();
    const c = new Client(ws, []);
    const init = await c.initialize();
    expect((init["result"] as Message)["capabilities"]).toEqual({ tools: { listChanged: false } });
    const list = await c.request("tools/list");
    expect(toolNames(list)).toEqual(["run_agent", "read_file", "find_files", "search_content"]);
    const schema = (list["result"] as { tools: Array<{ name: string; inputSchema: Message }> }).tools.find((t) => t.name === "run_agent")!.inputSchema;
    expect((schema["required"] as string[])).toEqual(["prompt"]);
    // FA-01, ERR-01: a capability not listed answers with an error, as a result.
    const hidden = await c.call("write_file", { path: join(ws.project, "x.txt"), content: "x" });
    expect(hidden).toEqual({ text: "Capability unavailable.", isError: true, structured: undefined });
    const r = await c.end();
    expect(r.code).toBe(0);
    expect(c.stderr).toContain("Serveur de connecteur prêt : capacités run_agent, read_file, find_files, search_content");
    expect(c.stderr).toContain("transport processus");
  });

  test("SPEC-MOD-008/CA-02 — a path outside the allowed folder: refused with a generic message", async () => {
    const ws = workspace();
    writeFileSync(join(ws.root, "secret.txt"), "hors du dossier");
    writeFileSync(join(ws.project, "notes.txt"), "dans le dossier");
    const c = new Client(ws, []);
    await c.initialize();
    const outside = await c.call("read_file", { path: join(ws.root, "secret.txt") });
    const missing = await c.call("read_file", { path: join(ws.root, "absent.txt") });
    expect(outside).toEqual({ text: "Access denied.", isError: true, structured: undefined });
    expect(missing.text).toBe(outside.text); // nothing tells whether the path exists
    const inside = await c.call("read_file", { path: "notes.txt" });
    expect(inside.isError).toBe(false);
    expect(inside.text).toContain("dans le dossier");
    await c.end();
    expect(c.stderr).toContain("Appel de agent-appelant : read_file — en erreur");
    expect(c.stderr).toContain("Appel de agent-appelant : read_file — réussi");
  });

  test("SPEC-MOD-008/CA-03 — a permission rule refusing a command: the incoming call is refused", async () => {
    const ws = workspace();
    const c = new Client(ws, ["--capabilities", "run_shell,read_file", "--approval-mode", "auto_edit"], { userConfig: { permissions: { denyRules: ["run_shell(echo *)"] } } });
    await c.initialize();
    expect(toolNames(await c.request("tools/list"))).toEqual(["run_shell", "read_file"]);
    const refused = await c.call("run_shell", { command: "echo coucou" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("denied");
    await c.end();
  });

  test("SPEC-MOD-008/CA-04 — a long run_agent cancelled by the client: the run stops and its resources are freed", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([{ hang: true }]);
    const c = new Client(ws, [], { provider, userConfig: { mcp: { serve: { maxConcurrency: 1 } } } });
    await c.initialize();
    c.send({ jsonrpc: "2.0", id: 50, method: "tools/call", params: { name: "run_agent", arguments: { prompt: "tâche sans fin" }, _meta: { progressToken: "p" } } });
    while (provider.requests.length === 0) await new Promise((r) => setTimeout(r, 20));
    c.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 50 } });
    // With a single slot, the next call runs only once the cancelled one has freed it.
    writeFileSync(join(ws.project, "f.txt"), "libre");
    const next = await c.call("read_file", { path: "f.txt" });
    expect(next.text).toContain("libre");
    await c.end();
    expect(c.messages.some((m) => m["id"] === 50)).toBe(false);
    expect(c.stderr).toContain("run_agent — annulé");
  });

  test("SPEC-MOD-008/CA-05 — a nesting depth of 3 with a limit of 2: the nested call fails with a tool error", async () => {
    const ws = workspace();
    const deep = new Client(ws, [], { env: { ...productEnv(ws), [`${PREFIX}AGENT_DEPTH`]: "2" } });
    await deep.initialize();
    expect(await deep.call("run_agent", { prompt: "encore" })).toEqual({ text: "Nesting too deep.", isError: true, structured: undefined });
    await deep.end();
    // Within the limit, the request runs completely and its answer comes back, with its progress.
    const ws2 = workspace();
    const ok = new Client(ws2, [], { provider: new ScriptedProvider([{ text: "réponse imbriquée" }]) });
    await ok.initialize();
    const r = await ok.call("run_agent", { prompt: "dis bonjour" }, { progressToken: 7 });
    expect(r).toEqual({ text: "réponse imbriquée", isError: false, structured: undefined });
    expect(ok.messages.some((m) => m["method"] === "notifications/progress" && (m["params"] as Message)["progressToken"] === 7)).toBe(true);
    await ok.end();
  });

  test("SPEC-MOD-008/CA-06 — a network transport without a valid token: the connection is refused", async () => {
    const ws = workspace();
    const controller = new AbortController();
    let err = "";
    let ready: (url: string) => void;
    const url = new Promise<string>((r) => (ready = r));
    const run = cli(["connector-server", "start", "--transport", "network", "--listen", "127.0.0.1:0"], ws, {
      provider: new ScriptedProvider([]),
      env: { ...productEnv(ws), [`${PREFIX}CONTROL_TOKEN`]: TOKEN },
      signal: controller.signal,
      onErr: (t) => {
        err += t;
        const m = /réseau \((ws:\/\/[^)]+)\)/.exec(err);
        if (m) ready(m[1]!);
      },
    });
    const address = await url;
    const refused = await fetch(address.replace(/^ws/, "http"), { headers: { Authorization: "Bearer faux" } });
    expect(refused.status).toBe(401);
    // With the token, the protocol of the connectors over the connection.
    const socket = new WebSocket(address, { headers: { Authorization: `Bearer ${TOKEN}` } } as unknown as string[]);
    const answer = new Promise<Message>((resolve) => (socket.onmessage = (e) => resolve(JSON.parse(String(e.data)) as Message)));
    socket.onopen = () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(toolNames(await answer)).toContain("run_agent");
    socket.close();
    controller.abort();
    await run;
    // Without a token in the environment, the network transport does not start.
    const noToken = await cli(["connector-server", "start", "--transport", "network"], workspace(), { provider: new ScriptedProvider([]), env: productEnv(ws) });
    expect(noToken.code).toBe(2);
    expect(noToken.stderr).toContain(`${PREFIX}CONTROL_TOKEN`);
  });
});

describe("SPEC-MOD-008 launch", () => {
  test("TECH — writing capabilities come from the launch option only; unknown ones stop the launch (RG-03)", async () => {
    const ws = workspace();
    const c = new Client(ws, [], { userConfig: { mcp: { serve: { capabilities: ["read_file", "write_file"] } } } });
    await c.initialize();
    expect(toolNames(await c.request("tools/list"))).toEqual(["read_file"]);
    await c.end();
    expect(c.stderr).toContain("mcp.serve.capabilities : write_file ignoré");
    const unknown = await cli(["connector-server", "start", "--capabilities", "teleport"], workspace(), { provider: new ScriptedProvider([]) });
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain("Capacité inconnue : teleport");
    const option = await cli(["connector-server", "start", "--model", "x"], workspace(), { provider: new ScriptedProvider([]) });
    expect(option.code).toBe(2);
  });

  test("TECH — run_agent never gets a mode wider than the server's, nor a folder outside it (RG-01, EF-03)", async () => {
    const ws = workspace();
    mkdirSync(join(ws.root, "ailleurs"));
    const c = new Client(ws, []);
    await c.initialize();
    const wider = await c.call("run_agent", { prompt: "x", approvalMode: "auto_edit" });
    expect(wider.isError).toBe(true);
    expect(wider.text).toContain("cannot be more permissive than no_prompt");
    expect(await c.call("run_agent", { prompt: "x", cwd: join(ws.root, "ailleurs") })).toEqual({ text: "Access denied.", isError: true, structured: undefined });
    const unknownMethod = await c.request("resources/list");
    expect((unknownMethod["error"] as Message)["code"]).toBe(-32601);
    await c.end();
  });

  test("TECH — the nesting depth follows the child processes (EF-05)", () => {
    const view = new EnvironmentView(PREFIX, { [`${PREFIX}AGENT_DEPTH`]: "1", [`${PREFIX}CONFIG_HOME`]: "/tmp/x", PATH: "/bin" });
    const child = view.childEnvironment();
    expect(child[`${PREFIX}AGENT_DEPTH`]).toBe("1");
    expect(child[`${PREFIX}CONFIG_HOME`]).toBeUndefined();
  });
});
