import { expect, test } from "bun:test";
import { bench } from "./helpers/engine";
import { runTurn } from "../src/engine/loop";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-API-004/CA-01 — an unattended run waits through twenty minutes of rate limiting then completes", async () => {
  let now = 0; const waits: number[] = [];
  const b = bench([...Array.from({ length: 4 }, () => ({ error: { kind: "rate_limit" as const } })), { text: "CAPACITY_RECOVERED" }], { deps: { clock: () => now, retry: { maxRetries: 0, unattended: { maxWaitMs: 3600000, intervalMs: 300000 }, sleep: async ms => { waits.push(ms); now += ms; } } } });
  const result = await runTurn(b.deps, "Complete the scheduled work", new AbortController().signal);
  expect(result.stopCause).toBe("completed"); expect(result.finalText).toBe("CAPACITY_RECOVERED"); expect(now).toBe(1200000); expect(waits).toEqual([300000, 300000, 300000, 300000]); expect(b.events.filter(event => event.type === "capacity_wait")).toHaveLength(4);
});
test("SPEC-API-004/CA-02 — an interactive run retains its ordinary retry policy", async () => {
  let waits = 0;
  const b = bench([{ error: { kind: "rate_limit" } }, { text: "MUST_NOT_RETRY" }], { deps: { retry: { maxRetries: 0, sleep: async () => { waits++; } } } });
  expect((await runTurn(b.deps, "Work", new AbortController().signal)).stopCause).toBe("error"); expect(waits).toBe(0); expect(b.provider.requests).toHaveLength(1);
});
test("TECH — an unattended wait cannot exceed its deadline or replay a partial answer", async () => {
  for (const partial of [false, true]) {
    let now = 0;
    const b = bench([{ ...(partial ? { text: "PARTIAL_EVIDENCE" } : {}), error: { kind: "rate_limit" } }, { error: { kind: "rate_limit" } }], { deps: { clock: () => now, retry: { maxRetries: 0, unattended: { maxWaitMs: 100, intervalMs: 100 }, sleep: async ms => { now += ms; } } } });
    expect((await runTurn(b.deps, "Work", new AbortController().signal)).stopCause).toBe("error"); expect(now).toBe(partial ? 0 : 100); expect(b.provider.requests).toHaveLength(partial ? 1 : 2);
  }
});

test("TECH — the real automated driver activates capacity waiting only for its explicit launch option", async () => {
  for (const enabled of [false, true]) {
    const provider = new ScriptedProvider([{ error: { kind: "rate_limit" } }, { text: "DRIVER_CAPACITY_RECOVERED" }]);
    const result = await cli(["--non-interactive", ...(enabled ? ["--wait-for-capacity"] : []), "Work"], workspace(), { provider, userConfig: { api: { maxRetries: 0, unattendedRetry: { maxWait: 100, interval: 1 } } } });
    expect(provider.requests).toHaveLength(enabled ? 2 : 1); expect(result.code === 0).toBe(enabled);
    if (enabled) { expect(result.stdout).toContain("DRIVER_CAPACITY_RECOVERED"); expect(result.stderr).toContain("En attente de capacité"); }
  }
});
