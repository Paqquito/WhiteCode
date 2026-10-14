// Implements: SPEC-OUT-036 (CA-01/02, validation and explicit non-error suppression).
// Supports: SPEC-INT-020, gap E-162.
import type { NotificationReply } from "../notifications/session";
import { containsSecret } from "../shared/secrets";
import { textOutcome, type Tool } from "./types";
export function createNotifyDeviceTool(notify: (message: string, signal: AbortSignal) => Promise<NotificationReply>, redact: (message: string) => string): Tool<{ message: string }> {
  return {
    name: "notify_device", description: () => "Send a brief device notification only for something requiring the user's action. Do not notify routine progress or expose secrets or code. Notifications may be suppressed by focus, preferences, channel availability or the hourly limit.",
    inputSchema: { type: "object", properties: { message: { type: "string", minLength: 1, maxLength: 199, pattern: "^[^\\r\\n\\u0000-\\u001f\\u007f]+$" } }, required: ["message"], additionalProperties: false },
    flags: () => ({ readOnly: true, concurrencySafe: false, destructive: false, requiresPermission: false, openWorld: false }),
    isEnabled: () => true, ruleSubject: () => ({ kind: "none" }), permissionContribution: () => "allow", summary: () => "Notify the user",
    async execute(input, ctx) {
      ctx.signal.throwIfAborted();
      if (containsSecret(input.message) || redact(input.message) !== input.message || /[`\r\n\u0000-\u001f\u007f]/.test(input.message) || [...input.message].length >= 200) return textOutcome("Notification not sent: sensitive or invalid content.");
      const result = await notify(input.message, ctx.signal);
      return textOutcome(result.sent ? "Notification sent." : `Notification not sent: ${result.reason ?? "unavailable"}.`);
    },
  };
}
