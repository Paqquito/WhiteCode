// Supports: SPEC-CMD-003, SPEC-MOT-027 (actual controlled driver and compiled omission).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFlag } from "../../src/extension-points/build-flags" with { type: "macro" };
import { INTERNAL_COMMANDS } from "../../src/commands/internal";
import { advisorTool } from "../../src/tools/consult-advisor";
import { Host } from "../helpers/control";
import { cli, workspace } from "../helpers/env";
import { ScriptedProvider } from "../helpers/scripted-provider";

const extraCatalog = [
  { id: "main-advisor-fixture", provider: "openai_compatible", family: "fixture", label: "Main", contextWindow: 200000, maxOutputTokens: 4096, capabilities: { toolCalling: true }, advisors: ["advisor-fixture"] },
  { id: "advisor-fixture", provider: "openai_compatible", family: "fixture", label: "Advisor", contextWindow: 200000, maxOutputTokens: 4096, capabilities: { toolCalling: false } },
];
test("TECH — advisor presence requires both the compiled capability and an explicit compatible selection", async () => {
  const included = buildFlag("model_advisor"), ws = workspace(), controller = new AbortController();
  const provider = new ScriptedProvider([{ text: "DEFAULT_WITHOUT_ADVISOR" }, { text: "SELECTED_ADVISOR" }]);
  const host = new Host(ws, { provider, argv: ["--model=main-advisor-fixture"], extra: { signal: controller.signal }, userConfig: { models: { extraCatalog } } });
  try {
    expect(INTERNAL_COMMANDS.some(command => command.name === "consult")).toBe(included);
    expect(INTERNAL_COMMANDS.some(command => command.name === "advisor")).toBe(false);
    const local = advisorTool({ available: () => true, consult: async () => { throw Error("Unexpected consultation"); } });
    expect(local !== undefined).toBe(included);
    host.user("Describe this project.");
    await host.waitFor(message => message.type === "turn_completed" && message["turn"] === 1);
    expect(provider.requests[0]!.tools.some(tool => tool.name === "consult_advisor")).toBe(false);
    const config = join(ws.configHome, "config.json"), before = readFileSync(config, "utf8");
    expect(JSON.parse(before).models.advisor).toBeUndefined();
    const selected = await host.request("invoke_command", { command: "/consult advisor-fixture" });
    expect(selected["ok"]).toBe(true);
    const commandResult = selected["result"] as Record<string, unknown>;
    if (included) expect(commandResult["refused"]).toBeUndefined();
    else expect(typeof commandResult["refused"]).toBe("string");
    if (!included) expect(readFileSync(config, "utf8")).toBe(before);
    else expect(JSON.parse(readFileSync(config, "utf8")).models.advisor).toBe("advisor-fixture");
    host.user("Describe the next step.");
    await host.waitFor(message => message.type === "turn_completed" && message["turn"] === 2);
    expect(provider.requests[1]!.tools.some(tool => tool.name === "consult_advisor")).toBe(included);
    expect(provider.requests.filter(request => request.purpose === "side")).toHaveLength(0);
    host.feed.end(); expect((await host.finish()).code).toBe(0);
    const configured = new ScriptedProvider([{ text: "CONFIGURED_ADVISOR" }]);
    const result = await cli(["--non-interactive", "--model=main-advisor-fixture", "Describe the project."], workspace(), { provider: configured, userConfig: { models: { extraCatalog, advisor: "advisor-fixture" } } });
    expect(result.code).toBe(0);
    expect(configured.requests[0]!.tools.some(tool => tool.name === "consult_advisor")).toBe(included);
    expect(configured.requests.filter(request => request.purpose === "side")).toHaveLength(0);
  } finally { controller.abort(); host.feed.end(); await host.finish(); }
}, 10000);
