// Supports: SPEC-API-009.
import { expect, test } from "bun:test";
import { ModelCatalog, isResolveFailure } from "../src/providers/catalog";
import {
  cli,
  loadCatalog,
  loadIdentity,
  TEST_IDENTIFIER_MAP,
} from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { ExtendedModels } from "../src/providers/extended-context";
import { companyFixture } from "./helpers/company";
import { Host } from "./helpers/control";

const catalog = () =>
  new ModelCatalog({
    schemaVersion: 1,
    currency: "USD",
    models: [
      ...loadCatalog().entries.map((e) =>
        e.id === "test-large"
          ? { ...e, extended: { model: "test-wide", eligibility: "account" } }
          : e,
      ),
      {
        id: "test-wide",
        provider: "openai_compatible",
        family: "test",
        label: "Wide",
        contextWindow: 1000000,
        maxOutputTokens: 16000,
        capabilities: { toolCalling: true },
      },
    ],
  });
test("SPEC-API-009/CA-01 — an eligible account uses the declared extended window and checks once per session", async () => {
  const f = companyFixture();
  await f.login();
  f.handle((path) =>
    path.endsWith("/models/eligibility") ? { eligible: true } : undefined,
  );
  const p = new ScriptedProvider([{ text: "one" }, { text: "two" }]);
  const h = new Host(f.ws, {
    identity: f.identity,
    provider: p,
    argv: ["--model", "large-extended"],
    init: {},
    extra: {
      catalog: catalog(),
      companyFetch: f.network,
      credentialVault: f.vault,
    },
  });
  try {
    h.user("first");
    await h.waitFor((m) => m.type === "turn_completed");
    await h.request("select_model", { model: "large" });
    await h.request("select_model", { model: "large-extended" });
    h.user("second");
    await h.waitFor(
      (m) => m.type === "turn_completed" && JSON.stringify(m).includes("two"),
    );
    expect(p.requests.map((r) => r.model.contextWindow)).toEqual([
      1000000, 1000000,
    ]);
    expect(p.requests[0]!.model.id).toBe("test-wide");
    expect(
      f.sent.filter((r) => r.path.endsWith("/models/eligibility")),
    ).toHaveLength(1);
  } finally {
    h.feed.end();
    expect((await h.finish()).code).toBe(0);
  }
});
test("SPEC-API-009/CA-02 — an ineligible account falls back to the standard model with an explicit notice", async () => {
  const f = companyFixture();
  await f.login();
  f.handle((path) =>
    path.endsWith("/models/eligibility") ? { eligible: false } : undefined,
  );
  const p = new ScriptedProvider([{ text: "ok" }]);
  const result = await cli(
    ["--non-interactive", "--model", "large-extended", "question"],
    f.ws,
    {
      identity: f.identity,
      provider: p,
      extra: {
        catalog: catalog(),
        companyFetch: f.network,
        credentialVault: f.vault,
      },
    },
  );
  expect(result.code).toBe(0);
  expect(p.requests[0]!.model.id).toBe("test-large");
  expect(result.stderr).toContain("pas disponible");
});
test("TECH — eligibility is cached for one login only and a replacement account cannot reuse it", async () => {
  let owner = "first",
    checks = 0;
  const selector = new ExtendedModels(
    async () => {
      checks++;
      return owner === "first";
    },
    () => {},
    async () => owner,
  );
  const resolve = () =>
    selector.resolve(
      "large-extended",
      "openai_compatible",
      catalog(),
      loadIdentity(),
      { unknownContextWindow: 128000, identifierMap: TEST_IDENTIFIER_MAP },
      new AbortController().signal,
    );
  const selected = async () => {
    const result = await resolve();
    if (isResolveFailure(result)) throw Error(JSON.stringify(result));
    return result.id;
  };
  expect(await selected()).toBe("test-wide");
  expect(await selected()).toBe("test-wide");
  owner = "second";
  expect(await selected()).toBe("test-large");
  expect(checks).toBe(2);
});
