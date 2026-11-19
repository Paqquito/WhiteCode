// Implements: SPEC-OUT-008 (§ 5.3 points 1, 2 and 8, § 6, EF-01, EF-05, EF-07, EF-10, ERR-01 to ERR-03, RG-01, RG-02, CA-01 to CA-04, CA-06, CA-07), SPEC-OUT-009 (§ 5.3, EF-01, EF-04 to EF-07, FA-01, CA-01, CA-03 to CA-05)
// Supports: SPEC-PER-015 (confined execution and ordinary approval for exits), SPEC-OUT-008 (FA-01, CA-05 `detached`), SPEC-AGT-017 (§ 5.3, EF-01), SPEC-PER-007 to SPEC-PER-009 (tool check, gap E-109)
// Supports: SPEC-AGT-017 (CA-02: transfer the authorized process without restarting it), gap E-147.

import { resolve } from "node:path";
import descriptionPosix from "../../prompts/tools/run_shell.md" with { type: "text" };
import descriptionPowerShell from "../../prompts/tools/run_powershell.md" with { type: "text" };
import descriptionPowerShellLegacy from "../../prompts/tools/run_powershell_5_1.md" with { type: "text" };
import { dangerousPowerShell } from "../permissions/powershell-danger";
import { normalizePowerShellPart, opaquePowerShell } from "../permissions/powershell-normalize";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
import { formatShellResult, type ShellResult } from "./shell-runtime";
import { startShellTask } from "./background-tools";
import { withChoicePipe } from "./powershell-choice";
import { analyseShellCommand, type ShellVerdict } from "../permissions/command-analysis";
import { textOutcome, type Tool, type ToolContext, type ToolOutcome } from "./types";

export interface ShellInput {
  readonly command: string;
  readonly attach_files?: readonly string[];
  readonly description?: string;
  readonly timeout?: number;
  readonly detached?: boolean;
  readonly unsandboxed?: boolean;
}

/** Time limit of a command run in the background: it runs until it ends or is stopped (SPEC-AGT-017). */
const BACKGROUND_LIMIT_MS = 24 * 3_600_000;

const schema = (what: string) => ({
  type: "object",
  properties: {
    attach_files: { type: "array", minItems: 1, maxItems: 10, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 4096 }, description: "Final output files to attach on successful foreground exit, through deliver_file with its ordinary read permissions. Relative paths use the command's starting working directory. Use for document generation." },
    command: { type: "string", minLength: 1, description: `${what} to run.` },
    description: { type: "string", maxLength: 120, description: "Short description of what the command does, shown to the user." },
    timeout: { type: "integer", minimum: 1, description: "Time limit in milliseconds." },
    detached: { type: "boolean", description: "Run in the background as a task; its id comes back at once." },
    unsandboxed: { type: "boolean", description: "Explicitly request execution outside the system sandbox. Ordinary approval and managed restrictions apply." },
  },
  required: ["command"],
  additionalProperties: false,
});

const timeoutOf = (input: ShellInput, ctx: ToolContext) => input.timeout ?? ctx.shell?.options.settings.defaultTimeoutMs ?? 180_000;

function validate(input: ShellInput, ctx: ToolContext): string | undefined {
  if (input.detached && input.attach_files) return "Attachments require a foreground command.";
  const refusal = ctx.shell?.sandboxRefusal(input.command, input.unsandboxed === true); if (refusal) return refusal;
  if (input.command.trim() === "") return "The command is empty.";
  const max = ctx.shell?.options.settings.maxTimeoutMs;
  if (input.timeout !== undefined && max !== undefined && input.timeout > max) return `The time limit cannot exceed ${max} ms.`;
  return undefined;
}

/**
 * The tool check of a command (step 5 of SPEC-PER-001): read-only inside the allowed folders, dangerous, chosen at run
 * time, or neither. The working folder is the one of the shell, where the command runs.
 */
function verdictOf(name: "run_shell" | "run_powershell", command: string, ctx: ToolContext | undefined): ShellVerdict {
  const dialect = name === "run_shell" ? "posix" : "powershell";
  if (dialect === "powershell") {
    if (opaquePowerShell(command)) return { kind: "dynamic", reason: "An interpreter escape or encoded PowerShell command requires examination." };
    const danger = dangerousPowerShell(command); // SPEC-OUT-009 RG-01: the cmdlets that always ask
    if (danger) return { kind: "dangerous", reason: danger };
  }
  // Without a context (the flags), the paths are not checked: only the nature of the command counts.
  const analysis = ctx
    ? { cwd: ctx.shell?.cwd ?? ctx.cwd, allowedDirectories: ctx.allowedDirectories, platform: ctx.platform }
    : { cwd: "/", allowedDirectories: ["/"], platform: "linux" as const, ignorePaths: true };
  return analyseShellCommand(command, dialect, analysis);
}

/** Common part of the two shell tools: a read-only command runs alongside other reads (SPEC-OUT-009 CA-02). */
function shellTool(name: "run_shell" | "run_powershell", run: (ctx: ToolContext, input: ShellInput, timeout: number) => Promise<ToolOutcome>): Omit<Tool<ShellInput>, "description" | "isEnabled" | "inputSchema"> {
  return {
    name,
    flags: (input) =>
      verdictOf(name, input.command, undefined).kind === "read_only"
        ? { readOnly: true, concurrencySafe: true, destructive: false, requiresPermission: true, openWorld: false }
        : { readOnly: false, concurrencySafe: false, destructive: true, requiresPermission: true, openWorld: true },
    // SPEC-PER-008: read-only commands are allowed; SPEC-PER-009, SPEC-PER-007 FA-02: dangerous or dynamic ones always ask.
    permissionContribution: (input, ctx) => {
      const sandbox = ctx.shell?.sandboxContribution(input.command, input.unsandboxed === true); if (sandbox) return sandbox;
      const v = verdictOf(name, input.command, ctx);
      return v.kind === "read_only" ? "allow" : v.kind === "other" ? undefined : "ask";
    },
    // EF-02 of SPEC-PER-009: the danger said in clear terms, and « No » proposed by default.
    danger: (input) => {
      const v = verdictOf(name, input.command, undefined);
      return v.kind === "dangerous" || v.kind === "dynamic" ? v.reason : undefined;
    },
    validate,
    ruleSubject: (input) => ({ kind: "command", command: input.command }),
    summary: (input) => input.description ?? `Run: ${name === "run_powershell" && buildFlag("permission_auto_approve_powershell") ? normalizePowerShellPart(input.command) : input.command}`,
    timeoutMs: (input, ctx) => timeoutOf(input, ctx),
    async execute(input, ctx) {
      if (!ctx.shell) return textOutcome("No shell is available in this session.", true, "unavailable");
      // FA-01, CA-05: a background task, under the same permissions as in the foreground (EF-01 of SPEC-AGT-017).
      if (input.detached === true) {
        if (!ctx.background) return textOutcome("Background tasks are not available in this session.", true, "unavailable");
        const id = startShellTask(ctx, "shell", input.command, input.description ?? input.command.slice(0, 80), BACKGROUND_LIMIT_MS, name === "run_powershell", input.unsandboxed === true);
        return textOutcome(`Started in the background as task ${id}. You will be notified when it ends; read its output with background_output (task_id ${id}) and stop it with background_stop.`);
      }
      return run(ctx, input, timeoutOf(input, ctx));
    },
  };
}

async function foregroundShell(ctx: ToolContext, input: ShellInput, timeout: number, powershell: boolean): Promise<ToolOutcome> {
  let transferred = false, asking = false;
  const run = (signal: AbortSignal, output?: (chunk: string) => void) => {
    if (!powershell) return ctx.shell!.runPosix(input.command, timeout, signal, output, input.unsandboxed === true);
    const execute = (pipe?: string) => ctx.shell!.runPowerShell(input.command, timeout, signal, output, input.unsandboxed === true, pipe);
    const ask = ctx.askCommandChoice;
    if (ctx.platform !== "windows" || !ask || ctx.agentName || !/\.ps1\b/i.test(input.command)) return execute();
    return withChoicePipe(async (question, active) => {
      if (transferred) return { none: true };
      asking = true;
      try { return await ask(question, active); } finally { asking = false; }
    }, signal, execute);
  };
  const startDir = ctx.shell!.cwd;
  const outcome = (r: ShellResult): ToolOutcome => {
    const failed = r.timedOut || r.interrupted || !!r.violations?.length || (!!input.attach_files && r.exitCode !== 0);
    const result = textOutcome(formatShellResult(r, timeout), failed, r.timedOut ? "timeout" : r.interrupted ? "interrupted" : r.violations?.length ? "permission_denied" : undefined);
    return !failed && input.attach_files ? { ...result, attachments: input.attach_files.map(path => resolve(startDir, path)) } : result;
  };
  const background = ctx.background;
  if (!background || ctx.agentName || input.attach_files) return outcome(await run(ctx.signal));
  const controller = new AbortController();
  const abort = () => controller.abort(ctx.signal.reason);
  if (ctx.signal.aborted) abort(); else ctx.signal.addEventListener("abort", abort, { once: true });
  const buffered: string[] = [];
  let bytes = 0, capped = false, finished = false;
  let output = (chunk: string) => {
    if (capped) return;
    bytes += Buffer.byteLength(chunk, "utf8");
    if (bytes > background.outputLimitBytes) { capped = true; buffered.push("\n[Foreground output truncated before transfer.]\n"); }
    else buffered.push(chunk);
  };
  const pending = run(controller.signal, (chunk) => output(chunk));
  let resolveTransfer!: (result: ToolOutcome) => void;
  const transfer = new Promise<ToolOutcome>((resolve) => { resolveTransfer = resolve; });
  const withdraw = background.offerForeground(() => {
    if (finished || asking || controller.signal.aborted) return undefined;
    const task = background.start("shell", input.description ?? input.command.slice(0, 80), async (signal, write) => {
      const stop = () => controller.abort(signal.reason);
      if (signal.aborted) stop(); else signal.addEventListener("abort", stop, { once: true });
      let outputFailed = false;
      try {
        for (const chunk of buffered) write(chunk);
        buffered.length = 0;
        output = capped ? () => {} : (chunk) => { try { write(chunk); } catch { outputFailed = true; stop(); } };
        const result = await pending;
        if (outputFailed) throw new Error("The background task output could not be written.");
        for (const violation of result.violations ?? []) write(`\n[${violation}]\n`);
        return { status: result.timedOut ? "timed_out" as const : result.interrupted ? "stopped" as const : result.exitCode === 0 && !result.violations?.length ? "completed" as const : "failed" as const, exitCode: result.exitCode, summary: result.cwdNotice };
      } catch (error) {
        stop(); await pending.catch(() => {}); throw error;
      } finally { signal.removeEventListener("abort", stop); }
    });
    ctx.signal.removeEventListener("abort", abort);
    transferred = true;
    resolveTransfer(textOutcome(`Moved the running command to background task ${task.id} without restarting it. Read its output with background_output (task_id ${task.id}) and stop it with background_stop.`));
    return task.id;
  });
  try { return await Promise.race([pending.then((result) => { finished = true; return outcome(result); }), transfer]); }
  finally { withdraw(); if (!transferred) ctx.signal.removeEventListener("abort", abort); }
}

export const runShellTool: Tool<ShellInput> = {
  ...shellTool("run_shell", (ctx, input, timeout) => foregroundShell(ctx, input, timeout, false)),
  inputSchema: schema("Shell command"),
  // ERR-02: without a POSIX shell (Windows), the tool is not registered.
  isEnabled: (env) => env.shells?.posix !== undefined,
  description: (env) => `${descriptionPosix.trim()}\n\nShell: ${env.shells?.posix?.name ?? "none"}.`,
};

export const runPowerShellTool: Tool<ShellInput> = {
  ...shellTool("run_powershell", (ctx, input, timeout) => foregroundShell(ctx, input, timeout, true)),
  inputSchema: schema("PowerShell command"),
  isEnabled: (env) => env.shells?.powershell !== undefined, // FA-01
  // EF-01, CA-01: the edition is stated so that the model adapts its syntax.
  description: (env) =>
    env.shells?.powershell?.edition === "5.1"
      ? `${descriptionPowerShell.trim()}\n\nEdition: Windows PowerShell 5.1.\n${descriptionPowerShellLegacy.trim()}`
      : `${descriptionPowerShell.trim()}\n\nEdition: PowerShell 7 or later.`,
};
