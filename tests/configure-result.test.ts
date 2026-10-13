// Supports: SPEC-OUT-039, SPEC-OUT-041; real composition and direct human confirmation.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cli, workspace } from "./helpers/env";
import { interactive, sleep } from "./helpers/interactive";
import { ScriptedProvider } from "./helpers/scripted-provider";

test("SPEC-OUT-041/CA-01 — a session without a schema never advertises submit_result", async () => {
  const p = new ScriptedProvider([{ text: "done" }]);
  expect((await cli(["--non-interactive", "x"], workspace(), { provider: p })).code).toBe(0);
  expect(p.requests[0]!.tools.map(t => t.name)).not.toContain("submit_result");
});

test("SPEC-OUT-041/CA-02 — a valid submitted result ends the real execution without another request", async () => {
  const p = new ScriptedProvider([{ toolCalls: [{ name: "submit_result", input: { result: "accepted" } }] }]);
  const r = await cli(["--non-interactive", "--output-schema", JSON.stringify({ type: "object", properties: { result: { type: "string" } }, required: ["result"], additionalProperties: false }), "x"], workspace(), { provider: p });
  expect(r.code).toBe(0); expect(JSON.parse(r.stdout)).toEqual({ result: "accepted" }); expect(p.requests).toHaveLength(1);
});

test("TECH — submit_result rejects an invalid value and retains the last valid value in a batch", async () => {
  const schema = JSON.stringify({ type: "object", properties: { n: { type: "integer" } }, required: ["n"], additionalProperties: false });
  const p = new ScriptedProvider([{ toolCalls: [{ name: "submit_result", input: { n: "invalid" } }] }, { toolCalls: [{ name: "submit_result", input: { n: 1 } }, { name: "submit_result", input: { n: 2 } }] }]);
  const r = await cli(["--non-interactive", "--output-schema", schema, "x"], workspace(), { provider: p });
  expect(r.code).toBe(0); expect(JSON.parse(r.stdout)).toEqual({ n: 2 }); expect(p.requests).toHaveLength(2);
  expect(JSON.stringify(p.requests[1]!.history)).toContain("integer");
});

test("SPEC-OUT-039/CA-02 — configure cannot change a permission even in auto_edit", async () => {
  const ws = workspace(), p = new ScriptedProvider([{ toolCalls: [{ name: "configure", input: { setting: "permissions.initialMode", value: "unrestricted" } }] }, { text: "done" }]);
  const r = await cli(["--non-interactive", "--approval-mode", "auto_edit", "x"], ws, { provider: p });
  expect(r.code).toBe(0); expect(p.requests[0]!.tools.map(t => t.name)).toContain("configure");
  expect(JSON.stringify(p.requests[1]!.history)).toContain("isError");
  expect(readFileSync(join(ws.configHome, "config.json"), "utf8")).not.toContain("unrestricted");
});

test("SPEC-OUT-039/CA-01 — changing a theme waits for a human and applies without reopening the terminal", async () => {
  const ws = workspace(), c = new AbortController();
  const p = new ScriptedProvider([{ toolCalls: [{ name: "configure", input: { setting: "ui.theme", value: "light" } }] }, { text: "changed" }]);
  const ui = interactive([], ws, { provider: p, signal: c.signal });
  try {
    await ui.idle(); ui.type("change the theme\r");
    await ui.waitFor(t => t.includes("ui.theme") && t.includes("light") && t.includes("dark"));
    expect(readFileSync(join(ws.configHome, "config.json"), "utf8")).not.toContain('"theme": "light"');
    await sleep(400); ui.type("o");
    await ui.waitFor(t => t.includes("changed"));
    expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).ui.theme).toBe("light");
    expect(JSON.stringify(p.requests[1]!.history)).toContain('now');
  } finally { c.abort(); await ui.done; }
}, 15000);

test("TECH — configure cannot turn an automated permission allow into a human confirmation", async () => {
  const ws = workspace(), p = new ScriptedProvider([{ toolCalls: [{ name: "configure", input: { setting: "ui.theme", value: "light" } }] }, { text: "done" }]);
  await cli(["--non-interactive", "--allow-rule", "configure", "x"], ws, { provider: p });
  expect(JSON.parse(readFileSync(join(ws.configHome, "config.json"), "utf8")).ui?.theme).toBeUndefined();
  expect(JSON.stringify(p.requests[1]!.history)).toContain("did not confirm");
});
