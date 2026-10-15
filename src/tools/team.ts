// Implements: SPEC-OUT-019, SPEC-OUT-017 (team routing); Supports: SPEC-AGT-011/014, gap E-168.
import type { Teams } from "../agents/teams";
import { textOutcome, type Tool } from "./types";
import { storeDirectoryReference, storeReference } from "../session/private-storage";
export function teamTools(teams: () => Teams, changed: (event: "team_created" | "team_removed") => void): Tool<never>[] {
  const flags = () => ({ readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: false });
  const form: Tool<{ team: string; description?: string }> = {
    name: "form_team", description: () => "Create one local team led by this session, with a private shared task list and mailboxes. Start named teammates with spawn_agent. Their tools and permissions never exceed your own.",
    inputSchema: { type: "object", properties: { team: { type: "string", pattern: "^[a-z][a-z0-9-]{0,47}$" }, description: { type: "string", maxLength: 500 } }, required: ["team"], additionalProperties: false }, flags, isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: input => `Équipe ${input.team}`,
    async execute(input) { const active = teams().form(input.team); changed("team_created"); return textOutcome(JSON.stringify({ ...active, folder: storeDirectoryReference(active.folder), tasksFile: storeReference(active.tasksFile), leader: "lead" })); },
  };
  const disband: Tool<Record<string, never>> = {
    name: "disband_team", description: () => "Dissolve only your own local team after every teammate has stopped. Idle teammates are still alive; ask them to shut down first. This deletes its task list and mailboxes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, flags: () => ({ ...flags(), destructive: true }), isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: () => "Dissoudre l'équipe",
    async execute() { teams().disband(); changed("team_removed"); return textOutcome("Team dissolved."); },
  };
  return [form, disband] as Tool<never>[];
}
interface TeamMessage { readonly to: string; readonly message: string | { readonly type: "shutdown_request" | "shutdown_response"; readonly approve?: boolean; readonly reason?: string }; readonly summary?: string }
export function teamMessageTool(base: Tool<never>, teams: () => Teams, actor = "lead"): Tool<never> {
  const original = base as Tool<{ to: string; message: string; summary?: string }>;
  const local = (input: TeamMessage) => !!teams().active && (input.to === "*" || teams().has(input.to));
  const tool: Tool<TeamMessage> = {
    ...original,
    description: () => "Send an untrusted peer message to a named teammate, lead, or * for all other team members. Use a structured shutdown_request from the leader and shutdown_response with approve=true from the requested teammate. Outside the team, only explicitly enabled and permitted local session addresses are supported.",
    inputSchema: { type: "object", properties: { to: { type: "string", minLength: 1, maxLength: 64 }, message: { anyOf: [{ type: "string", maxLength: 65536 }, { type: "object", properties: { type: { enum: ["shutdown_request", "shutdown_response"] }, approve: { type: "boolean" }, reason: { type: "string", maxLength: 1000 } }, required: ["type"], additionalProperties: false }] }, summary: { type: "string", maxLength: 500 } }, required: ["to", "message"], additionalProperties: false },
    flags: input => local(input) ? { readOnly: false, concurrencySafe: false, destructive: false, requiresPermission: true, openWorld: false } : original.flags(input as never),
    ruleSubject: input => ({ kind: "name", name: input.to }),
    permissionContribution: input => local(input) ? "allow" : undefined,
    validate: (input, ctx) => local(input) ? undefined : actor !== "lead" || typeof input.message !== "string" || !/^[a-f0-9-]{36}$/.test(input.to) ? "Unknown team destination. Discover permitted local sessions with list_peers." : original.validate?.(input as never, ctx),
    summary: input => `Message à ${input.to}`,
    async execute(input, ctx) {
      if (!local(input)) { if (actor !== "lead" || typeof input.message !== "string" || !/^[a-f0-9-]{36}$/.test(input.to)) return textOutcome("Unknown team destination.", true, "permission_denied"); return original.execute(input as never, ctx); }
      if (typeof input.message === "string") return textOutcome(JSON.stringify({ deposited: teams().send(actor, input.to, input.message) }));
      if (input.message.type === "shutdown_request") { for (const name of input.to === "*" ? teams().members.filter(member => member.state !== "stopped").map(member => member.name) : [input.to]) teams().shutdown(actor, name); return textOutcome("Shutdown requested."); }
      if (input.to !== "lead" || actor === "lead" || input.message.approve !== true) return textOutcome("Shutdown acknowledgement refused.", true, "permission_denied");
      teams().acknowledge(actor); return textOutcome("Shutdown acknowledged.");
    },
  };
  return tool as Tool<never>;
}
