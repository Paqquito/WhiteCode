// Supports: SPEC-API-009, SPEC-MOT-026, SPEC-OBS-018.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { FastOutput } from "../src/providers/fast-output";
import { withApiRecording } from "../src/providers/api-recording";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { workspace, testModel, loadCatalog } from "./helpers/env";
import { companyFixture } from "./helpers/company";
import { Host } from "./helpers/control";
import { ModelCatalog } from "../src/providers/catalog";
const signal = new AbortController().signal;
test("TECH — API references distinguish fast and standard requests and apply the surcharge once on replay", async () => {
  const ws = workspace(),
    source = new ScriptedProvider([{ text: "fast" }, { text: "standard" }]);
  const fast = new FastOutput(
      async () => ({ eligible: true }),
      () => {},
    ),
    model = {
      ...testModel("medium"),
      providerOptions: { fastOutput: { value: "priority", multiplier: 2 } },
    };
  const provider = fast.wrap(
    withApiRecording(source, {
      mode: "auto",
      directory: join(ws.root, "recordings"),
      secrets: [],
    }),
  );
  const request = {
    model,
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
  const sample = async () => {
    const events = [];
    for await (const event of provider.stream(request, signal))
      events.push(event);
    return events;
  };
  await fast.set(true, model, signal);
  expect(JSON.stringify(await sample())).toContain("fast");
  await fast.set(false, model, signal);
  expect(JSON.stringify(await sample())).toContain("standard");
  await fast.set(true, model, signal);
  const replay = await sample();
  expect(source.requests).toHaveLength(2);
  expect(
    replay.find((event) => event.type === "message_complete")
      ?.serviceCostMultiplier,
  ).toBe(2);
});
test("TECH — a delayed eligibility answer cannot reactivate fast mode after the user switches it off", async () => {
  let release!: (value: { eligible: boolean }) => void;
  const gate = new Promise<{ eligible: boolean }>((r) => (release = r));
  const fast = new FastOutput(
      () => gate,
      () => {},
    ),
    model = {
      ...testModel("medium"),
      providerOptions: { fastOutput: { value: "priority", multiplier: 2 } },
    };
  const pending = fast.set(true, model, signal);
  await fast.set(false, model, signal);
  release({ eligible: true });
  await pending;
  expect(fast.state).toBe("off");
});
test("TECH — a late extended-model result cannot overwrite the user's newer model selection", async () => {
  const f = companyFixture();
  await f.login();
  let release!: (value: unknown) => void, entered!: () => void;
  const gate = new Promise((r) => (release = r)),
    started = new Promise<void>((r) => (entered = r));
  f.handle((path) => {
    if (path.endsWith("/models/eligibility")) {
      entered();
      return gate;
    }
    return undefined;
  });
  const catalog = new ModelCatalog({
    schemaVersion: 1,
    currency: "USD",
    models: [
      ...loadCatalog().entries.map((entry) =>
        entry.id === "test-large"
          ? { ...entry, extended: { model: "wide", eligibility: "account" } }
          : entry,
      ),
      {
        id: "wide",
        provider: "openai_compatible",
        family: "test",
        label: "Wide",
        contextWindow: 1000000,
        maxOutputTokens: 1000,
        capabilities: { toolCalling: true },
      },
    ],
  });
  const p = new ScriptedProvider([{ text: "selected" }]),
    h = new Host(f.ws, {
      identity: f.identity,
      provider: p,
      init: {},
      extra: { catalog, companyFetch: f.network, credentialVault: f.vault },
    });
  try {
    const pending = h.request("select_model", { model: "large-extended" });
    await started;
    await h.request("select_model", { model: "small" });
    release({ eligible: true });
    expect(JSON.stringify(await pending)).toContain("remplacé");
    h.user("answer");
    await h.waitFor((m) => m.type === "turn_completed");
    expect(p.requests[0]!.model.id).toBe("test-small");
  } finally {
    release({ eligible: false });
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
}, 20000);
