import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseDirectAddress, parseDirectListen } from "../src/direct/address";

test.each(["ws://example.test:9000", "ws://192.0.2.10:9000", "ws://[2001:db8::1]:9000"])("TECH — an unencrypted nonlocal direct address is refused, case %s", address => {
  expect(() => parseDirectAddress(address)).toThrow("chiffré");
});
test.each(["wss://example.test:9443/control", "ws://127.0.0.1:9000", "ws://[::1]:9000"])("TECH — a supported direct WebSocket address is normalized, case %s", address => {
  const parsed = parseDirectAddress(address); expect(parsed.kind).toBe("websocket");
  if (parsed.kind === "websocket") { expect(parsed.url).toBe(new URL(address).href); expect(parsed.secure).toBe(address.startsWith("wss:")); }
});
test.each(["wss://secret-user:secret-value@example.test", "wss://example.test?token=secret-value", "wss://example.test#secret-value", "https://example.test", "unix:relative", "ws://127.0.0.1\n"])("TECH — invalid direct addresses never disclose their supplied content, case %s", address => {
  let message = ""; try { parseDirectAddress(address); } catch (error) { message = (error as Error).message; }
  expect(message).not.toBe(""); expect(message).not.toContain("secret-value");
});
test("TECH — a local direct socket accepts an absolute path and no network authority", () => {
  expect(parseDirectAddress("unix:/tmp/direct-fixture.sock")).toEqual({ kind: "unix", path: resolve("/tmp/direct-fixture.sock") });
  expect(parseDirectAddress("unix:/tmp/direct fixture.sock")).toEqual({ kind: "unix", path: resolve("/tmp/direct fixture.sock") });
});
test("TECH — a direct listener defaults to loopback and requires encryption for a network interface", () => {
  expect(parseDirectListen(undefined, false)).toEqual({ kind: "tcp", hostname: "127.0.0.1", port: 0 });
  expect(() => parseDirectListen("0.0.0.0:9000", false)).toThrow("chiffré");
  expect(parseDirectListen("0.0.0.0:9000", true)).toEqual({ kind: "tcp", hostname: "0.0.0.0", port: 9000 });
});
