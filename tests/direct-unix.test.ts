import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, loadIdentity, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { listenWebSocket } from "../src/platform/websocket";

test.skipIf(process.platform === "win32")("TECH — a native Unix direct CLI authenticates, executes under the served root and removes its owned socket", async () => {
  const serverWorkspace = workspace(), clientWorkspace = workspace(), abort = new AbortController();
  const token = Buffer.from("unix-direct-fixture-never-a-real-secret").toString("base64url"), file = serverWorkspace.write("token", token), socket = join(serverWorkspace.root, "direct é #?:%.sock"), target = join(serverWorkspace.project, "unix.txt");
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "write_file", input: { path: target, content: "NATIVE_UNIX" } }] }, { text: "UNIX_COMPLETE" }]);
  let ready!: () => void; const listening = new Promise<void>(resolve => { ready = resolve; });
  const server = cli(["direct-server", "start", "--listen", "unix:" + socket, "--credential-file", file], serverWorkspace, { provider, extra: { signal: abort.signal }, userConfig: { engine: { nonInteractive: { defaultPermissionMode: "auto_edit" } } }, onOut: text => { if (text.includes("Adresse de connexion : unix:" + socket)) ready(); } });
  try {
    await Promise.race([listening, server.then(result => { throw Error(result.stderr || "Unix server exited."); })]);
    expect(lstatSync(socket).isSymbolicLink()).toBe(true); expect(statSync(socket).isSocket()).toBe(true); expect(statSync(socket).mode & 0o777).toBe(0o600);
    const result = await cli(["direct-server", "connect", "unix:" + socket, "--non-interactive"], clientWorkspace, { stdin: "Create the Unix server file.", env: { [loadIdentity().get("ENV_PREFIX") + "SERVER_TOKEN"]: token }, extra: { providerFactory: () => { throw Error("The Unix client must not compose a provider."); } } });
    expect(result.code).toBe(0); expect(result.stdout).toContain("UNIX_COMPLETE"); expect(result.stdout).not.toContain(token);
    expect(readFileSync(target, "utf8")).toBe("NATIVE_UNIX"); expect(existsSync(join(clientWorkspace.project, "unix.txt"))).toBe(false);
  } finally { abort.abort(); await server; }
  expect(existsSync(socket)).toBe(false);
}, 20000);

test.skipIf(process.platform === "win32")("TECH — a native Unix listener never replaces an existing file and permits a new listener after owned shutdown", async () => {
  const ws = workspace(), occupied = ws.write("occupied.sock", "USER_FILE"), socket = join(ws.root, "owned.sock");
  const options = { hostname: "127.0.0.1", port: 0, maxPayloadLength: 10000, authorize: () => true, onOpen: () => {}, onMessage: () => {}, onClose: () => {} };
  expect(() => listenWebSocket({ ...options, unix: occupied })).toThrow("occupée"); expect(readFileSync(occupied, "utf8")).toBe("USER_FILE");
  const first = listenWebSocket({ ...options, unix: socket }); const physical = readlinkSync(socket); await first.stopJoined!();
  expect(existsSync(physical)).toBe(false);
  const second = listenWebSocket({ ...options, unix: socket }); await second.stopJoined!(); expect(existsSync(socket)).toBe(false);
});

test.skipIf(process.platform === "win32")("TECH — a Unix shutdown preserves a replacement file at its former socket name", async () => {
  const ws = workspace(), socket = join(ws.root, "replaced.sock");
  const server = listenWebSocket({ hostname: "127.0.0.1", port: 0, unix: socket, maxPayloadLength: 10000, authorize: () => true, onOpen: () => {}, onMessage: () => {}, onClose: () => {} });
  expect(statSync(socket).isSocket()).toBe(true); unlinkSync(socket); writeFileSync(socket, "REPLACEMENT_FILE");
  await server.stopJoined!();
  expect(readFileSync(socket, "utf8")).toBe("REPLACEMENT_FILE");
});
