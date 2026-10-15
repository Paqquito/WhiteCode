// Implements: SPEC-OUT-032/047 (validated tool calls and explicit confirmations); supports SPEC-EXT-027, gap E-184.
import type { CloudWorkflows } from "./workflows";
import { textOutcome, type Tool } from "../tools/types";
export function remoteWorkflowTools(
  client: CloudWorkflows,
): readonly Tool<never>[] {
  const failure = (error: unknown) => {
    const message =
      error instanceof Error ? error.message : "Remote operation failed.";
    client.options.report(message);
    return textOutcome(
      message.startsWith("Connectez")
        ? "Company account required: ask the user to connect using /login before using hosted services."
        : "Remote operation unavailable or refused. Its result could not be confirmed. Do not retry a mutating request automatically; ask the user to check the displayed service or policy error.",
      true,
      "unavailable",
    );
  };
  const triggers: Tool<{
    action: string;
    routine_id?: string;
    body?: Record<string, unknown>;
  }> = {
    name: "start_remote_run",
    description: () =>
      "Manage hosted scheduled agents. Actions: create, list, get, update, run, delete. Mutating actions require the user's explicit confirmation. Provide body with prompt, five-field cron and IANA timeZone for create/update; routine_id for get/update/run/delete. Never include local credentials. Daily and weekly schedules are supported; the product shows the exact cron and local time before creating anything.",
    inputSchema: {
      type: "object",
      properties: {
        action: { enum: ["create", "list", "get", "update", "run", "delete"] },
        routine_id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,128}$" },
        body: {
          type: "object",
          properties: {
            prompt: { type: "string", minLength: 1, maxLength: 16000 },
            cron: { type: "string", minLength: 1, maxLength: 128 },
            timeZone: { type: "string", minLength: 1, maxLength: 128 },
          },
          required: ["prompt", "cron", "timeZone"],
          additionalProperties: false,
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
    flags: (input) => ({
      readOnly: ["list", "get"].includes(input.action),
      concurrencySafe: false,
      destructive: false,
      requiresPermission: false,
      openWorld: true,
    }),
    isEnabled: () => true,
    ruleSubject: (input) => ({
      kind: "name",
      name: input.routine_id ?? input.action,
    }),
    permissionContribution: () => "allow",
    summary: (input) => `Déclencheur distant : ${input.action}`,
    async execute(input, ctx) {
      try {
        return textOutcome(
          await client.triggers(
            input.action,
            {
              ...(input.body ?? {}),
              ...(input.routine_id ? { id: input.routine_id } : {}),
            },
            ctx.signal,
          ),
        );
      } catch (error) {
        return failure(error);
      }
    },
  };
  const suggest: Tool<{ title: string; reason: string; prompt: string }> = {
    name: "suggest_background_merge_request",
    description: () =>
      "Propose a small independent follow-up task for a hosted agent and separate merge request. Explain the title, reason and autonomous prompt. The product asks the human before creating any work. Never repeat a declined proposal; proposals are limited per session.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: 240 },
        reason: { type: "string", minLength: 1, maxLength: 2000 },
        prompt: { type: "string", minLength: 1, maxLength: 16000 },
      },
      required: ["title", "reason", "prompt"],
      additionalProperties: false,
    },
    flags: () => ({
      readOnly: false,
      concurrencySafe: false,
      destructive: false,
      requiresPermission: false,
      openWorld: true,
    }),
    isEnabled: () => true,
    ruleSubject: () => ({ kind: "none" }),
    permissionContribution: () => "allow",
    summary: (input) => input.title,
    async execute(input, ctx) {
      try {
        return textOutcome(await client.suggest(input, ctx.signal));
      } catch (error) {
        return failure(error);
      }
    },
  };
  return [triggers as Tool<never>, suggest as Tool<never>];
}
