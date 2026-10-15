// Supports: SPEC-MOT-026, SPEC-CMD-026.
import { expect, test } from "bun:test";
import { FastOutput } from "../src/providers/fast-output";
import { ProviderError, type ModelProvider } from "../src/providers/types";
import { cli, workspace, testModel as model, loadCatalog } from "./helpers/env";
import { companyFixture } from "./helpers/company";
import { ModelCatalog } from "../src/providers/catalog";
import { ScriptedProvider } from "./helpers/scripted-provider";
const signal = new AbortController().signal;
test("SPEC-MOT-026/CA-01 — rate limiting falls back without ending the turn and automatically resumes after cooldown", async () => {
  let now = 0;
  const seen: unknown[] = [];
  let fail = true;
  const source = new ScriptedProvider([
    { text: "fallback" },
    { text: "fast again" },
  ]);
  const service: ModelProvider = {
    id: "fixture",
    async *stream(request, scope) {
      seen.push(request.serviceOptions);
      if (request.serviceOptions && fail) {
        fail = false;
        throw new ProviderError("rate_limit", "busy", 429, 1000);
      }
      yield* source.stream(request, scope);
    },
  };
  const fast = new FastOutput(
    async () => ({ eligible: true }),
    () => {},
    () => now,
  );
  const selected = {
    ...model("medium"),
    providerOptions: { fastOutput: { value: "priority", multiplier: 2 } },
  };
  expect(await fast.set(true, selected, signal)).toContain("2");
  const p = fast.wrap(service);
  const request = {
    model: selected,
    system: [],
    tools: [],
    history: [],
    maxOutputTokens: 100,
    thinking: {
      enabled: false,
      mode: "budget" as const,
      budgetTokens: 0,
      showSummaries: false,
    },
  };
  for await (const _ of p.stream(request, signal)) {
  }
  expect(fast.state).toBe("cooldown");
  now = 1001;
  for await (const _ of p.stream(request, signal)) {
  }
  expect(seen).toEqual([
    { service_tier: "priority" },
    undefined,
    { service_tier: "priority" },
  ]);
  expect(fast.state).toBe("active");
});
test("SPEC-MOT-026/CA-02 — an organization denial includes the reason and sends no accelerated request", async () => {
  const fast = new FastOutput(
    async () => ({ eligible: false, reason: "contrat organisation absent" }),
    () => {},
  );
  expect(
    await fast.set(
      true,
      {
        ...model("medium"),
        providerOptions: { fastOutput: { value: "priority", multiplier: 2 } },
      },
      signal,
    ),
  ).toContain("contrat organisation absent");
  expect(fast.state).toBe("off");
});
test("SPEC-CMD-026/CA-01 — the actual command explains an unavailable account offer", async () => {
  const result = await cli(
    ["--non-interactive", "/fast-output on"],
    workspace(),
    { provider: new ScriptedProvider([]) },
  );
  expect(result.stdout + result.stderr).toContain("Mode rapide indisponible");
});
test("TECH — the CLI checks the contract and labels accelerated usage with its declared surcharge", async () => {
  const f = companyFixture();
  await f.login();
  f.handle((path) =>
    path.endsWith("/models/fast-output") ? { eligible: true } : undefined,
  );
  const catalog = new ModelCatalog({
    schemaVersion: 1,
    currency: "USD",
    models: loadCatalog().entries.map((entry) =>
      entry.id === "test-large"
        ? {
            ...entry,
            providerOptions: {
              fastOutput: { value: "priority", multiplier: 2 },
            },
          }
        : entry,
    ),
  });
  const p = new ScriptedProvider([
    { text: "done", usage: { input: 1000, output: 1000 } },
  ]);
  const result = await cli(
    [
      "--non-interactive",
      "--model",
      "large",
      "--result-format",
      "json",
      "question",
    ],
    f.ws,
    {
      identity: f.identity,
      provider: p,
      userConfig: { models: { fastOutput: { enabled: true } } },
      extra: { catalog, companyFetch: f.network, credentialVault: f.vault },
    },
  );
  expect(result.code).toBe(0);
  expect(p.requests[0]!.serviceOptions).toEqual({ service_tier: "priority" });
  expect(result.stderr).toContain("multiplié par 2");
  const pricing = catalog.find("openai_compatible", "test-large")!.pricing!;
  expect(JSON.parse(result.stdout).cost.confirmed).toBeCloseTo(
    (2 * (pricing.inputPerMTok + pricing.outputPerMTok)) / 1000,
    8,
  );
  const resumedProvider = new ScriptedProvider([]),
    resumed = await cli(
      [
        "--non-interactive",
        "--reopen=" + JSON.parse(result.stdout).sessionId,
        "/spending",
      ],
      f.ws,
      {
        identity: f.identity,
        provider: resumedProvider,
        userConfig: { models: { fastOutput: { enabled: false } } },
        extra: { catalog, companyFetch: f.network, credentialVault: f.vault },
      },
    );
  expect(resumed.code).toBe(0);
  expect(resumedProvider.requests).toHaveLength(0);
  expect(resumed.stdout).toContain(
    `test-large : 1 requête, 1000 jetons en entrée, 1000 en sortie — ≈ ${((2 * (pricing.inputPerMTok + pricing.outputPerMTok)) / 1000).toFixed(4)}`,
  );
});
test("TECH — disconnecting the authorized account turns acceleration off before any provider call", async () => {
  let authorized = true;
  const source = new ScriptedProvider([{ text: "normal" }]);
  const fast = new FastOutput(
    async () => ({ eligible: true }),
    () => {},
    Date.now,
    async () => authorized,
  );
  const selected = {
    ...model("medium"),
    providerOptions: { fastOutput: { value: "priority", multiplier: 2 } },
  };
  await fast.set(true, selected, signal);
  authorized = false;
  for await (const _ of fast.wrap(source).stream(
    {
      model: selected,
      system: [],
      tools: [],
      history: [],
      maxOutputTokens: 100,
      thinking: {
        enabled: false,
        mode: "budget",
        budgetTokens: 0,
        showSummaries: false,
      },
    },
    signal,
  )) {
  }
  expect(fast.state).toBe("off");
  expect(source.requests[0]!.serviceOptions).toBeUndefined();
});
