import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { presentationLanguage } from "../src/engine/presentation-language";
import { Host } from "./helpers/control";

test("SPEC-CFG-012/CA-01 — an explicit French preference reaches the model even for English input", async () => {
  const provider = new ScriptedProvider([{ text: "Réponse en français." }]);
  const result = await cli(["--non-interactive", "Explain this project"], workspace(), { provider, userConfig: { ui: { language: "fr" } } });
  expect(result.code).toBe(0); expect(provider.requests[0]!.system.map(b => b.text).join("\n")).toContain("Respond in French (fr)");
});
test("SPEC-CFG-012/CA-02 — unsupported German UI falls back while model instructions retain German", () => {
  const language = presentationLanguage("de-DE", "en");
  expect(language.ui).toBe("fr"); expect(language.instruction).toContain("German (de-DE)");
  expect(presentationLanguage("auto", "en-GB").ui).toBe("en");
});
const extraCatalog = [
  { id: "main-advisor-fixture", provider: "openai_compatible", family: "fixture", label: "Main", contextWindow: 200000, maxOutputTokens: 4096, capabilities: { toolCalling: true }, advisors: ["advisor-fixture"] },
  { id: "advisor-fixture", provider: "openai_compatible", family: "fixture", label: "Advisor", contextWindow: 200000, maxOutputTokens: 4096, capabilities: { toolCalling: false } },
];
test("SPEC-MOT-027/CA-01, SPEC-CMD-003/CA-01 — selecting a validated advisor publishes its tool and runs an isolated consultation", async () => {
  const provider = new ScriptedProvider([
    { toolCalls: [{ name: "consult_advisor", input: { question: "Choose a strategy without accessing files." } }] },
    request => { expect(request.purpose).toBe("side"); expect(request.model.id).toBe("advisor-fixture"); expect(request.tools).toEqual([]); expect(JSON.stringify(request.history)).not.toContain("PRIVATE_MAIN_CONTEXT"); return { text: "Consider the smallest safe change." }; },
    { text: "Consultation complete." },
  ]);
  const host = new Host(workspace(), { argv: ["--model=main-advisor-fixture", "--toolset=consult_advisor"], provider, userConfig: { models: { extraCatalog }, permissions: { allowRules: ["consult_advisor"] } } });
  const selected = await host.request("invoke_command", { command: "/advisor advisor-fixture" }); expect(selected["ok"]).toBe(true);
  host.user("PRIVATE_MAIN_CONTEXT"); await host.waitFor(m => m.type === "turn_completed"); host.feed.end(); const result = await host.finish();
  expect(result.code).toBe(0); expect(provider.requests[0]!.tools.map(t => t.name)).toContain("consult_advisor");
  expect(provider.requests.filter(r => r.purpose === "side")).toHaveLength(1);
});
test("SPEC-MOT-027/CA-02 — an unvalidated model pair cannot publish an advisor", async () => {
  const provider = new ScriptedProvider([{ text: "No advisor available." }]);
  const result = await cli(["--non-interactive", "Explain"], workspace(), { provider, userConfig: { models: { advisor: "advisor-fixture", extraCatalog } } });
  expect(result.code).toBe(0); expect(provider.requests[0]!.tools.map(t => t.name)).not.toContain("consult_advisor");
});
test("TECH — cancelling an advisor consultation does not disable the advisor for the next turn", async () => {
  const consult = { toolCalls: [{ name: "consult_advisor", input: { question: "Choose a strategy." } }] };
  const provider = new ScriptedProvider([consult, { hang: true }, consult, { text: "Advice" }, { text: "RESUMED_ADVISOR" }]);
  const host = new Host(workspace(), { provider, argv: ["--model=main-advisor-fixture"], userConfig: { models: { extraCatalog, advisor: "advisor-fixture" }, permissions: { allowRules: ["consult_advisor"] } } });
  try {
    host.user("Consult");
    for (let n = 0; n < 1000 && !provider.requests.some(request => request.purpose === "side"); n++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(provider.requests.some(request => request.purpose === "side")).toBe(true); await host.request("cancel_turn"); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === 1);
    host.user("Consult again"); await host.waitFor(m => m.type === "turn_completed" && m["turn"] === 2); expect(provider.requests.filter(request => request.purpose === "side")).toHaveLength(2); expect(host.messages.some(m => JSON.stringify(m).includes("RESUMED_ADVISOR"))).toBe(true);
  } finally { host.feed.end(); await host.finish(); }
}, 10000);
