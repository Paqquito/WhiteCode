import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { LocalPeers, type PeerMessage, peerTools } from "../src/session/peers";
import { connect } from "node:net";
import { workspace } from "./helpers/env";
import { ownedByCurrentUser } from "../src/platform/private-file";
const peers = (folder: string, name: string, receive: (message: PeerMessage) => boolean = () => true, enabled = true) => new LocalPeers({ folder, cwd: folder, name: () => name, enabled: () => enabled, maxBytes: () => 65536, receive, redact: text => text, warn: () => {} });
test("TECH — local peer delivery authenticates the sender, preserves data and removes its registration at close", async () => {
  const folder = join(workspace().root, "peers"), messages: PeerMessage[] = [], first = peers(folder, "First"), second = peers(folder, "Second", message => { messages.push(message); return true; });
  try { await Promise.all([first.ready, second.ready]); const destination = first.list()[0]!, sender = second.list()[0]!; expect(destination.name).toBe("Second"); await first.send(destination.address, "UNTRUSTED_PEER_BODY_49", new AbortController().signal); expect(messages).toHaveLength(1); expect(messages[0]).toMatchObject({ from: sender.address, name: "First", message: "UNTRUSTED_PEER_BODY_49" }); await first.close(); expect(second.list()).toHaveLength(0); }
  finally { await second.close(); }
});
test("TECH — dead peer PIDs are excluded and removed without following untrusted socket addresses", async () => {
  const folder = join(workspace().root, "peers"), first = peers(folder, "First"), second = peers(folder, "Second");
  try { await Promise.all([first.ready, second.ready]); const id = first.list()[0]!.address, file = join(folder, id + ".json"), row = JSON.parse(readFileSync(file, "utf8")); row.pid = 2147483647; writeFileSync(file, JSON.stringify(row)); expect(first.list()).toHaveLength(0); expect(() => readFileSync(file)).toThrow(); }
  finally { await Promise.all([first.close(), second.close()]); }
});
test("TECH — disabled or oversized peer writes are refused before reaching the recipient", async () => {
  const folder = join(workspace().root, "peers"), first = peers(folder, "First", () => true, false), second = peers(folder, "Second");
  try { await Promise.all([first.ready, second.ready]); const id = first.list()[0]!.address; await expect(first.send(id, "No delivery", new AbortController().signal)).rejects.toThrow("disabled"); const tool = peerTools(() => first, () => false).find(tool => tool.name === "message_agent")!; expect(tool.validate!({ to: id, message: "No delivery" } as never, {} as never)).toContain("disabled"); }
  finally { await Promise.all([first.close(), second.close()]); }
});
test("TECH — peer shutdown closes a slow incoming connection promptly and never delivers its partial frame", async () => {
  const folder = join(workspace().root, "peers"); let delivered = 0;
  const first = peers(folder, "First"), second = peers(folder, "Second", () => { delivered++; return true; });
  await Promise.all([first.ready, second.ready]); const id = first.list()[0]!.address, address = JSON.parse(readFileSync(join(folder, id + ".json"), "utf8")).address as string;
  const socket = connect(address); socket.on("error", () => {});
  await new Promise<void>(resolve => socket.on("connect", resolve)); const timer = setInterval(() => socket.write("{"), 50);
  try { await Bun.sleep(100); const started = performance.now(); await second.close(); expect(performance.now() - started).toBeLessThan(500); expect(delivered).toBe(0); expect(first.list()).toHaveLength(0); }
  finally { clearInterval(timer); socket.destroy(); await Promise.all([first.close(), second.close()]); }
});
test("TECH — concurrent outgoing messages to one peer retain their call order", async () => {
  const folder = join(workspace().root, "peers"), messages: string[] = [], first = peers(folder, "First"), second = peers(folder, "Second", message => { messages.push(message.message); return true; });
  try { await Promise.all([first.ready, second.ready]); const id = first.list()[0]!.address; await Promise.all(Array.from({ length: 20 }, (_, index) => first.send(id, `MESSAGE_${index}`, new AbortController().signal))); expect(messages).toEqual(Array.from({ length: 20 }, (_, index) => `MESSAGE_${index}`)); }
  finally { await Promise.all([first.close(), second.close()]); }
});

test("TECH — doubly encoded peer frames preserve permitted backslashes and newlines", async () => {
  const folder = join(workspace().root, "peers"), messages: string[] = [], first = peers(folder, "First"), second = peers(folder, "Second", message => { messages.push(message.message); return true; });
  try {
    await Promise.all([first.ready, second.ready]); const id = first.list()[0]!.address;
    for (const message of ["\\".repeat(20000), "\n".repeat(30000)]) await first.send(id, message, new AbortController().signal);
    expect(messages).toEqual(["\\".repeat(20000), "\n".repeat(30000)]);
    await expect(first.send(id, "x".repeat(65537), new AbortController().signal)).rejects.toThrow("too long");
    expect(messages).toHaveLength(2);
  } finally { await Promise.all([first.close(), second.close()]); }
});

test("TECH — private peer registrations retain system ownership and refresh their name and working folder", async () => {
  const folder = join(workspace().root, "peers"); let cwd = "initial", name = "Before";
  const first = new LocalPeers({ folder, cwd: () => cwd, name: () => name, enabled: () => true, maxBytes: () => 65536, receive: () => true, redact: value => value, warn: () => {} }), second = peers(folder, "Second");
  try {
    await Promise.all([first.ready, second.ready]); const before = second.list()[0]!;
    expect(ownedByCurrentUser(folder)).toBe(true); expect(ownedByCurrentUser(join(folder, before.address + ".json"))).toBe(true);
    cwd = "isolated-copy"; name = "After"; first.update();
    expect(second.list()[0]).toMatchObject({ address: before.address, name: "After", cwd: "isolated-copy" });
    expect(Date.parse(second.list()[0]!.lastActivity)).toBeGreaterThanOrEqual(Date.parse(before.lastActivity));
  } finally { await Promise.all([first.close(), second.close()]); }
});
