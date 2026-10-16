import { expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { readResidentEndpoint } from "../src/services/supervisor";
import { readPrivateText } from "../src/shared/private-text";
import { workspace } from "./helpers/env";

test("TECH — a resident endpoint removed between discovery and read is unavailable, not a malformed service", () => {
  const ws = workspace(), path = ws.write("home/config/resident-endpoint.json", JSON.stringify({ port: 12345, token: "f".repeat(64), pid: process.pid }));
  let reads = 0;
  expect(readResidentEndpoint(ws.configHome, (file, maximum) => { reads++; unlinkSync(path); return readPrivateText(file, maximum); })).toBeUndefined();
  expect(reads).toBe(1);
});
test("TECH — absent resident endpoints remain unavailable while malformed published bytes fail closed", () => {
  const ws = workspace(); expect(readResidentEndpoint(ws.configHome)).toBeUndefined();
  ws.write("home/config/resident-endpoint.json", "{incomplete");
  expect(() => readResidentEndpoint(ws.configHome)).toThrow();
});
test("TECH — a resident endpoint access denial is never treated as an absent service", () => {
  const ws = workspace(); ws.write("home/config/resident-endpoint.json", "{}");
  expect(() => readResidentEndpoint(ws.configHome, () => { throw Object.assign(new Error("Access denied fixture."), { code: "EACCES" }); })).toThrow("Access denied fixture");
});
