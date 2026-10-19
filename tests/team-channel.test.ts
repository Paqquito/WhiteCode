import { expect, test } from "bun:test";
import { join } from "node:path";
import { TeamChannel } from "../src/agents/team-channel";
import { workspace } from "./helpers/env";
import { waitForTeamLeader } from "../src/agents/team-worker";

test("TECH — team IPC authenticates peers and transports bounded chunks without duplicate execution", async () => {
  const root = workspace().root, folder = join(root, "ipc"); let calls = 0;
  const a = new TeamChannel(folder, root, "a", async () => { throw new Error("Refused"); });
  const b = new TeamChannel(folder, root, "b", async (from, method, value) => { expect(from).toBe(a.self()); expect(method).toBe("echo"); calls++; return value; });
  try { await Promise.all([a.ready, b.ready]); const text = "CHUNK_WITNESS".repeat(18000); expect(await a.request(b.self(), "echo", { text }, AbortSignal.timeout(10000))).toEqual({ text }); expect(calls).toBe(1); await expect(a.request(b.self(), "echo", "x".repeat(17 * 1024 * 1024), AbortSignal.timeout(10000))).rejects.toThrow(); expect(calls).toBe(1); }
  finally { await a.close(); await b.close(); }
});

test("TECH — a disconnected request fails without replaying an uncertain action", async () => {
  const root = workspace().root, folder = join(root, "ipc"); let calls = 0;
  const a = new TeamChannel(folder, root, "a", async () => true), b = new TeamChannel(folder, root, "b", async () => { calls++; await new Promise(resolve => setTimeout(resolve, 100)); return true; });
  try { await Promise.all([a.ready, b.ready]); const request = a.request(b.self(), "action", {}, AbortSignal.timeout(1000)); await new Promise(resolve => setTimeout(resolve, 30)); a.disconnected(b.self()); await expect(request).rejects.toThrow("not replayed"); expect(calls).toBe(1); }
  finally { await a.close(); await b.close(); }
});

test("TECH — cancelling one team RPC revokes its live remote handler", async () => {
  const root = workspace().root, folder = join(root, "ipc"); let invoked = 0, revoked = false;
  const a = new TeamChannel(folder, root, "a", async () => true), b = new TeamChannel(folder, root, "b", async (_from, _method, _value, signal) => { invoked++; await new Promise<void>(resolve => { signal.addEventListener("abort", () => { revoked = true; resolve(); }, { once: true }); }); return true; });
  try { await Promise.all([a.ready, b.ready]); await expect(a.request(b.self(), "action", {}, AbortSignal.timeout(100))).rejects.toThrow("not replayed"); for (let n = 0; n < 50 && !revoked; n++) await new Promise(resolve => setTimeout(resolve, 10)); expect(invoked).toBe(1); expect(revoked).toBe(true); }
  finally { await a.close(); await b.close(); }
});

test("TECH — an individual call cancels while no leader is available before the orphan lifetime", async () => {
  const life = new AbortController(), started = Date.now(); let discoveries = 0;
  await expect(waitForTeamLeader(() => { discoveries++; return undefined; }, life.signal, AbortSignal.timeout(20))).rejects.toThrow();
  expect(Date.now() - started).toBeLessThan(200); expect(life.signal.aborted).toBe(false); expect(discoveries).toBeGreaterThan(0);
});
