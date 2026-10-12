// Backup model (SPEC-API-005), lifecycle of the models of the catalogue (SPEC-API-008) and the API key never logged
// (SPEC-API-011 CA-03).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FallbackPolicy } from "../src/engine/fallback";
import { runTurn } from "../src/engine/loop";
import { ModelCatalog } from "../src/providers/catalog";
import { cli, testModel, workspace } from "./helpers/env";
import { bench } from "./helpers/engine";
import { startFakeOpenAI } from "./helpers/fake-openai-server";
import { ScriptedProvider } from "./helpers/scripted-provider";

describe("SPEC-API-005 backup model", () => {
  test("SPEC-API-005/CA-01 — SPEC-API-005/CA-02 — three overloads in a row: the request goes to the backup model and the user is told; ten minutes later the main model is used again", async () => {
    let now = 1_000_000;
    const main = testModel("medium");
    const backup = testModel("small");
    const fallback = new FallbackPolicy({ main, backup, threshold: 3, cooldownMs: 600_000, clock: () => now });
    const overloaded = { error: { kind: "overloaded" as const } };
    const b = bench([overloaded, overloaded, overloaded, { text: "from the backup" }, { text: "again from the backup" }, { text: "from the main model" }], {
      deps: { model: main, fallback, retry: { maxRetries: 5, sleep: async () => {} } },
    });
    const first = await runTurn(b.deps, "hello", new AbortController().signal);
    expect(first.finalText).toBe("from the backup");
    expect(b.provider.requests.map((r) => r.model.id)).toEqual([main.id, main.id, main.id, backup.id]);
    expect(b.events.some((e) => e.type === "warning" && e.message.includes(`modèle de repli ${backup.id}`))).toBe(true); // EF-01
    now += 60_000;
    await runTurn(b.deps, "still busy?", new AbortController().signal);
    expect(b.provider.requests[4]!.model.id).toBe(backup.id); // within the cooling period
    now += 600_000;
    await runTurn(b.deps, "and now?", new AbortController().signal);
    expect(b.provider.requests[5]!.model.id).toBe(main.id); // EF-03
  });

  test("TECH — SPEC-API-005/FA-01, ERR-01, ERR-02 — overloads of the backup do not switch back; a backup not allowed or identical is ignored", async () => {
    let now = 0;
    const main = testModel("medium");
    const backup = testModel("small");
    const fallback = new FallbackPolicy({ main, backup, threshold: 1, cooldownMs: 1000, clock: () => now });
    expect(fallback.overloaded(main)).toBe(true);
    expect(fallback.model()).toBe(backup);
    expect(fallback.overloaded(backup)).toBe(false); // FA-01
    now = 2000;
    expect(fallback.model()).toBe(main);
    const ws = workspace();
    const denied = await cli(["--non-interactive", "--backup-model", "small", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]), userConfig: { models: { allowList: ["medium"] } } });
    expect(denied.stderr).toContain("Modèle de repli non autorisé : il est ignoré.");
    const same = await cli(["--non-interactive", "--model", "medium", "--backup-model", "medium", "x"], ws, { provider: new ScriptedProvider([{ text: "ok" }]) });
    expect(same.stderr).not.toContain("repli");
  });
});

describe("SPEC-API-008 deprecation and retirement of models", () => {
  const catalogWith = () => {
    const data = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "test.models.json"), "utf8"));
    const base = data.models.find((m: { id: string }) => m.id === "test-medium");
    data.models.push(
      { ...base, id: "test-old", label: "Old", lifecycle: { status: "deprecated", retirementDate: "2027-01-31", successor: "test-medium" } },
      { ...base, id: "test-gone", label: "Gone", lifecycle: { status: "retired", retirementDate: "2026-06-30", successor: "test-medium" } },
      { ...base, id: "test-orphan", label: "Orphan", lifecycle: { status: "retired", retirementDate: "2026-06-30" } },
    );
    return new ModelCatalog(data);
  };
  const server = () => startFakeOpenAI([{ text: "ok" }, { text: "ok" }, { text: "ok" }]);
  const config = (baseUrl: string, extra: Record<string, unknown> = {}) => ({ api: { provider: "openai_compatible", baseUrl }, ...extra });

  test("SPEC-API-008/CA-01 — models.selected is a deprecated identifier: a warning gives the retirement date and the successor, once a day", async () => {
    const ws = workspace();
    const s = server();
    const userConfig = config(s.baseURL, { models: { selected: "test-old" } });
    const r = await cli(["--non-interactive", "x"], ws, { userConfig, extra: { catalog: catalogWith() } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("le modèle test-old est déprécié : retrait prévu le 2027-01-31 ; successeur : test-medium.");
    const again = await cli(["--non-interactive", "x"], ws, { userConfig, extra: { catalog: catalogWith() } });
    expect(again.stderr).not.toContain("déprécié");
    s.stop();
  });

  test("SPEC-API-008/CA-02 — models.selected is a retired identifier: the successor is used, the user setting is migrated and the user is told", async () => {
    const ws = workspace();
    const s = server();
    const r = await cli(["--non-interactive", "x"], ws, { userConfig: config(s.baseURL, { models: { selected: "test-gone" } }), extra: { catalog: catalogWith() } });
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("Le modèle test-gone a été retiré le 2026-06-30 : son successeur test-medium est utilisé, et vos paramètres utilisateur ont été mis à jour.");
    expect(s.requests[0]!.body["model"]).toBe("test-medium");
    expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).models.selected).toBe("test-medium");
    s.stop();
  });

  test("TECH — SPEC-API-008 step 3, FA-01 — a retired model asked with --model: its successor with a warning; without successor, the default model", async () => {
    const ws = workspace();
    const s = server();
    const explicit = await cli(["--non-interactive", "--model", "test-gone", "x"], ws, { userConfig: config(s.baseURL), extra: { catalog: catalogWith() } });
    expect(explicit.stderr).toContain("avertissement : le modèle test-gone a été retiré le 2026-06-30 : son successeur test-medium est utilisé.");
    const orphan = await cli(["--non-interactive", "--model", "test-orphan", "x"], ws, { userConfig: config(s.baseURL), extra: { catalog: catalogWith() } });
    expect(orphan.code).toBe(0);
    expect(orphan.stderr).toContain("faute de successeur, le modèle par défaut");
    s.stop();
  });
});

describe("SPEC-API-007 allow list and identifiers of the tiers", () => {
  test("SPEC-API-007/CA-01 — models.allowList = [medium, small]: --model large is refused with ERR-01", async () => {
    const r = await cli(["--non-interactive", "--model", "large", "x"], workspace(), { provider: new ScriptedProvider([]), userConfig: { models: { allowList: ["medium", "small"] } } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Ce modèle n'est pas autorisé par votre configuration");
  });

  test("SPEC-API-007/CA-02 — models.identifierMap maps large to a private deployment: the private identifier is sent", async () => {
    const provider = new ScriptedProvider([{ text: "ok" }]);
    const r = await cli(["--non-interactive", "--model", "large", "x"], workspace(), { provider, userConfig: { models: { identifierMap: { large: "test-medium" } } } });
    expect(r.code).toBe(0);
    expect(provider.requests[0]!.model.id).toBe("test-medium");
  });

  test("SPEC-API-007/CA-03 — a managed list: a model added in the user settings stays not allowed", async () => {
    const ws = workspace();
    ws.write("managed/policy.json", JSON.stringify({ models: { allowList: ["medium"] } }));
    const r = await cli(["--non-interactive", "--model", "small", "x"], ws, { provider: new ScriptedProvider([]), userConfig: { models: { allowList: ["medium", "small"] } } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Ce modèle n'est pas autorisé par votre configuration");
  });
});

describe("SPEC-API-011 API key", () => {
  test("SPEC-API-011/CA-03 — SPEC-OBS-012/CA-02 — debug mode: a logged request never shows the key", async () => {
    const ws = workspace();
    const s = startFakeOpenAI([{ text: "ok" }]);
    const log = join(ws.root, "debug.log");
    const key = "sk-test-0123456789-secret-value";
    const r = await cli(["--non-interactive", "--debug=api", "--debug-output", log, "x"], ws, { userConfig: { api: { provider: "openai_compatible", baseUrl: s.baseURL } }, env: { OPENAI_API_KEY: key } });
    expect(r.stderr).toBe(`Journal de débogage : ${log}.\n`);
    expect(r.code).toBe(0);
    expect(s.requests[0]!.headers["authorization"]).toBe(`Bearer ${key}`);
    const text = readFileSync(log, "utf8");
    expect(text).toContain("••••");
    expect(text).not.toContain(key);
    expect(text).not.toContain("0123456789");
    s.stop();
  });
});
