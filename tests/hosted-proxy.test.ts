// Supports: SPEC-PER-023 (explicit upstream protocol and fail-closed configuration).
import { expect, test } from "bun:test";
import { protectHostedProxyMemory, upstreamConfiguration } from "../src/platform/hosted-proxy";
test("TECH — hosted upstream routing requires explicit authenticated TLS protocol and absolute control paths", () => {
  const valid = { protocol: "h2-connect-v1", url: "https://relay.fixture/", tokenFile: "/private/session.token", bootstrapCaFile: "/private/bootstrap.pem" } as const;
  expect(upstreamConfiguration(valid)).toEqual(valid);
  for (const change of [{ protocol: "http" }, { url: "http://relay.fixture/" }, { url: "https://user:secret@relay.fixture/" }, { url: "https://relay.fixture/path" }, { tokenFile: "relative" }, { bootstrapCaFile: "relative" }]) expect(() => upstreamConfiguration({ ...valid, ...change })).toThrow();
});
test.skipIf(process.platform === "linux")("TECH — unsupported systems explicitly refuse the upstream memory boundary", () => {
  expect(() => protectHostedProxyMemory()).toThrow("Linux x64");
});
