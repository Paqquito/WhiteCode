// Implements: SPEC-OUT-008 (§ 5.3 points 1, 2 and 8, § 6, EF-01, EF-05, EF-07, EF-10, ERR-01 to ERR-03, RG-01, RG-02, CA-01 to CA-04, CA-06, CA-07), SPEC-OUT-009 (§ 5.3, EF-01, EF-04 to EF-07, FA-01, CA-01, CA-03 to CA-05)
// Supports: decisions D-02 (no heuristic authorisation) and E-008, gap E-052 (background tasks and sandbox not delivered)

import descriptionPosix from "../../prompts/tools/run_shell.md" with { type: "text" };
import descriptionPowerShell from "../../prompts/tools/run_powershell.md" with { type: "text" };
import descriptionPowerShellLegacy from "../../prompts/tools/run_powershell_5_1.md" with { type: "text" };
import { dangerousPowerShell } from "../permissions/powershell-danger";
import { formatShellResult } from "./shell-runtime";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome } from "./types";

export interface ShellInput {
  readonly command: string;
  readonly description?: string;
  readonly timeout?: number;
}

const schema = (what: string) => ({
  type: "object",
  properties: {
    command: { type: "string", minLength: 1, description: `${what} to run.` },
    description: { type: "string", maxLength: 120, description: "Short description of what the command does, shown to the user." },
    timeout: { type: "integer", minimum: 1, description: "Time limit in milliseconds." },
  },
  required: ["command"],
  additionalProperties: false,
});

const timeoutOf = (input: ShellInput, ctx: ToolContext) => input.timeout ?? ctx.shell?.options.settings.defaultTimeoutMs ?? 180_000;

function validate(input: ShellInput, ctx: ToolContext): string | undefined {
  if (input.command.trim() === "") return "The command is empty.";
  const max = ctx.shell?.options.settings.maxTimeoutMs;
  if (input.timeout !== undefined && max !== undefined && input.timeout > max) return `The time limit cannot exceed ${max} ms.`;
  return undefined;
}

/** Common part of the two shell tools: never concurrency-safe, never allowed by the tool itself (D-02, E-008). */
function shellTool(name: "run_shell" | "run_powershell", run: (ctx: ToolContext, input: ShellInput, timeout: number) => Promise<ToolOutcome>): Omit<Tool<ShellInput>, "description" | "isEnabled" | "inputSchema"> {
  return {
    name,
    flags: () => ({ readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: true }),
    validate,
    ruleSubject: (input) => ({ kind: "command", command: input.command }),
    summary: (input) => input.description ?? `Run: ${input.command}`,
    timeoutMs: (input, ctx) => timeoutOf(input, ctx),
    async execute(input, ctx) {
      if (!ctx.shell) return textOutcome("No shell is available in this session.", true, "unavailable");
      return run(ctx, input, timeoutOf(input, ctx));
    },
  };
}

export const runShellTool: Tool<ShellInput> = {
  ...shellTool("run_shell", async (ctx, input, timeout) => {
    const r = await ctx.shell!.runPosix(input.command, timeout, ctx.signal);
    return textOutcome(formatShellResult(r, timeout), r.timedOut || r.interrupted, r.timedOut ? "timeout" : r.interrupted ? "interrupted" : undefined);
  }),
  inputSchema: schema("Shell command"),
  // ERR-02: without a POSIX shell (Windows), the tool is not registered.
  isEnabled: (env) => env.shells?.posix !== undefined,
  description: (env) => `${descriptionPosix.trim()}\n\nShell: ${env.shells?.posix?.name ?? "none"}.`,
};

export const runPowerShellTool: Tool<ShellInput> = {
  ...shellTool("run_powershell", async (ctx, input, timeout) => {
    const r = await ctx.shell!.runPowerShell(input.command, timeout, ctx.signal);
    return textOutcome(formatShellResult(r, timeout), r.timedOut || r.interrupted, r.timedOut ? "timeout" : r.interrupted ? "interrupted" : undefined);
  }),
  inputSchema: schema("PowerShell command"),
  isEnabled: (env) => env.shells?.powershell !== undefined, // FA-01
  // EF-01, CA-01: the edition is stated so that the model adapts its syntax.
  description: (env) =>
    env.shells?.powershell?.edition === "5.1"
      ? `${descriptionPowerShell.trim()}\n\nEdition: Windows PowerShell 5.1.\n${descriptionPowerShellLegacy.trim()}`
      : `${descriptionPowerShell.trim()}\n\nEdition: PowerShell 7 or later.`,
  // EF-04, RG-01: dangerous cmdlets always ask, before any allow rule (step 5 of SPEC-PER-001), except in unrestricted mode.
  permissionContribution: (input) => (dangerousPowerShell(input.command) ? "ask" : undefined),
};
