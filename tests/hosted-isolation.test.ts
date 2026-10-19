// Supports: SPEC-API-029 (fail closed before assigning any hosted identity).
import { test, expect } from "bun:test";
import { confirmHostedStop, hostedSessionIsolation } from "../src/platform/hosted-isolation";
test("TECH — a hosted worker cannot fall back to its supervisor identity when isolation is unspecified", () => {
  expect(() => hostedSessionIsolation(undefined)).toThrow("plage UID réservée");
});
test("TECH — a hosted worker refuses system identities and invalid allocation ranges before touching a registry", () => {
  for (const range of [{ firstUid: 0, lastUid: 1000 }, { firstUid: 65536, lastUid: 65535 }, { firstUid: 65536.5, lastUid: 65537 }, { firstUid: 65536, lastUid: Number.MAX_SAFE_INTEGER }]) expect(() => hostedSessionIsolation(range)).toThrow("plage UID réservée");
});
test("TECH — a successful kill command is insufficient until the kernel inspection finds no live process", () => {
  let kills = 0, inspections = 0, time = 0;
  confirmHostedStop({ kill: () => { kills++; }, running: () => ++inspections < 3, now: () => time, wait: () => { time += 25; } });
  expect(kills).toBe(3); expect(inspections).toBe(3);
});
test("TECH — persistent processes or an impossible kernel inspection fail closed after bounded termination", () => {
  let time = 0;
  expect(() => confirmHostedStop({ kill: () => {}, running: () => true, now: () => time, wait: () => { time += 500; } })).toThrow("non confirmé");
  expect(time).toBe(2000);
  expect(() => confirmHostedStop({ kill: () => {}, running: () => { throw Error("procfs unavailable"); } })).toThrow("procfs unavailable");
});
