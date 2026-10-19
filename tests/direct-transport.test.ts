import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { listenWebSocket } from "../src/platform/websocket";
import { connectNetworkWebSocket } from "../src/platform/socket-network";
import { workspace } from "./helpers/env";

test("TECH — direct transport authenticates before opening and delivers opening metadata to the accepted session", async () => {
  let received = "", accepted = 0, resolve!: () => void;
  const done = new Promise<void>(ready => { resolve = ready; });
  const server = listenWebSocket({ hostname: "127.0.0.1", port: 0, maxPayloadLength: 10000, authorize: request => request.headers.get("authorization") === "Bearer fixture-transport-only", onOpen: (peer, opening) => { accepted++; received = opening.headers.get("x-direct-session") ?? ""; peer.send("OPENED"); }, onMessage: () => {}, onClose: () => {} });
  let connection: { close(): void } | undefined;
  try {
    await new Promise<void>(closed => { connection = connectNetworkWebSocket(`ws://127.0.0.1:${server.port}`, {}, { onOpen: () => { throw Error("Unauthenticated opening was accepted."); }, onMessage: () => {}, onClose: closed }, { noProxy: [], caHint: "Fixture trust" }); });
    expect(accepted).toBe(0);
    connection = connectNetworkWebSocket(`ws://127.0.0.1:${server.port}`, { authorization: "Bearer fixture-transport-only", "x-direct-session": "fixture-session" }, { onOpen: () => {}, onMessage: () => resolve(), onClose: () => {} }, { noProxy: [], caHint: "Fixture trust" });
    await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(Error("Opening timeout.")), 2000))]);
    expect(accepted).toBe(1); expect(received).toBe("fixture-session");
  } finally { connection?.close(); server.stop(); }
}, 5000);

test("TECH — a direct TLS client verifies its configured CA and rejects an untrusted certificate", async () => {
  const ws = workspace(), openssl = Bun.which("openssl") ?? (existsSync("C:/Program Files/Git/usr/bin/openssl.exe") ? "C:/Program Files/Git/usr/bin/openssl.exe" : undefined);
  expect(openssl).toBeDefined();
  const cert = join(ws.root, "test-cert.pem"), key = join(ws.root, "test-key.pem");
  expect(spawnSync(openssl!, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" }, stdio: "ignore" }).status).toBe(0);
  const server = listenWebSocket({ hostname: "127.0.0.1", port: 0, tls: { cert: readFileSync(cert, "utf8"), key: readFileSync(key, "utf8") }, maxPayloadLength: 10000, authorize: () => true, onOpen: peer => peer.send("VERIFIED_TLS"), onMessage: () => {}, onClose: () => {} });
  const attempt = (ca?: string) => new Promise<string>((resolve, reject) => {
    let result = "closed", connection: { close(): void } | undefined;
    const timeout = setTimeout(() => { connection?.close(); reject(Error("TLS timeout.")); }, 2000);
    connection = connectNetworkWebSocket(`wss://127.0.0.1:${server.port}`, {}, { onOpen: () => {}, onMessage: text => { result = text; connection?.close(); }, onClose: () => { clearTimeout(timeout); resolve(result); } }, { noProxy: [], caHint: "Fixture trust", ...(ca ? { extraCa: ca } : {}) });
  });
  try { expect(await attempt()).toBe("closed"); expect(await attempt(readFileSync(cert, "utf8"))).toBe("VERIFIED_TLS"); }
  finally { server.stop(); }
}, 10000);
