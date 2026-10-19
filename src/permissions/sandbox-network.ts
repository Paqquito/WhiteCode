// Supports: SPEC-PER-015 (proxy domains use the same rule engine and designated approval authorities as ordinary tools).
import { randomUUID } from "node:crypto";
import { decide } from "./engine";
import type { PermissionContext } from "./engine";
import { resolveAsk } from "./resolver";
import type { Authorities } from "./resolver";
import type { HookBus } from "../extension-points/hooks";
import { domainMatches } from "./rules";
interface NetworkAuthorities { context(): PermissionContext; authorities(): Authorities; persist?(scope: string, rule: string): void; beforeTool?: HookBus["beforeTool"] }
const version = (context: PermissionContext) => JSON.stringify({ mode: context.mode, rules: context.rules, grants: context.sessionAllows, managed: context.managedRulesOnly, refusal: context.policyRefusal, versions: context.decisionAuthorityVersion });
/** A grant belongs to one immutable permission context; DNS waiting cannot preserve a revoked grant. */
export function sandboxNetworkAuthority(preapproved: (url: string) => boolean, ports: NetworkAuthorities) {
  const approved = new Map<string, string>();
  return {
    async authorize(url: string, signal: AbortSignal) {
      const grant = await domainAuthorization(url, preapproved(url), ports, signal);
      if (grant === undefined) return false;
      approved.set(url, grant);
      return !signal.aborted && grant === version(ports.context());
    },
    revalidate: (url: string) => approved.get(url) === version(ports.context()),
  };
}
export async function approveSandboxNetwork(url: string, preapproved: boolean, ports: NetworkAuthorities, signal: AbortSignal): Promise<boolean> {
  return await domainAuthorization(url, preapproved, ports, signal) !== undefined;
}
async function domainAuthorization(url: string, preapproved: boolean, ports: NetworkAuthorities, signal: AbortSignal): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    const callId = randomUUID(), hook = await ports.beforeTool?.({ callId, name: "fetch_url", input: { url } });
    signal.throwIfAborted();
    if (hook?.conflict || hook?.stopTurn || hook?.modifiedInput && (Object.keys(hook.modifiedInput).some(key => key !== "url") || hook.modifiedInput.url !== url)) return undefined;
    const query = { toolName: "fetch_url", subject: { kind: "url" as const, url }, available: true, flags: { readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: true, openWorld: true }, contribution: preapproved ? "allow" as const : undefined, hookDecision: hook?.decision, hookReason: hook?.reason };
    const context = ports.context(); let decision = decide(query, context);
    if (decision.kind === "deny") return undefined;
    // Unrestricted mode or a whole-tool rule is not a domain allowlist. A new domain still needs a designated answer.
    const domainGrant = [...(context.managedRulesOnly ? context.rules.filter(rule => rule.scope === "managed") : context.rules), ...context.sessionAllows].some(rule => rule.tool === "fetch_url" && rule.decision === "allow" && rule.pattern !== undefined && domainMatches(rule.pattern, url));
    if (decision.kind === "allow" && !preapproved && !domainGrant && hook?.decision !== "allow") decision = { kind: "ask", step: 8, origin: "default", reason: "This domain is outside the sandbox network allowlist.", suggestions: [`fetch_url(domain:${new URL(url).hostname})`] };
    if (decision.kind === "allow") return version(context);
    const authority = version(context);
    const answer = await resolveAsk(decision, { callId, toolName: "fetch_url", input: { url }, summary: "Allow confined command network access to " + url, action: `fetch_url(domain:${new URL(url).hostname})`, reason: decision.reason, origin: decision.origin, suggestions: decision.suggestions }, context.mode, ports.authorities(), signal);
    if (answer.decision !== "allow" || signal.aborted || answer.input && answer.input.url !== url) return undefined;
    const current = ports.context();
    if (authority !== version(current)) continue;
    if (answer.persist) ports.persist?.(answer.persist.scope, answer.persist.rule);
    const final = ports.context();
    return signal.aborted || decide(query, final).kind === "deny" ? undefined : version(final);
  }
  return undefined;
}
