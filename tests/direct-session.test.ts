import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { interactive, KEY } from "./helpers/interactive";
import { connectNetworkWebSocket } from "../src/platform/socket-network";
import type { WsPeer } from "../src/platform/websocket";

const TOKEN = Buffer.from("direct-test-only-not-a-real-secret").toString("base64url");

test("SPEC-MOD-019/CA-01 — authenticated direct CLI executes file tools under the served root", async () => {
  const serverWorkspace = workspace(), clientWorkspace = workspace(), abort = new AbortController();
  const identity = loadIdentity(), prefix = identity.get("ENV_PREFIX");
  const file = serverWorkspace.write("private-token", TOKEN);
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: join(serverWorkspace.project, "direct.txt"), content: "server-side" } }] }, { text: "DIRECT_DONE" }]);
  let ready!: (address: string) => void;
  const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--root", serverWorkspace.project, "--listen", "127.0.0.1:0", "--credential-file", file], serverWorkspace, {
    provider, userConfig: { engine: { nonInteractive: { defaultPermissionMode: "auto_edit" } } }, extra: { signal: abort.signal },
    onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); },
  });
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited without address."); })]);
    const result = await cli(["direct-server", "connect", endpoint, "--non-interactive"], clientWorkspace, { stdin: "Create the requested file.", env: { [prefix + "SERVER_TOKEN"]: TOKEN }, extra: { providerFactory: () => { throw Error("Client must not create a provider."); } } });
    expect(result.code).toBe(0); expect(result.stdout).toContain("DIRECT_DONE");
    expect(result.stdout).not.toContain('"errored":true');
    expect(readFileSync(join(serverWorkspace.project, "direct.txt"), "utf8")).toBe("server-side");
    expect(existsSync(join(clientWorkspace.project, "direct.txt"))).toBe(false);
    expect(provider.requests[0]!.tools.map(tool => tool.name)).not.toContain("run_shell");
  } finally { abort.abort(); await server; }
}, 20000);

test("SPEC-MOD-018/CA-02 — direct CLI refuses an unencrypted non-local endpoint before loading a model", async () => {
  const ws = workspace(); let created = false;
  const result = await cli(["direct-server", "connect", "ws://192.0.2.1:8000", "--non-interactive"], ws, { stdin: "probe", extra: { providerFactory: () => { created = true; throw Error("Model must not be loaded."); } } });
  expect(result.code).toBe(2); expect(result.stderr).toContain("chiffré"); expect(created).toBe(false);
});

test("TECH — a refused direct permission mode ends the client before its user message reaches the model", async () => {
  const ws = workspace(), other = workspace(), abort = new AbortController(), file = ws.write("private-token", TOKEN), provider = new ScriptedProvider([{ text: "MUST_NOT_RUN" }]);
  let ready!: (address: string) => void; const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--credential-file", file], ws, { provider, extra: { signal: abort.signal }, onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); } });
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited."); })]);
    const result = await cli(["direct-server", "connect", endpoint, "--non-interactive", "--approval-mode", "auto_edit"], other, { stdin: "Do not run if the requested mode is refused.", env: { [loadIdentity().get("ENV_PREFIX") + "SERVER_TOKEN"]: TOKEN } });
    expect(result.code).toBe(2); expect(result.stderr).toContain("refusé"); expect(provider.requests).toHaveLength(0);
  } finally { abort.abort(); await server; }
}, 10000);

test("SPEC-MOD-018/CA-01 — the usual interactive UI opens over verified TLS in the server folder and writes only there", async () => {
  const serverWorkspace = workspace(), clientWorkspace = workspace(), abort = new AbortController(), clientAbort = new AbortController();
  const identity = loadIdentity(), prefix = identity.get("ENV_PREFIX"), file = serverWorkspace.write("private-token", TOKEN);
  const openssl = Bun.which("openssl") ?? (existsSync("C:/Program Files/Git/usr/bin/openssl.exe") ? "C:/Program Files/Git/usr/bin/openssl.exe" : undefined);
  expect(openssl).toBeDefined();
  const cert = join(serverWorkspace.root, "server-cert.pem"), key = join(serverWorkspace.root, "server-key.pem");
  expect(spawnSync(openssl!, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }, stdio: "ignore" }).status).toBe(0);
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: join(serverWorkspace.project, "interactive.txt"), content: "TLS_UI_SERVER" } }] }, { text: "UI_DIRECT_COMPLETE" }]);
  let ready!: (address: string) => void; const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--root", serverWorkspace.project, "--listen", "127.0.0.1:0", "--credential-file", file], serverWorkspace, { provider, extra: { signal: abort.signal }, env: { [prefix + "CONTROL_TLS_CERT"]: cert, [prefix + "CONTROL_TLS_KEY"]: key }, onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); } });
  let ui: ReturnType<typeof interactive> | undefined;
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited."); })]);
    expect(endpoint).toStartWith("wss://");
    ui = interactive(["direct-server", "connect", endpoint], clientWorkspace, { env: { [prefix + "SERVER_TOKEN"]: TOKEN, [prefix + "EXTRA_CA_CERTS"]: cert }, signal: clientAbort.signal, extra: { providerFactory: () => { throw Error("The UI is only a remote client."); } } });
    await ui.idle(); await ui.waitFor(text => text.includes(serverWorkspace.project), "server-owned folder");
    expect(ui.all().join("\n")).toContain("connecté à 127.0.0.1");
    ui.type("Create the file on the server." + KEY.enter);
    await ui.waitFor(text => text.includes("write_file") && text.includes("Non"), "remote human approval");
    await new Promise(resolve => setTimeout(resolve, 370));
    ui.type(KEY.enter);
    await ui.waitFor(text => text.includes("UI_DIRECT_COMPLETE"), "remote completion");
    expect(readFileSync(join(serverWorkspace.project, "interactive.txt"), "utf8")).toBe("TLS_UI_SERVER");
    expect(existsSync(join(clientWorkspace.project, "interactive.txt"))).toBe(false);
    expect(ui.all().join("\n")).not.toContain(TOKEN);
    ui.type("/exit" + KEY.enter);
    expect((await ui.done).code).toBe(0);
  } finally { clientAbort.abort(); await ui?.done; abort.abort(); await server; }
}, 30000);

test("SPEC-MOD-019/CA-02 — missing or incorrect tokens are rejected before any session engine is composed", async () => {
  const ws = workspace(), abort = new AbortController(), file = ws.write("private-token", TOKEN); let engines = 0;
  let ready!: (address: string) => void; const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--credential-file", file], ws, { extra: { signal: abort.signal, providerFactory: () => { engines++; return new ScriptedProvider([]); } }, onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); } });
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited."); })]);
    for (const headers of [{}, { authorization: "Bearer invalid-fixture-token" }] as Record<string, string>[]) {
      let opened = false;
      await new Promise<void>(resolve => {
        const connection = connectNetworkWebSocket(endpoint, headers, { onOpen: peer => { opened = true; peer.close(); }, onMessage: () => {}, onClose: () => { connection.close(); resolve(); } }, { noProxy: [], caHint: "Fixture CA" });
      });
      expect(opened).toBe(false); expect(engines).toBe(0);
    }
  } finally { abort.abort(); const result = await server; expect(result.stdout + result.stderr).not.toContain(TOKEN); }
}, 10000);

test("TECH — direct sessions cannot escape the root, invoke shell or agents, or read the server token even with broad allow rules", async () => {
  const ws = workspace(), other = workspace(), abort = new AbortController(), prefix = loadIdentity().get("ENV_PREFIX");
  const file = ws.write("project/server-token", TOKEN), outside = ws.write("outside.txt", "OUTSIDE_PRIVATE_CONTENT");
  const escape = join(ws.root, "escaped.txt"), shellEscape = join(ws.root, "shell-escaped.txt");
  const provider = new ScriptedProvider([{ toolCalls: [
    { name: "read_file", input: { path: outside } }, { name: "read_file", input: { path: file } },
    { name: "write_file", input: { path: escape, content: "escape" } },
    { name: "run_shell", input: { command: `echo escape > ${JSON.stringify(shellEscape)}` } },
    { name: "spawn_agent", input: { prompt: "Escape the root." } },
  ] }, { text: "BOUNDARY_COMPLETE" }]);
  let ready!: (address: string) => void; const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--root", ws.project, "--credential-file", file], ws, { provider, userConfig: { permissions: { allowRules: ["read_file", "write_file", "run_shell", "spawn_agent"] } }, extra: { signal: abort.signal }, onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); } });
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited."); })]);
    const result = await cli(["direct-server", "connect", endpoint, "--non-interactive"], other, { stdin: "Attempt the five boundary probes.", env: { [prefix + "SERVER_TOKEN"]: TOKEN } });
    expect(result.code).toBe(0); expect(result.stdout).toContain("BOUNDARY_COMPLETE");
    expect(result.stdout).not.toContain("OUTSIDE_PRIVATE_CONTENT"); expect(result.stdout).not.toContain(TOKEN);
    expect(existsSync(escape)).toBe(false); expect(existsSync(shellEscape)).toBe(false);
    expect(provider.requests[0]!.tools.map(tool => tool.name)).toEqual(["edit_file", "find_files", "read_file", "search_content", "update_todo_list", "write_file"]);
    const results = provider.requests[1]!.history.filter(message => message.role === "user").flatMap(message => message.role === "user" ? message.parts : []).filter(part => part.type === "tool_result");
    expect(results).toHaveLength(5); expect(results.every(result => result.type === "tool_result" && result.isError)).toBe(true);
  } finally { abort.abort(); await server; }
}, 20000);

test("TECH — a real direct session pauses before its write and next model call, resumes once, and keeps the same server-owned folder", async () => {
  const ws = workspace(), abort = new AbortController(), file = ws.write("private-token", TOKEN), target = join(ws.project, "after-resume.txt");
  const provider = new ScriptedProvider([{ delayMs: 250, toolCalls: [{ name: "write_file", input: { path: target, content: "RESUMED_ONCE" } }] }, { text: "RECONNECTED_RESULT" }]);
  let ready!: (address: string) => void; const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--root", ws.project, "--credential-file", file], ws, { provider, userConfig: { engine: { nonInteractive: { defaultPermissionMode: "auto_edit" } }, remote: { transport: { resumeWindowSeconds: 5, keepAliveSeconds: 1 } } }, extra: { signal: abort.signal }, onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); } });
  let first: { close(): void } | undefined, resumed: { close(): void } | undefined, peer: WsPeer | undefined;
  const messages: Record<string, unknown>[] = []; let lastSeq = 0;
  const until = async (predicate: () => boolean) => { const end = Date.now() + 8000; while (!predicate()) { if (Date.now() > end) throw Error("Direct resumption fixture timed out."); await new Promise(resolve => setTimeout(resolve, 10)); } };
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited."); })]);
    const receive = (text: string) => { const message = JSON.parse(text) as Record<string, unknown>; messages.push(message); if (typeof message["seq"] === "number") { lastSeq = message["seq"]; peer?.send(JSON.stringify({ type: "ack", seq: lastSeq })); } if (message["type"] === "keepalive") peer?.send(JSON.stringify({ type: "keepalive" })); };
    let closed = false;
    first = connectNetworkWebSocket(endpoint, { authorization: "Bearer " + TOKEN }, { onOpen: connection => { peer = connection; connection.send(JSON.stringify({ type: "control_init", protocolVersion: "1.0", demands: ["notify"], requests: [] })); }, onMessage: text => { receive(text); if (JSON.parse(text).type === "tool_call") first?.close(); }, onClose: () => { closed = true; } }, { noProxy: [], caHint: "Fixture CA" });
    await until(() => messages.some(message => message["type"] === "session"));
    const init = messages.find(message => message["type"] === "control_init")!, metadata = init["directServer"] as Record<string, unknown>;
    peer!.send(JSON.stringify({ type: "user", content: "Create the file after the connection returns." }));
    await until(() => closed); await new Promise(resolve => setTimeout(resolve, 450));
    expect(existsSync(target)).toBe(false); expect(provider.requests).toHaveLength(1);
    resumed = connectNetworkWebSocket(endpoint, { authorization: "Bearer " + TOKEN, "x-direct-session": String(metadata["id"]) }, { onOpen: connection => { peer = connection; connection.send(JSON.stringify({ type: "resume", resumeToken: init["resumeToken"], lastSeq })); }, onMessage: receive, onClose: () => {} }, { noProxy: [], caHint: "Fixture CA" });
    await until(() => messages.some(message => message["type"] === "turn_completed"));
    expect(readFileSync(target, "utf8")).toBe("RESUMED_ONCE"); expect(provider.requests).toHaveLength(2);
    const attached = messages.find(message => message["type"] === "resumed")!;
    expect(attached["resumeToken"]).not.toBe(init["resumeToken"]);
    expect(messages.filter(message => message["type"] === "control_init")).toHaveLength(1);
    expect((messages.find(message => message["type"] === "session")!)["cwd"]).toBe(ws.project);
    peer!.send(JSON.stringify({ type: "control_request", id: "finish-resume-test", request: "shutdown", params: {} }));
    await until(() => messages.some(message => message["type"] === "run_completed"));
  } finally { first?.close(); resumed?.close(); abort.abort(); await server; }
}, 15000);
