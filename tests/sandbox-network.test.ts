// Supports: SPEC-PER-015 (literal-address rejection, domain framing and bounded encrypted tunnels).
import { expect, test } from "bun:test";
import { proxyDestination, tlsServerName } from "../src/platform/sandbox-network";
test("TECH — the proxy rejects direct addresses, credentials, mismatched authority and non-web tunnels", () => {
  expect(proxyDestination("GET http://allowed.test/path HTTP/1.1\r\nHost: allowed.test\r\n\r\n").host).toBe("allowed.test");
  expect(proxyDestination("CONNECT allowed.test:443 HTTP/1.1\r\nHost: allowed.test:443\r\n\r\n").tunnel).toBe(true);
  for (const request of ["CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n", "CONNECT allowed.test:22 HTTP/1.1\r\n\r\n", "GET http://user:pass@allowed.test/ HTTP/1.1\r\nHost: allowed.test\r\n\r\n", "GET http://allowed.test/ HTTP/1.1\r\nHost: other.test\r\n\r\n"]) expect(() => proxyDestination(request)).toThrow();
});
test("TECH — an HTTPS tunnel cannot send arbitrary plaintext or omit a bounded TLS client hello", () => {
  expect(tlsServerName(Buffer.alloc(0))).toBeUndefined();
  expect(() => tlsServerName(Buffer.from("GET / HTTP/1.1\r\n"))).toThrow("TLS");
  expect(() => tlsServerName(Buffer.alloc(65537))).toThrow();
});
test("TECH — visible TLS names survive fragmented transport; alternate bytes and encrypted names fail closed", () => {
  const word = (value: number) => { const bytes = Buffer.alloc(2); bytes.writeUInt16BE(value); return bytes; };
  const hello = (name: Buffer, encrypted = false) => {
    const names = Buffer.concat([word(name.length + 3), Buffer.from([0]), word(name.length), name]);
    const extensions = Buffer.concat([word(0), word(names.length), names, ...(encrypted ? [word(0xfe0d), word(0)] : [])]);
    const body = Buffer.concat([Buffer.from([3, 3]), Buffer.alloc(32), Buffer.from([0, 0, 2, 0x13, 1, 1, 0]), word(extensions.length), extensions]);
    const handshake = Buffer.alloc(4); handshake[0] = 1; handshake.writeUIntBE(body.length, 1, 3);
    return Buffer.concat([Buffer.from([22, 3, 3]), word(body.length + 4), handshake, body]);
  };
  const valid = hello(Buffer.from("allowed.test"));
  for (const length of [1, 4, 20, valid.length - 1]) expect(tlsServerName(valid.subarray(0, length))).toBeUndefined();
  expect(tlsServerName(valid)).toBe("allowed.test");
  expect(() => tlsServerName(hello(Buffer.from([0xe1, ...Buffer.from("llowed.test")])))).toThrow();
  expect(() => tlsServerName(hello(Buffer.from("allowed.test"), true))).toThrow("Encrypted");
});
