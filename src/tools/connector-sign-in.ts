// Implements: SPEC-OUT-029 (unique tool, human consent, no secret in results, CA-01, CA-02).
// Supports: SPEC-MCP-006 (EF-04), gap E-155.
import type { ConnectorManager } from "../connectors/manager";
import { textOutcome, type Tool } from "./types";
export function connectorSignInTool(manager: ConnectorManager, timeoutMs: number): Tool<{ server: string }> {
  return {
    name: "connector_sign_in", inputSchema: { type: "object", properties: { server: { type: "string", minLength: 2, maxLength: 48 } }, required: ["server"], additionalProperties: false },
    description: () => "Ask the human to authorize a named connector in their own browser. The human must consent and complete the flow. No token or code is returned. Available servers: " + manager.canSignIn().join(", "),
    isEnabled: () => manager.canSignIn().length > 0,
    flags: () => ({ readOnly: false, destructive: false, concurrencySafe: false, requiresPermission: false, openWorld: true }),
    ruleSubject: input => ({ kind: "name", name: input.server }), summary: input => `Authentification du connecteur ${input.server}`,
    permissionContribution: () => "allow",
    timeoutMs: () => timeoutMs + 30000,
    validate: input => manager.canSignIn().includes(input.server) ? undefined : "This connector does not require human authorization.",
    async execute(input, ctx) { try { const result = await manager.signIn(input.server, ctx.signal); return textOutcome(`Authenticated. Available tools: ${manager.tools().filter(t => t.name.startsWith(`cnx_${result.name}_`)).map(t => t.name).join(", ")}.`); } catch { return textOutcome("Human authorization was declined, interrupted, or could not be completed. Use /connectors to inspect the status.", true, "unavailable"); } },
  };
}
