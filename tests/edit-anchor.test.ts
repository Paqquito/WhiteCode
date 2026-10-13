import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { workspace } from "./helpers/env";
import { Host } from "./helpers/control";
import { ScriptedProvider } from "./helpers/scripted-provider";
import { cli } from "./helpers/env";
import { planBlockAnchor } from "../src/tools/edit-match";
const original = "function check() {\n  const value = 12345678;\n}\n", requested = "function check() {\n  const value = 12345679;\n}", replacement = "function check() {\n  const value = 9;\n}";
test("SPEC-OUT-004/CA-13 — block anchor requires a human diff of actual content and returns the whole replacement source", async () => {
  const ws = workspace(), path = ws.write("project/anchor.ts", original), decisions: unknown[] = [];
  const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { toolCalls: [{ name: "edit_file", input: { path, old_text: requested, new_text: replacement } }] }, { text: "done" }]);
  const host = new Host(ws, { provider, argv: ["--approval-mode", "ask"], init: { decisionAuthority: true }, answers: { approval_request: params => { decisions.push(params); return { decision: "allow" }; } } });
  try { host.user("edit"); await host.waitFor(m => m.type === "turn_completed"); } finally { host.feed.end(); await host.finish(); }
  expect(decisions).toHaveLength(1); expect(JSON.stringify(decisions)).toContain("12345678"); expect(readFileSync(path, "utf8")).toBe(replacement + "\n"); expect(JSON.stringify(provider.requests[2]!.history)).toContain("block anchor"); expect(JSON.stringify(provider.requests[2]!.history)).toContain("const value = 12345678;");
});
test("SPEC-OUT-004/CA-17 — an approval hook cannot accept a block anchor in place of the human", async () => {
  for (const human of [false, true]) {
    const ws = workspace(), path = ws.write("project/anchor.ts", original); let hooks = 0;
    const provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { toolCalls: [{ name: "edit_file", input: { path, old_text: requested, new_text: replacement } }] }, { text: "done" }]);
    const extra = { authorities: { habilitatedHook: { decide: async () => { hooks++; return "allow" as const; } } } };
    if (human) { const host = new Host(ws, { provider, argv: ["--approval-mode", "ask"], init: { decisionAuthority: true }, answers: { approval_request: () => ({ decision: "deny" }) }, extra }); try { host.user("edit"); await host.waitFor(m => m.type === "turn_completed"); } finally { host.feed.end(); await host.finish(); } }
    else await cli(["--non-interactive", "--approval-mode", "ask", "edit"], ws, { provider, extra });
    expect(hooks).toBe(0); expect(readFileSync(path, "utf8")).toBe(original); expect(JSON.stringify(provider.requests[2]!.history)).toContain("Passage not found");
  }
});
test("SPEC-OUT-004/CA-18 — auto-approve anchored edits have explicit origin and bypass the classifier", async () => {
  const ws = workspace(), path = ws.write("project/anchor.ts", original); ws.write("home/config/state.json", JSON.stringify({ autoApproveConsent: { version: 1, at: new Date().toISOString() } }));
  let classified = 0; const decisions: unknown[] = [], provider = new ScriptedProvider([{ toolCalls: [{ name: "read_file", input: { path } }] }, { toolCalls: [{ name: "edit_file", input: { path, old_text: requested, new_text: replacement } }] }, { text: "done" }]);
  const host = new Host(ws, { provider, argv: ["--approval-mode", "auto_approve"], init: { decisionAuthority: true }, answers: { approval_request: params => { decisions.push(params); return { decision: "allow" }; } }, extra: { authorities: { classifier: { decide: async () => { classified++; return "allow"; } } } } });
  try { host.user("edit"); await host.waitFor(m => m.type === "turn_completed"); } finally { host.feed.end(); await host.finish(); }
  expect(classified).toBe(0); expect(decisions).toHaveLength(1); expect(JSON.stringify(decisions)).toContain('"origin":"explicit"'); expect(readFileSync(path, "utf8")).toBe(replacement + "\n");
});
test("TECH — anchor matching rejects ambiguous, short, below-threshold and costly passages", () => {
  expect(planBlockAnchor(original + original, requested, replacement, 0.8).kind).toBe("ambiguous_approximate");
  expect(planBlockAnchor("a\nb", "a\nx", "c", 0.8).kind).toBe("not_found");
  expect(planBlockAnchor(original, requested, replacement, 1).kind).toBe("not_found");
  expect(planBlockAnchor(`a\n${"x".repeat(3000)}\nz`, `a\n${"y".repeat(3000)}\nz`, "replacement", 0.8).kind).toBe("not_found");
});
