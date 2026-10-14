import { expect, test } from "bun:test";
import { decide, type PermissionContext, type PermissionQuery } from "../src/permissions/engine";
import { resolveAsk } from "../src/permissions/resolver";
import { isRule, parseRule, type RuleScope } from "../src/permissions/rules";
import { workspace } from "./helpers/env";
import { currentPlatform } from "../src/platform/system";
const ws = workspace();
const rule = (text: string, decision: "allow" | "ask", scope: RuleScope = "user") => { const parsed = parseRule(text, decision, scope, ws.project); if (!isRule(parsed)) throw new Error(parsed.message); return parsed; };
const context = (): PermissionContext => ({ mode: "unrestricted", rules: [], sessionAllows: [], cwd: ws.project, home: ws.home, platform: currentPlatform(), managedRulesOnly: false });
const query: PermissionQuery = { toolName: "run_workflow", subject: { kind: "name", name: "review-multi" }, flags: { readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: false, explicitApproval: true }, available: true };
test("TECH — workflow plan approval survives unrestricted mode, ordinary permissions, a hook and temporary skill grants", () => {
  for (const ctx of [context(), { ...context(), rules: [rule("spawn_agent", "allow")] }, { ...context(), sessionAllows: [rule("run_workflow", "allow")] }]) expect(decide({ ...query, hookDecision: "allow", contribution: "allow" }, ctx).kind).toBe("ask");
  expect(decide(query, { ...context(), rules: [rule("run_workflow(review-multi)", "allow")] }).kind).toBe("allow");
  expect(decide(query, { ...context(), explicitSessionAllows: [rule("run_workflow", "allow")] }).kind).toBe("allow");
  expect(decide(query, { ...context(), rules: [rule("run_workflow", "allow"), rule("run_workflow", "ask", "managed")] })).toMatchObject({ kind: "ask", origin: "managed" });
});
test("TECH — automated authorities cannot accept a workflow execution plan in place of its human owner", async () => {
  const decision = { kind: "ask", step: 4, origin: "explicit", reason: "Plan approval", suggestions: [] } as const;
  const request = { callId: "plan", toolName: "run_workflow", summary: "Review", origin: "explicit", reason: "Plan approval", suggestions: [], planApproval: true } as const;
  let automated = 0;
  const authorities = { classifier: { decide: async () => { automated++; return "allow" as const; } }, delegate: { decide: async () => { automated++; return "allow" as const; } }, habilitatedHook: { decide: async () => { automated++; return "allow" as const; } } };
  expect(await resolveAsk(decision, request, "auto_approve", authorities, new AbortController().signal)).toMatchObject({ decision: "deny", by: "none" });
  expect(automated).toBe(0);
  expect(await resolveAsk(decision, request, "no_prompt", { ...authorities, controlHost: { decide: async () => ({ decision: "allow" as const }) } }, new AbortController().signal)).toMatchObject({ decision: "allow", by: "control_host" });
});
