import { expect, test } from "bun:test";
import { sampleSideText } from "../src/engine/side-text";
import { BudgetLedger } from "../src/engine/budget";
import { testModel } from "./helpers/env";
import { ScriptedProvider } from "./helpers/scripted-provider";
import type { HistoryMessage } from "../src/providers/types";

test("TECH — a progress branch closes still-running tool calls without changing or executing the parent history", async () => {
  const history: HistoryMessage[] = [{ role: "assistant", text: "Running tools", toolCalls: [{ callId: "one", name: "read_file", input: {} }, { callId: "two", name: "run_shell", input: {} }], native: { provider: "simulated", content: {} } }, { role: "user", parts: [{ type: "tool_result", callId: "one", isError: false, content: [{ type: "text", text: "First real result" }] }] }];
  const before = JSON.stringify(history), provider = new ScriptedProvider([request => {
    const parts = request.history.flatMap(message => message.role === "user" ? message.parts : []), results = parts.filter(part => part.type === "tool_result");
    expect(results.map(result => result.callId)).toEqual(["one", "two"]); expect(JSON.stringify(results[1])).toContain("still running"); expect(request.tools).toHaveLength(1);
    return { text: "Waiting for the shell result." };
  }]);
  const result = await sampleSideText({ provider, model: testModel("default"), ledger: new BudgetLedger(undefined, "USD"), system: "Summarize progress without tools.", text: "Current progress?", branch: { system: [{ text: "Original system" }], history, tools: [{ name: "run_shell", description: "Run shell", inputSchema: { type: "object" } }] }, consumer: "agent_progress", signal: new AbortController().signal });
  expect(result).toBe("Waiting for the shell result."); expect(JSON.stringify(history)).toBe(before);
});
