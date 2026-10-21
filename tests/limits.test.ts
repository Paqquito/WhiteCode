// Execution limits, cost cap and budget admission (SPEC-MOD-005), effort levels (SPEC-MOT-025).
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BudgetLedger, formatAmount, requestBound } from "../src/engine/budget";
import { RunLimits } from "../src/engine/limits";
import { runTurn } from "../src/engine/loop";
import { NEUTRAL_HOOKS } from "../src/extension-points/hooks";
import type { ApiEffort } from "../src/providers/catalog";
import { cli, loadIdentity, testModel, workspace } from "./helpers/env";
import { bench, probe } from "./helpers/engine";
import { ScriptedProvider } from "./helpers/scripted-provider";

const identity = loadIdentity();
const tool = (n: number) => ({ text: `step ${n}`, toolCalls: [{ name: "read_file", input: { path: `/nowhere/${n}.txt` } }] });
const json = (stdout: string) => JSON.parse(stdout) as Record<string, any>;

describe("SPEC-MOD-005 limits", () => {
  test("TECH — shared stops keep their cause across the prompt gate and an after-tool hook", async () => {
    for (const phase of ["prompt", "tool"] as const) {
      const limits = new RunLimits({ maxIterations: phase === "prompt" ? 1 : 2 });
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => { enter = resolve; });
      const released = new Promise<void>((resolve) => { release = resolve; });
      const parent = bench(phase === "prompt" ? [] : [{ text: "partial", toolCalls: [{ name: "probe", input: {} }] }], {
        tools: [probe("probe")], deps: { limits }, hooks: { ...NEUTRAL_HOOKS,
          ...(phase === "prompt" ? { promptSubmitted: async () => { enter(); await released; return { block: "blocked" }; } } : { afterTool: async () => { enter(); await released; return { stopTurn: true }; } }),
        },
      });
      const pending = runTurn(parent.deps, "parent", new AbortController().signal);
      await entered;
      const child = bench([tool(1)], { deps: { limits } });
      await runTurn(child.deps, "child", new AbortController().signal);
      release();
      expect((await pending).stopCause).toBe("iteration_limit");
      expect(parent.events.find((event) => event.type === "turn_completed")).toMatchObject({ result: { stopCause: "iteration_limit" } });
      if (phase === "prompt") expect(parent.conversation.messages).toHaveLength(0);
      else expect(parent.toolResults()).toHaveLength(1);
    }
  });

  test("TECH — a nested agent cannot receive more iterations than its own caller's limit", async () => {
    const ws = workspace();
    for (const [name, cap] of [["one", 1], ["five", 5]] as const) ws.write(`home/config/agents/${name}.md`, `---\nname: ${name}\ndescription: Limited agent.\nmaxIterations: ${cap}\n---\nPerform the task.\n`);
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { role: "one", description: "child", prompt: "go" } }] }, { text: "done" }], [
      { toolCalls: [{ name: "spawn_agent", input: { role: "five", description: "grandchild", prompt: "go" } }] }, tool(1), { text: "cannot receive more turns" },
    ]);
    const r = await cli(["--non-interactive", "--max-iterations", "10", "go"], ws, { provider, userConfig: { agents: { maxDepth: 3 } } });
    expect(r.code).toBe(0);
    const children = provider.requests.filter((request) => request.purpose === "subagent");
    expect(children).toHaveLength(2);
    expect(new Set(children.map((request) => request.agent)).size).toBe(2);
  });

  test("TECH — a shared stop during the final hook cannot produce a successful turn or event", async () => {
    const limits = new RunLimits({ maxIterations: 2 });
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const parent = bench([{ text: "parent answer" }], { deps: { limits }, hooks: { ...NEUTRAL_HOOKS, turnCompleted: async () => { enter(); await released; return {}; } } });
    const pending = runTurn(parent.deps, "parent", new AbortController().signal);
    await entered;
    const child = bench([tool(1)], { deps: { limits } });
    expect((await runTurn(child.deps, "child", new AbortController().signal)).stopCause).toBe("iteration_limit");
    release();
    expect((await pending).stopCause).toBe("iteration_limit");
    expect(parent.events.find((event) => event.type === "turn_completed")).toMatchObject({ result: { stopCause: "iteration_limit" } });
  });

  test("TECH — an empty failed child's authentication diagnostic reaches the parent in English", async () => {
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { role: "general", description: "child", prompt: "go" } }] }, { text: "done" }], [{ error: { kind: "authentication", status: 401, message: "Authentification refusée par le serveur du modèle." } }]);
    const r = await cli(["--non-interactive", "go"], workspace(), { provider });
    expect(r.code).toBe(0);
    const history = JSON.stringify(provider.requests.at(-1)!.history);
    expect(history).toContain("Check the API credentials");
    expect(history).not.toContain("Clé d'API refusée");
    expect(history).not.toContain("Authentification refusée");
  });

  test("TECH — a child's partial report exposes its local halt cause as an unsuccessful tool result", async () => {
    const ws = workspace(); ws.write("home/config/agents/one.md", '---\nname: one\ndescription: One request.\nmaxIterations: 1\n---\nPerform one request.\n');
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { role: "one", description: "child", prompt: "go" } }] }, { text: "parent done" }], [{ ...tool(1), text: "I still need to verify the change." }]);
    const r = await cli(["--non-interactive", "--max-iterations", "10", "go"], ws, { provider });
    expect(r.code).toBe(0);
    const result = provider.requests.at(-1)!.history.flatMap((message) => message.role === "user" ? message.parts : []).find((part) => part.type === "tool_result");
    expect(result).toMatchObject({ isError: true });
    expect(JSON.stringify(result)).toContain("iteration_limit");
    expect(JSON.stringify(result)).toContain("Partial report follows.");
    expect(JSON.stringify(result)).toContain("I still need to verify the change.");
  });

  test("SPEC-MOD-005/CA-04 — an unavailable primary model switches to the backup, including result and transcript metadata", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([{ error: { kind: "overloaded", retryAfterMs: 0 } }, { text: "backup result" }]);
    const r = await cli(["--non-interactive", "--model", "large", "--backup-model", "small", "--result-format", "json", "go"], ws, { provider, userConfig: { models: { fallbackAfterOverloads: 1 } } });
    expect(r.code).toBe(0);
    expect(provider.requests.map((request) => request.model.id)).toEqual(["test-large", "test-small"]);
    expect(json(r.stdout)).toMatchObject({ model: "test-small", result: "backup result" });
    expect(r.stderr).toContain("modèle de repli test-small");
    const sessions = join(ws.configHome, "sessions");
    const files = readdirSync(sessions, { recursive: true }).map(String).filter((file) => file.endsWith(".jsonl"));
    const records = readFileSync(join(sessions, files[0]!), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(records.some((record) => record.data.event === "fallback" && record.data.from === "test-large" && record.data.to === "test-small")).toBe(true);
  });

  test("SPEC-MOD-005/CA-05 — the parent and two concurrent children share the limit, including requests still in flight", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [1, 2].map((n) => ({ name: "spawn_agent", input: { role: "general", description: `child ${n}`, prompt: `task ${n}` } })) },
      { text: "parent must not request again" },
    ], [{ ...tool(1), delayMs: 30 }, { ...tool(2), delayMs: 30 }, { text: "no child remainder" }]);
    const r = await cli(["--non-interactive", "--max-iterations", "3", "--result-format", "json", "go"], workspace(), { provider });
    expect(provider.requests).toHaveLength(3);
    expect(provider.requests.filter((request) => request.purpose === "subagent")).toHaveLength(2);
    expect(r.code).toBe(3);
    expect(json(r.stdout)).toMatchObject({ haltReason: "iteration_limit", iterations: 3 });
  });

  test("SPEC-MOD-005/CA-14 — a user's zero price cannot override the administrator's pricing base under a managed cap", async () => {
    const ws = workspace(); ws.write("managed/policy.json", JSON.stringify({ engine: { limits: { maxCost: 0.001 } } }));
    const provider = new ScriptedProvider([{ text: "must not be sent" }]);
    const r = await cli(["--non-interactive", "--model", "large", "--result-format", "json", "go"], ws, { provider, userConfig: { cost: { priceOverrides: { "test-large": { inputPerMTok: 0, outputPerMTok: 0, cacheReadPerMTok: 0, cacheWritePerMTok: 0 } } } } });
    expect(r.code).toBe(3);
    expect(provider.requests).toHaveLength(0);
    expect(json(r.stdout)).toMatchObject({ haltReason: "budget_limit", cost: { cap: 0.001, confirmed: 0 } });
  });

  test("TECH — a child's own iteration limit applies while the shared execution still has room", async () => {
    const ws = workspace(); ws.write("home/config/agents/one.md", '---\nname: one\ndescription: One request.\nmaxIterations: 1\n---\nPerform one request.\n');
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "spawn_agent", input: { role: "one", description: "one child", prompt: "go" } }] }, { text: "parent done" }], [tool(1), { text: "child must not request again" }]);
    const r = await cli(["--non-interactive", "--max-iterations", "10", "go"], ws, { provider });
    expect(r.code).toBe(0); expect(provider.requests.filter((request) => request.purpose === "subagent")).toHaveLength(1);
  });

  test("TECH — retries also consume a shared request slot and cannot cross the iteration cap", async () => {
    const provider = new ScriptedProvider([{ error: { kind: "server", retryAfterMs: 0 } }, { text: "must not retry" }]);
    const r = await cli(["--non-interactive", "--max-iterations", "1", "--result-format", "json", "go"], workspace(), { provider });
    expect(r.code).toBe(3); expect(provider.requests).toHaveLength(1);
    expect(json(r.stdout)).toMatchObject({ haltReason: "iteration_limit", iterations: 1 });
  });

  test("TECH — resuming the same child cannot replenish its own iteration limit", async () => {
    const ws = workspace(); ws.write("home/config/agents/one.md", '---\nname: one\ndescription: One request.\nmaxIterations: 1\n---\nPerform one request.\n');
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "spawn_agent", input: { role: "one", description: "limited child", prompt: "first" } }] },
      (request) => { const id = JSON.stringify(request.history).match(/agent-[a-f0-9]{8}/)?.[0]; expect(id).toBeDefined(); return { toolCalls: [{ name: "spawn_agent", input: { resume: id, description: "resume", prompt: "second" } }] }; },
      { text: "done" },
    ], [{ text: "child report" }, { text: "must not replenish" }]);
    const r = await cli(["--non-interactive", "--max-iterations", "10", "go"], ws, { provider });
    expect(r.code).toBe(0); expect(provider.requests.filter((request) => request.purpose === "subagent")).toHaveLength(1);
    expect(JSON.stringify(provider.requests.at(-1)?.history)).toContain("iteration_limit");
  });

  test("TECH — a failed final slot is reported in the turn and never waits for a futile retry", async () => {
    let sleeps = 0;
    const b = bench([{ error: { kind: "rate_limit", retryAfterMs: 3_600_000 } }, { text: "never" }], { deps: { limits: new RunLimits({ maxIterations: 1 }), retry: { maxRetries: 3, sleep: async () => { sleeps++; } } } });
    const r = await runTurn(b.deps, "go", new AbortController().signal);
    expect(r).toMatchObject({ stopCause: "iteration_limit", iterations: 1 });
    expect(sleeps).toBe(0); expect(b.provider.requests).toHaveLength(1);
    expect(b.events.find((event) => event.type === "turn_completed")).toMatchObject({ result: { iterations: 1 } });
  });

  test("TECH — a background child's global limit also stops its parent's in-flight request", async () => {
    const provider = new ScriptedProvider([
      { toolCalls: [{ name: "spawn_agent", input: { description: "background", prompt: "go", detached: true } }] },
      { text: "partial parent", delayMs: 200 },
    ], [{ ...tool(1), delayMs: 30 }, { text: "must not make fourth request" }]);
    const r = await cli(["--non-interactive", "--max-iterations", "3", "--result-format", "json", "go"], workspace(), { provider });
    expect(r.code).toBe(3); expect(provider.requests).toHaveLength(3);
    expect(json(r.stdout)).toMatchObject({ haltReason: "iteration_limit", iterations: 3 });
  });

  test("TECH — fallback admission uses the managed price even when the catalogue has no backup price", async () => {
    const ws = workspace(); ws.write("managed/policy.json", JSON.stringify({ engine: { limits: { maxCost: 10 } }, cost: { priceOverrides: { "test-small": { inputPerMTok: 1_000_000, outputPerMTok: 1_000_000, cacheReadPerMTok: 1_000_000, cacheWritePerMTok: 1_000_000 } } } }));
    const provider = new ScriptedProvider([{ error: { kind: "overloaded", retryAfterMs: 0 } }, { text: "must not evade managed price" }]);
    const r = await cli(["--non-interactive", "--model", "large", "--backup-model", "small", "--result-format", "json", "go"], ws, { provider, userConfig: { models: { fallbackAfterOverloads: 1 } } });
    expect(r.code).toBe(3); expect(provider.requests).toHaveLength(1);
    expect(json(r.stdout)).toMatchObject({ haltReason: "budget_limit", cost: { cap: 10 } });
    expect(r.stderr).toContain("modèle de repli test-small");
  });

  test("SPEC-MOD-005/CA-01 — a limit of 3 iterations and a fourth requested: the run stops on the iteration limit with a partial result", async () => {
    const provider = new ScriptedProvider([tool(1), tool(2), tool(3), tool(4), { text: "never" }]);
    const r = await cli(["--non-interactive", "--max-iterations", "3", "--result-format", "json", "go"], workspace(), { provider });
    expect(r.code).toBe(3);
    expect(json(r.stdout)).toMatchObject({ haltReason: "iteration_limit", iterations: 3, result: "step 3" });
    expect(provider.requests).toHaveLength(3);
  });

  test("SPEC-MOD-005/CA-02 — a budget almost used: the next request would exceed it, so it is not sent and the budget cause is reported", async () => {
    // First answer: 1 M input tokens at 4 USD/M = 4 USD; cap 4.10: the bound of the second request no longer fits.
    const provider = new ScriptedProvider([{ ...tool(1), usage: { input: 1_000_000, output: 0 } }, { text: "never" }]);
    const r = await cli(["--non-interactive", "--model", "large", "--max-cost", "4.10", "--result-format", "json", "go"], workspace(), { provider });
    expect(provider.requests).toHaveLength(1);
    expect(r.code).toBe(3);
    const doc = json(r.stdout);
    expect(doc).toMatchObject({ haltReason: "budget_limit", cost: { currency: "USD", confirmed: 4, conservative: 4, reserved: 0, cap: 4.1 } });
    expect(doc["message"]).toContain("Budget atteint");
    expect(r.stderr).toContain("Plafond de coût : 4,10 USD.");
  });

  test("SPEC-MOD-005/CA-03 — a managed limit of 10 iterations and 100 requested: the effective limit is 10, with a warning", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ engine: { limits: { maxIterations: 10 } } }));
    const provider = new ScriptedProvider(Array.from({ length: 12 }, (_, i) => tool(i + 1)));
    const r = await cli(["--non-interactive", "--max-iterations", "100", "go"], ws, { provider });
    expect(r.stderr).toContain("limite réduite par la politique en vigueur (itérations : 10)");
    expect(provider.requests).toHaveLength(10);
    expect(r.code).toBe(3);
  });

  test("SPEC-MOD-005/CA-06 — a duration limit: the run is stopped cleanly and its state stays resumable", async () => {
    const ws = workspace();
    const provider = new ScriptedProvider([tool(1), { hang: true }]);
    const started = Date.now();
    const r = await cli(["--non-interactive", "--max-duration", "1", "--result-format", "json", "go"], ws, { provider });
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.code).toBe(3);
    expect(json(r.stdout)).toMatchObject({ haltReason: "duration_limit", result: "step 1" });
    // The transcript is closed with the cause: the session can be resumed.
    const sessions = join(ws.configHome, "sessions");
    const files = readdirSync(sessions, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"));
    const lines = readFileSync(join(sessions, files[0]!), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.some((l) => l.type === "system" && l.data?.event === "turn_end" && l.data?.stopCause === "duration_limit")).toBe(true);
  }, 20_000);

  test("SPEC-MOD-005/CA-07 — a cap and a model without price: explicit error before any billable call", async () => {
    const provider = new ScriptedProvider([{ text: "never" }]);
    const r = await cli(["--non-interactive", "--model", "medium", "--max-cost", "5", "go"], workspace(), { provider });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Le plafond de coût ne peut pas être garanti pour ce modèle");
    expect(provider.requests).toHaveLength(0);
  });

  test("SPEC-MOD-005/CA-08 — a price override in another currency under a cap: rejected with a warning; without other price, ERR-05", async () => {
    const provider = new ScriptedProvider([{ text: "never" }]);
    const override = { "test-medium": { currency: "EUR", inputPerMTok: 1, outputPerMTok: 2, cacheReadPerMTok: 0.1, cacheWritePerMTok: 1.25 } };
    const r = await cli(["--non-interactive", "--model", "medium", "--max-cost", "5", "go"], workspace(), { provider, userConfig: { cost: { priceOverrides: override } } });
    expect(r.stderr).toContain("devise EUR différente de la devise de référence USD");
    expect(r.stderr).toContain("Le plafond de coût ne peut pas être garanti");
    expect(r.code).toBe(2);
    expect(provider.requests).toHaveLength(0);
    // In the reference currency, the override is used and the cap holds.
    const ok = await cli(["--non-interactive", "--model", "medium", "--max-cost", "5", "go"], workspace(), { provider: new ScriptedProvider([{ text: "fine" }]), userConfig: { cost: { priceOverrides: { "test-medium": { ...override["test-medium"], currency: "USD" } } } } });
    expect(ok.code).toBe(0);
  });

  test("SPEC-MOD-005/CA-19 — --max-cost 2,50 or 2.50 EUR: rejected with the expected usage, no request sent", async () => {
    for (const value of ["2,50", "2.50 EUR"]) {
      const provider = new ScriptedProvider([{ text: "never" }]);
      const r = await cli(["--non-interactive", "--model", "large", "--max-cost", value, "go"], workspace(), { provider });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("2.50");
      expect(provider.requests).toHaveLength(0);
    }
  });
});

describe("SPEC-MOD-005 budget ledger", () => {
  const request = () => ({
    model: testModel("large"),
    system: [{ text: "s" }],
    tools: [],
    history: [{ role: "user" as const, parts: [{ type: "text" as const, text: "hello" }] }],
    maxOutputTokens: 1000,
    thinking: { enabled: false, mode: "adaptive" as const, budgetTokens: 1, showSummaries: false },
  });

  test("SPEC-MOD-005/CA-09 — a cost the provider cannot bound: the call is refused under a cap", () => {
    const ledger = new BudgetLedger(10, "USD");
    expect(requestBound(request(), undefined)).toBeUndefined();
    expect(ledger.admit(undefined, "main")).toMatchObject({ admitted: false, reason: "cost_cap_unverifiable" });
    expect(new BudgetLedger(undefined, "USD").admit(undefined, "main").admitted).toBe(true);
  });

  test("SPEC-MOD-005/CA-10 — two sub-agents claiming the last remainder at the same time: only one is admitted", async () => {
    const ledger = new BudgetLedger(1, "USD");
    const [a, b] = await Promise.all([Promise.resolve().then(() => ledger.admit(0.6, "sub-1")), Promise.resolve().then(() => ledger.admit(0.6, "sub-2"))]);
    expect([a.admitted, b.admitted].filter(Boolean)).toHaveLength(1);
    expect(ledger.snapshot.reserved).toBeCloseTo(0.6);
  });

  test("SPEC-MOD-005/CA-11 — a response without usage information: the reserved bound stays counted conservatively", async () => {
    const ledger = new BudgetLedger(100, "USD");
    const b = bench([{ text: "no usage", noUsage: true }], { model: "large", deps: { limits: new RunLimits({ ledger }) } });
    const r = await runTurn(b.deps, "x", new AbortController().signal);
    const bound = requestBound(b.provider.requests[0]!, testModel("large").pricing)!;
    expect(ledger.snapshot).toMatchObject({ confirmed: 0, reserved: 0 });
    expect(ledger.snapshot.conservative).toBeCloseTo(bound, 10);
    expect(r.cost.confirmed).toBeUndefined();
  });

  test("SPEC-MOD-005/CA-12 — a cancelled call that may have been billed: the reservation stays committed", async () => {
    const ledger = new BudgetLedger(100, "USD");
    const b = bench([{ hang: true }], { model: "large", deps: { limits: new RunLimits({ ledger }) } });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const r = await runTurn(b.deps, "x", controller.signal);
    expect(r.stopCause).toBe("interrupted");
    expect(ledger.snapshot.reserved).toBe(0);
    expect(ledger.snapshot.conservative).toBeGreaterThan(0);
  });

  test("SPEC-MOD-005/CA-13 — a new attempt gets its own reservation", async () => {
    const ledger = new BudgetLedger(100, "USD");
    const admitted: string[] = [];
    const original = ledger.admit.bind(ledger);
    ledger.admit = (bound, consumer) => {
      admitted.push(consumer);
      return original(bound, consumer);
    };
    const b = bench([{ error: { kind: "server", status: 500 } }, { text: "ok", usage: { input: 1000, output: 10 } }], { model: "large", deps: { limits: new RunLimits({ ledger }), retry: { maxRetries: 3, sleep: async () => undefined } } });
    await runTurn(b.deps, "x", new AbortController().signal);
    expect(admitted).toEqual(["main", "main"]);
    const s = ledger.snapshot;
    expect(s.confirmed).toBeCloseTo((1000 * 4 + 10 * 20) / 1_000_000, 10);
    expect(s.conservative).toBeGreaterThan(s.confirmed); // the failed attempt stays counted
  });

  test("SPEC-MOD-005/CA-17 — a cap of 2 in EUR is displayed as 2,00 EUR", () => {
    expect(formatAmount(2, "EUR")).toBe("2,00 EUR");
    const ledger = new BudgetLedger(2, "EUR");
    ledger.admit(1.5, "main");
    const refused = ledger.admit(1, "main");
    expect(refused.admitted === false && refused.message).toContain("plafond de 2,00 EUR");
  });

  test("TECH — SPEC-MOD-005/FA-06 — at 80 % of a limit, a warning and a note asking the model to converge", async () => {
    const t = (n: number) => ({ toolCalls: [{ name: "read_file", input: { path: `/x/${n}` } }] });
    const b = bench([t(1), t(2), t(3), t(4), t(5), { text: "end" }], { deps: { limits: new RunLimits({ maxIterations: 5 }) } });
    await runTurn(b.deps, "x", new AbortController().signal);
    expect(b.events.filter((e) => e.type === "warning").map((e) => (e as { message: string }).message)).toEqual(["Itérations : 80 % de la limite atteints."]);
    expect(b.conversation.messages.filter((m) => m.role === "system_note")).toHaveLength(1);
  });
});

describe("SPEC-MOT-025 effort", () => {
  const anthropic = { api: { provider: "anthropic", baseUrl: null } };
  const env = { ANTHROPIC_API_KEY: "test-key" };

  test("SPEC-MOT-025/CA-01 — max chosen for the session: the next session starts at the default level", async () => {
    const first = new ScriptedProvider([{ text: "a" }]);
    await cli(["--non-interactive", "--model", "vendor-always", "x"], workspace(), { provider: first, env, userConfig: anthropic, extra: { onSession: (s) => s.setEffort("max" as ApiEffort) } });
    expect(first.requests[0]!.effort).toBe("max");
    const next = new ScriptedProvider([{ text: "b" }]);
    await cli(["--non-interactive", "--model", "vendor-always", "x"], workspace(), { provider: next, env, userConfig: anthropic });
    expect(next.requests[0]!.effort).toBe("high");
  });

  test("SPEC-MOT-025/CA-02 — a model without max and max chosen: high is applied, with a mention", async () => {
    const provider = new ScriptedProvider([{ text: "a" }]);
    const r = await cli(["--non-interactive", "--model", "vendor-optional", "x"], workspace(), { provider, env, userConfig: anthropic, extra: { onSession: (s) => s.setEffort("max" as ApiEffort) } });
    expect(provider.requests[0]!.effort).toBe("high");
    expect(r.stderr).toContain("n'accepte pas le niveau d'effort max : high est appliqué");
  });
});

test("TECH — the identity is untouched by limits", () => {
  expect(identity.get("PRODUCT")).toBe("Pilote Dev");
  expect(existsSync(join(import.meta.dir, "fixtures", "test.models.json"))).toBe(true);
});
