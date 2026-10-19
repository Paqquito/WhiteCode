import { expect, test } from "bun:test";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { directServerToken, readDirectTokenFile } from "../src/direct/token";
import { workspace } from "./helpers/env";

test("TECH — concurrent direct servers obtain one generated token through the credential store", async () => {
  const ws = workspace(), values = new Map<string, string>(); let saves = 0;
  const store = { get: async (name: string) => { await new Promise(resolve => setTimeout(resolve, 15)); return values.get(name); }, save: async (name: string, value: string) => { saves++; values.set(name, value); } };
  const options = { store, directory: join(ws.configHome, "direct-server"), signal: new AbortController().signal, assertPolicy: () => {} };
  const [one, two] = await Promise.all([directServerToken(options), directServerToken(options)]);
  expect(one).toBe(two); expect(Buffer.from(one, "base64url")).toHaveLength(32); expect(saves).toBe(1);
  expect(await directServerToken(options)).toBe(one); expect(saves).toBe(1);
});
test("TECH — supplied direct token files are bounded and malformed values are never echoed", () => {
  const ws = workspace(), value = randomBytes(32).toString("base64url");
  expect(readDirectTokenFile(ws.write("token", value + "\n"))).toBe(value);
  const invalid = ws.write("invalid-token", "fixture-secret");
  // A supplied base64url value must represent at least 128 bits; its randomness remains the issuer's responsibility.
  let message = ""; try { readDirectTokenFile(invalid); } catch (error) { message = (error as Error).message; }
  expect(message).not.toBe(""); expect(message).not.toContain("fixture-secret");
});
test("TECH — a revoked policy never saves a generated direct server token", async () => {
  const ws = workspace(); let reads = 0, saves = 0, revoked = false;
  await expect(directServerToken({ directory: join(ws.configHome, "direct-server"), store: { get: async () => { reads++; revoked = true; return undefined; }, save: async () => { saves++; } }, signal: new AbortController().signal, assertPolicy: () => { if (revoked) throw Error("Revoked fixture policy."); } })).rejects.toThrow("Revoked fixture policy");
  expect(reads).toBe(1); expect(saves).toBe(0);
});
