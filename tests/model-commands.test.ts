// Commands that change the model and the behaviour of the session (lot 8, increment 3): /switch-model (SPEC-CMD-045),
// /reasoning-level (SPEC-CMD-022), /planning (SPEC-CMD-048), /condense (SPEC-CMD-011), /preferences (SPEC-CMD-013).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { interactive, KEY, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

const shown = (m: Record<string, unknown>) => JSON.stringify((m["result"] as Record<string, unknown>)["shown"]);
const VENDOR_KEY = { ANTHROPIC_API_KEY: "test-key-not-a-secret" };
// /preferences widens what the session may do: the host confirms it (SPEC-MOD-006).
const CONFIRMED = {
  init: { decisionAuthority: true },
  userConfig: { engine: { control: { allowEscalation: true } } },
  answers: { confirm_escalation: (params: Record<string, unknown>) => ({ decision: "confirm", escalationId: params["escalationId"] }) },
};
const userConfig = (root: string) => JSON.parse(readFileSync(join(root, "config.json"), "utf8")) as Record<string, Record<string, unknown>>;

describe("SPEC-CMD-045 /switch-model", () => {
  test("SPEC-CMD-045/CA-01 — a context of 150 000 tokens and a model with a window of 100 000: a compaction is proposed", async () => {
    const ws = workspace();
    const run = interactive(["--model", "large"], ws, { provider: new ScriptedProvider([{ text: "réponse longue", usage: { input: 150_000, output: 10 } }]) });
    await run.idle();
    run.type("question");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("réponse longue"), "answer");
    await run.idle();
    run.type("/switch-model medium");
    run.type(KEY.enter);
    await run.waitFor((t) => t.includes("conversation maintenant ?"), "proposal");
    expect(run.all().join("\n")).toMatch(/dépasse la fenêtre de test-medium \(112000 jetons\)/);
    await sleep(350);
    run.type("n");
    await run.waitFor((t) => t.includes("utilisez /condense"), "declined");
    await run.idle();
    run.type(KEY.ctrlD);
    run.type(KEY.ctrlD);
    await run.done;
  }, 20_000);

  test("TECH — SPEC-CMD-045/EF-02, FA-01 — the control channel: the next request uses the new model, an unknown model is refused", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "un" }, { text: "deux" }]);
    const h = new Host(ws, { provider: p, init: {} });
    h.user("premier");
    await h.waitFor((m) => m.type === "turn_completed");
    const ok = await h.request("select_model", { model: "small" });
    const refused = await h.request("select_model", { model: "modele-inexistant" });
    h.user("second");
    await h.waitFor((m) => m.type === "turn_completed" && JSON.stringify(m).includes("deux"));
    h.feed.end();
    await h.finish();
    expect(JSON.stringify(ok)).toContain("test-small");
    expect(JSON.stringify(refused)).toContain("model_refused");
    expect(p.requests.map((r) => r.model.id)).toEqual(["test-medium", "test-small"]);
  }, 20_000);
});

describe("SPEC-CMD-022 /reasoning-level", () => {
  test("SPEC-CMD-022/CA-01 — /reasoning-level max on a compatible model: the next session is back to the default", async () => {
    const ws = workspace();
    const first = new ScriptedProvider([{ text: "réfléchi" }]);
    const h = new Host(ws, { provider: first, init: {}, argv: ["--model", "vendor-always"], userConfig: { api: { provider: "anthropic" } }, env: VENDOR_KEY });
    const r = await h.request("invoke_command", { command: "/reasoning-level max" });
    h.user("question");
    await h.waitFor((m) => m.type === "turn_completed");
    h.feed.end();
    await h.finish();
    expect(shown(r)).toContain("pour cette session seulement");
    expect(first.requests[0]!.effort).toBe("max");
    expect(userConfig(ws.configHome)["models"]?.["effort"]).toBeUndefined();
    const next = new ScriptedProvider([{ text: "ok" }]);
    const again = await cli(["--non-interactive", "--model", "vendor-always", "question"], ws, { provider: next, userConfig: { api: { provider: "anthropic" } }, env: VENDOR_KEY });
    expect(again.code).toBe(0);
    expect(next.requests[0]!.effort).toBe("high");
  }, 20_000);
});

describe("SPEC-CMD-048 /planning", () => {
  test("SPEC-CMD-048/CA-01 — /planning with a description: the mode is planning and the request goes to the model", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "Voici mon exploration." }]);
    const h = new Host(ws, { provider: p, init: {} });
    h.user("/planning migrer vers la nouvelle API");
    await h.waitFor((m) => m.type === "turn_completed");
    const state = await h.request("get_state");
    h.feed.end();
    await h.finish();
    expect(JSON.stringify(state)).toContain('"planning"');
    expect(JSON.stringify(p.requests[0]!.history)).toContain("migrer vers la nouvelle API");
  }, 20_000);
});

describe("SPEC-CMD-011 /condense", () => {
  test("SPEC-CMD-011/CA-01 — instructions « garder les décisions d'API »: the summary request puts them forward", async () => {
    const ws = workspace();
    const p = new ScriptedProvider([{ text: "réponse" }, { text: "Résumé : décisions d'API conservées." }]);
    const h = new Host(ws, { provider: p, init: {} });
    h.user("question");
    await h.waitFor((m) => m.type === "turn_completed");
    const r = await h.request("invoke_command", { command: "/condense garder les décisions d'API" });
    h.feed.end();
    await h.finish();
    expect(shown(r)).toContain("Conversation résumée");
    const summary = p.requests[1]!;
    expect(JSON.stringify(summary.history[summary.history.length - 1])).toContain("garder les décisions d'API");
  }, 20_000);
});

describe("SPEC-CMD-013 /preferences", () => {
  test("SPEC-CMD-013/CA-01 — automatic compaction disabled: recorded and taken into account at once", async () => {
    const ws = workspace();
    // 180 000 tokens out of an effective window of 184 000: above the trigger of the automatic compaction.
    const p = new ScriptedProvider([{ text: "un", usage: { input: 180_000, output: 10 } }, { text: "deux" }]);
    const h = new Host(ws, { provider: p, ...CONFIRMED, argv: ["--model", "large"] });
    h.user("premier");
    await h.waitFor((m) => m.type === "turn_completed");
    const r = await h.request("invoke_command", { command: "/preferences context.autoCompact.enabled false" });
    h.user("second");
    await h.waitFor((m) => m.type === "turn_completed" && JSON.stringify(m).includes("deux"));
    h.feed.end();
    await h.finish();
    expect(shown(r)).toContain("appliqué immédiatement");
    expect(userConfig(ws.configHome)["context"]).toEqual({ autoCompact: { enabled: false } });
    // No compaction request between the two turns.
    expect(p.requests).toHaveLength(2);
    expect(JSON.stringify(p.requests[1]!.history)).toContain("premier");
  }, 20_000);

  test("TECH — SPEC-CMD-013/EF-01 — an invalid value is refused and nothing is written", async () => {
    const ws = workspace();
    const h = new Host(ws, { provider: new ScriptedProvider([]), ...CONFIRMED });
    const r = await h.request("invoke_command", { command: "/preferences context.autoCompact.enabled peut-être" });
    h.feed.end();
    await h.finish();
    expect(JSON.stringify(r)).toContain("Valeur invalide");
    expect(userConfig(ws.configHome)["context"]).toBeUndefined();
  }, 20_000);
});
