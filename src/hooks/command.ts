// Implements: SPEC-HOK-003 (§ 5.1, § 5.3 steps 1 to 4, FA-01, FA-02, EF-01, EF-03, EF-05, ERR-01, ERR-02, ENF-01)
// A `command` hook: the payload on the standard input, a JSON decision or free text on the standard output.

import { startChild } from "../platform/process";
import type { PlatformName } from "../platform/system";
import type { CommandAction } from "./config";

export interface ShellChoice {
  readonly path: string;
  readonly kind: "posix" | "powershell";
}

export interface CommandRun {
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface CommandHookOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly shell: ShellChoice;
  readonly timeoutMs: number;
  /** `hooksConfig.outputMaxSize`: beyond, the output is cut (cas limites). */
  readonly outputMaxSize: number;
  readonly platform: PlatformName;
  /** Stops the command (asynchronous hooks at the end of the session, SPEC-HOK-007 FA-01). */
  readonly signal?: AbortSignal;
}

/** Arguments that make `shell` run `command` (ENF-01: POSIX shell and PowerShell). */
function shellArgs(shell: ShellChoice, command: string): string[] {
  return shell.kind === "posix" ? ["-c", command] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
}

/** Steps 1 to 3: the command in the shell, in the project folder; the payload written then the input closed (EF-01). */
export async function runCommandHook(action: CommandAction, payload: string, o: CommandHookOptions): Promise<CommandRun> {
  const started = Date.now();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  let size = 0;
  const keep = (into: Buffer[]) => (chunk: Buffer) => {
    if (size >= o.outputMaxSize) return;
    const part = chunk.subarray(0, o.outputMaxSize - size);
    size += part.length;
    into.push(part);
  };
  const child = startChild(o.shell.path, shellArgs(o.shell, action.command), { cwd: o.cwd, env: o.env, input: payload, onData: keep(out), onErrorData: keep(err) });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void child.killTree(1_000); // FA-01: the whole process group
  }, o.timeoutMs);
  const stop = () => void child.killTree(1_000);
  o.signal?.addEventListener("abort", stop, { once: true });
  const exitCode = await child.exited;
  clearTimeout(timer);
  o.signal?.removeEventListener("abort", stop);
  return { exitCode, timedOut, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), durationMs: Date.now() - started };
}
