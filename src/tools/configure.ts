// Implements: SPEC-OUT-039 (whitelisted preferences, direct human confirmation, user scope).
// Supports: SPEC-CFG-001, SPEC-CFG-002, E-157.
import { textOutcome, type Tool } from "./types";
import { CONFIGURE_KEYS } from "../config/tool-preferences";

export interface ConfigureValue { readonly value: unknown; readonly source: string; readonly managed: boolean }
export interface ConfigureAccess {
  allowed(): readonly string[];
  read(key: string): ConfigureValue;
  validate(key: string, value: unknown): string | undefined;
  confirm(key: string, before: unknown, after: unknown, signal: AbortSignal): Promise<boolean>;
  write(key: string, value: unknown, signal: AbortSignal): Promise<{ value: unknown; source: string; applied: "now" | "next-session"; masked: boolean }>;
}

export function configureTool(access: ConfigureAccess): Tool<{ setting: string; value?: boolean | string }> {
  return {
    name: "configure",
    inputSchema: { type: "object", properties: { setting: { type: "string", enum: [...CONFIGURE_KEYS] }, value: { type: ["boolean", "string"] } }, required: ["setting"], additionalProperties: false },
    description: () => "Read an explicitly allowed user preference, or change it when the user asks. Every change requires direct human confirmation. Permission, security, hook and connector settings are never accessible.",
    flags: input => ({ readOnly: !Object.hasOwn(input, "value"), concurrencySafe: !Object.hasOwn(input, "value"), destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow",
    validate(input) {
      if (!CONFIGURE_KEYS.includes(input.setting as typeof CONFIGURE_KEYS[number]) || !access.allowed().includes(input.setting)) return "This preference is not accessible through configure.";
      if (Object.hasOwn(input, "value")) {
        if (access.read(input.setting).managed) return "The organisation controls this preference.";
        return access.validate(input.setting, input.value);
      }
    },
    async execute(input, ctx) {
      // Recheck in execute too: policy and settings may change while the call waits.
      if (!access.allowed().includes(input.setting)) return textOutcome("This preference is unavailable.", true, "permission_denied");
      const before = access.read(input.setting);
      if (!Object.hasOwn(input, "value")) return textOutcome(JSON.stringify(before));
      if (before.managed || !await access.confirm(input.setting, before.value, input.value, ctx.signal)) return textOutcome("The human did not confirm this change.", true, "permission_denied");
      ctx.signal.throwIfAborted();
      const next = access.read(input.setting);
      if (next.managed || !access.allowed().includes(input.setting) || JSON.stringify(next.value) !== JSON.stringify(before.value)) return textOutcome("The preference changed while confirmation was pending; request a new confirmation.", true, "permission_denied");
      const problem = access.validate(input.setting, input.value);
      if (problem) return textOutcome(problem, true, "invalid_input");
      return textOutcome(JSON.stringify(await access.write(input.setting, input.value, ctx.signal)));
    },
    summary: input => Object.hasOwn(input, "value") ? `Configure ${input.setting}` : `Read preference ${input.setting}`,
  };
}
