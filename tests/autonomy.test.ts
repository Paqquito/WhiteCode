import { expect, test } from "bun:test";
import { workspace } from "./helpers/env";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";
test("SPEC-MOD-027/CA-01 — an idle proactive session wakes and runs a normal turn after the configured interval", async () => {
  let now = Date.now(); const provider = new ScriptedProvider([{ text: "WAKE_ONE_48" }]);
  const run = interactive([], workspace(), { provider, userConfig: { modes: { proactive: { intervalMinutes: 1 } } }, extra: { now: () => new Date(now) } });
  try { await run.idle(); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif activé")); await sleep(300); now += 60001; await run.waitFor(text => text.includes("WAKE_ONE_48")); expect(provider.requests).toHaveLength(1); expect(JSON.stringify(provider.requests[0]!.history)).toContain("Ordinary permissions and budgets apply"); }
  finally { run.type(KEY.ctrlD); run.type(KEY.ctrlD); await run.done; }
});
test("SPEC-CMD-100/CA-01 — enabling proactive mode produces periodic wake signals and disabling stops them", async () => {
  let now = Date.now(); const provider = new ScriptedProvider([{ text: "PERIODIC_ONE_48" }, { text: "PERIODIC_TWO_48" }]);
  const run = interactive([], workspace(), { provider, userConfig: { modes: { proactive: { intervalMinutes: 1 } } }, extra: { now: () => new Date(now) } });
  try { await run.idle(); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif activé")); await sleep(300); now += 60001; await run.waitFor(text => text.includes("PERIODIC_ONE_48")); await sleep(300); now += 60001; await run.waitFor(text => text.includes("PERIODIC_TWO_48")); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif désactivé")); now += 1000000; await sleep(300); expect(provider.requests).toHaveLength(2); }
  finally { run.type(KEY.ctrlD); run.type(KEY.ctrlD); await run.done; }
});
test("SPEC-MOD-027/CA-02 — typing cancels the pending proactive wake and preserves the unsent draft", async () => {
  let now = Date.now(); const provider = new ScriptedProvider([]);
  const run = interactive([], workspace(), { provider, userConfig: { modes: { proactive: { intervalMinutes: 1 } } }, extra: { now: () => new Date(now) } });
  try { await run.idle(); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif activé")); await sleep(300); now += 50000; run.type("UNSENT_DRAFT_48"); now += 20000; await sleep(350); expect(provider.requests).toHaveLength(0); expect(run.screen().join("\n")).toContain("UNSENT_DRAFT_48"); }
  finally { run.type(KEY.ctrlC); run.type(KEY.ctrlC); run.type(KEY.ctrlD); run.type(KEY.ctrlD); await run.done; }
});
test("SPEC-OUT-023/CA-01 — a ten-minute wait wakes immediately on a submitted user message", async () => {
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "wait", input: { duration: 600 } }] }, request => { expect(JSON.stringify(request.history)).toContain('\\"cause\\":\\"message\\"'); return { text: "MESSAGE_WAKE_48" }; }]);
  const run = interactive(["--toolset", "wait"], workspace(), { provider, userConfig: { engine: { toolTimeout: "100ms" } } });
  try { await run.idle(); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif activé")); run.type("Wait for my next message.\r"); await run.waitFor(() => run.screen().join("\n").includes("en veille jusqu’à")); await sleep(150); expect(provider.requests).toHaveLength(1); const started = performance.now(); run.type("Wake on this message.\r"); await run.waitFor(text => text.includes("MESSAGE_WAKE_48")); expect(performance.now() - started).toBeLessThan(500); expect(provider.requests).toHaveLength(2); }
  finally { run.type(KEY.ctrlC); run.type(KEY.ctrlD); run.type(KEY.ctrlD); await run.done; }
});
test("SPEC-OUT-023/CA-02 — a wait runs with no shell tool or shell environment and ends on interruption", async () => {
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "wait", input: { duration: 600 } }] }]);
  const run = interactive(["--toolset", "wait"], workspace(), { provider });
  try { await run.idle(); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif activé")); run.type("Wait.\r"); await run.waitFor(() => run.screen().join("\n").includes("en veille jusqu’à")); await sleep(150); expect(provider.requests).toHaveLength(1); expect(provider.requests[0]!.tools.map(tool => tool.name)).toEqual(["wait"]); run.type(KEY.ctrlC); await run.waitFor(text => text.includes("Interrompu")); expect(provider.requests).toHaveLength(1); }
  finally { run.type(KEY.ctrlD); run.type(KEY.ctrlD); await run.done; }
});
test("TECH — proactive mode can be disabled immediately during a hanging turn without interrupting that turn", async () => {
  const provider = new ScriptedProvider([{ hang: true }]), controller = new AbortController();
  const run = interactive([], workspace(), { provider, signal: controller.signal });
  try { await run.idle(); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif activé")); run.type("Keep working.\r"); await run.waitFor(() => provider.requests.length === 1); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif désactivé")); expect(provider.requests).toHaveLength(1); expect(run.finished()).toBe(false); }
  finally { controller.abort(); await run.done; }
});
test("TECH — disabling proactive mode removes wait from the next model request", async () => {
  const provider = new ScriptedProvider([{ text: "ACTIVE_REQUEST_48" }, { text: "INACTIVE_REQUEST_48" }]);
  const run = interactive([], workspace(), { provider });
  try { await run.idle(); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif activé")); run.type("Check active tools.\r"); await run.waitFor(text => text.includes("ACTIVE_REQUEST_48")); expect(provider.requests[0]!.tools.some(tool => tool.name === "wait")).toBe(true); run.type("/proactive\r"); await run.waitFor(text => text.includes("Mode proactif désactivé")); run.type("Check inactive tools.\r"); await run.waitFor(text => text.includes("INACTIVE_REQUEST_48")); expect(provider.requests[1]!.tools.some(tool => tool.name === "wait")).toBe(false); }
  finally { run.type(KEY.ctrlD); run.type(KEY.ctrlD); await run.done; }
});
