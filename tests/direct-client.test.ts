import { expect, test } from "bun:test";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { DirectClient } from "../src/direct/client";
import { parseDirectAddress } from "../src/direct/address";
import { listenWebSocket, type WsPeer } from "../src/platform/websocket";
import { connectNetworkWebSocket } from "../src/platform/socket-network";

for (const cancelDuringDisconnect of [false, true]) test(cancelDuringDisconnect ? "TECH — cancelling a disconnected direct turn prevents automatic reattachment and its pending write" : "TECH — the delivered direct client reconnects transparently without replaying a user request or disclosing transport secrets", async () => {
  const ws = workspace(), abort = new AbortController(), token = Buffer.from("direct-reconnect-fixture-not-real").toString("base64url"), file = ws.write("token", token), target = join(ws.project, "once.txt");
  const provider = new ScriptedProvider([{ delayMs: 400, toolCalls: [{ name: "write_file", input: { path: target, content: "ONCE" } }] }, { text: "AUTO_RESUME_COMPLETE" }]);
  let ready!: (url: string) => void; const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--credential-file", file], ws, { provider, userConfig: { engine: { nonInteractive: { defaultPermissionMode: "auto_edit" } }, remote: { transport: { resumeWindowSeconds: 5, keepAliveSeconds: 1 } } }, extra: { signal: abort.signal }, onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); } });
  let client: DirectClient | undefined, proxy: ReturnType<typeof listenWebSocket> | undefined;
  const upstream = new Set<{ close(): void }>();
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited."); })]);
    const connections = new Map<WsPeer, { send(text: string): void; close(): void }>(); let dropped = false;
    proxy = listenWebSocket({ hostname: "127.0.0.1", port: 0, maxPayloadLength: 1024 * 1024, authorize: request => request.headers.get("authorization") === "Bearer " + token,
      onOpen: (downstream, opening) => {
        let remote: WsPeer | undefined; const pending: string[] = [];
        const headers: Record<string, string> = { authorization: "Bearer " + token };
        const id = opening.headers.get("x-direct-session"); if (id) headers["x-direct-session"] = id;
        const connection = connectNetworkWebSocket(endpoint, headers, { onOpen: peer => { remote = peer; for (const text of pending) peer.send(text); pending.length = 0; }, onMessage: text => {
          downstream.send(text);
          if (!dropped && JSON.parse(text).type === "tool_call") { dropped = true; downstream.close(); connection.close(); }
        }, onClose: () => downstream.close() }, { noProxy: [], caHint: "Fixture CA" });
        upstream.add(connection); connections.set(downstream, { send: text => { if (remote) remote.send(text); else pending.push(text); }, close: () => { connection.close(); upstream.delete(connection); } });
      }, onMessage: (peer, text) => connections.get(peer)?.send(text), onClose: peer => { connections.get(peer)?.close(); connections.delete(peer); },
    });
    const messages: Readonly<Record<string, unknown>>[] = [], states: boolean[] = [], turn = new AbortController();
    client = new DirectClient({ address: parseDirectAddress(`ws://127.0.0.1:${proxy.port}`), token, version: "0.1.0", signal: abort.signal, network: { noProxy: [], caHint: "Fixture CA" }, maxFrameBytes: 1024 * 1024, onMessage: message => messages.push(message), onConnection: state => { states.push(state); if (!state && cancelDuringDisconnect) turn.abort(); } });
    const metadata = await client.ready; expect(metadata.cwd).toBe(ws.project);
    client.initialize();
    const outcome = await client.turn("Create the file once.", turn.signal);
    if (cancelDuringDisconnect) {
      expect(outcome.stopCause).toBe("interrupted"); expect(await client.done).toBe(130);
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(existsSync(target)).toBe(false); expect(provider.requests).toHaveLength(1); expect(states.filter(Boolean)).toHaveLength(1); return;
    }
    expect(outcome.stopCause).toBe("completed");
    expect(dropped).toBe(true); expect(states.filter(Boolean)).toHaveLength(2);
    expect(readFileSync(target, "utf8")).toBe("ONCE"); expect(provider.requests).toHaveLength(2);
    expect(messages.filter(message => message["type"] === "user" && JSON.stringify(message["content"]).includes("Create the file once."))).toHaveLength(1);
    expect(JSON.stringify(messages)).not.toContain(token); expect(messages.every(message => !("resumeToken" in message))).toBe(true);
    expect((await client.requestResult("get_state", {}, 2000))["model"]).toBe("test-medium");
    client.request("shutdown"); expect(await client.done).toBe(0);
  } finally { client?.close(); proxy?.stop(); for (const connection of upstream) connection.close(); abort.abort(); await server; }
}, 15000);

test("TECH — a direct application queue refuses excess authenticated input and shutdown does not execute queued work", async () => {
  const ws = workspace(), abort = new AbortController(), token = Buffer.from("direct-queue-fixture-never-real").toString("base64url"), file = ws.write("token", token), provider = new ScriptedProvider([{ hang: true }]);
  let ready!: (url: string) => void; const address = new Promise<string>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--credential-file", file], ws, { provider, extra: { signal: abort.signal }, onOut: text => { const match = /Adresse de connexion : (\S+)/.exec(text); if (match) ready(match[1]!); } });
  let client: DirectClient | undefined;
  try {
    const endpoint = await Promise.race([address, server.then(result => { throw Error(result.stderr || "Server exited."); })]);
    client = new DirectClient({ address: parseDirectAddress(endpoint), token, version: "0.1.0", signal: abort.signal, network: { noProxy: [], caHint: "Fixture CA" }, maxFrameBytes: 4 * 1024 * 1024, onMessage: () => {}, onConnection: () => {} });
    await client.ready; client.initialize(); const running = client.turn("Keep this first turn pending.", abort.signal);
    const until = Date.now() + 3000; while (provider.requests.length === 0) { if (Date.now() > until) throw Error("Provider did not start."); await new Promise(resolve => setTimeout(resolve, 10)); }
    expect(await client.requestResult("inject_user_message", { content: "x".repeat(3 * 1024 * 1024) }, 2000)).toHaveProperty("messageId");
    await expect(client.requestResult("inject_user_message", { content: "y".repeat(3 * 1024 * 1024) }, 2000)).rejects.toThrow("pleine");
    expect((await client.requestResult("get_state", {}, 2000))["queued"]).toBe(1);
    client.request("shutdown"); expect((await running).stopCause).toBe("interrupted"); expect(await client.done).toBe(0); expect(provider.requests).toHaveLength(1);
  } finally { client?.close(); abort.abort(); await server; }
}, 10000);
