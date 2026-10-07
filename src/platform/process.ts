// Supports: SPEC-OUT-008 (EF-04 standard input closed, EF-06 whole process group stopped, ENF-03 no leak), SPEC-MOT-002 (RG-05 grace period),
//           SPEC-HOK-003 (payload on the standard input, standard error apart)
// Runtime adapter: child processes and process trees. The only module that starts or kills processes for the tools.

import { spawn, spawnSync } from "node:child_process";
import { currentPlatform } from "./system";

export interface ChildOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Called with each chunk of standard output or error, in arrival order. */
  readonly onData: (chunk: Buffer) => void;
  /**
   * Extra stop of the descendants that the system tree does not reach (a POSIX layer on Windows emulates `fork`,
   * so its processes are not children of the shell in the Windows tree). Called before the tree is stopped.
   */
  readonly stopDescendants?: () => void;
  /** Text written to the standard input, which is then closed (SPEC-HOK-003 EF-01); without it the input stays closed. */
  readonly input?: string;
  /** Receives the standard error separately; without it, both outputs go to `onData`. */
  readonly onErrorData?: (chunk: Buffer) => void;
}

/** Time given to the output pipes to close after the process ended: a stray descendant may hold them. */
const PIPE_DRAIN_MS = 1_000;

export interface Child {
  readonly pid: number | undefined;
  /** Exit code; null when the process was ended by a signal. */
  readonly exited: Promise<number | null>;
  /** Stops the whole process tree: polite request, then forced after `graceMs`. */
  killTree(graceMs: number): Promise<void>;
}

function killWindowsTree(pid: number): void {
  spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal); // the child leads its own process group (detached)
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Starts `file` with `args`, standard input closed, in its own process group (POSIX) so that the tree can be stopped. */
export function startChild(file: string, args: readonly string[], options: ChildOptions): Child {
  const windows = currentPlatform() === "windows";
  const child = spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    detached: !windows,
    windowsHide: true,
  });
  let done = false;
  const exited = new Promise<number | null>((resolve) => {
    child.on("error", () => {
      done = true;
      resolve(127);
    });
    child.on("close", (code) => {
      done = true;
      resolve(code);
    });
    // The process ended but a descendant still holds the pipes: stop waiting for them after a short drain.
    child.on("exit", (code) => {
      setTimeout(() => {
        if (done) return;
        done = true;
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(code);
      }, PIPE_DRAIN_MS);
    });
  });
  if (options.input !== undefined && child.stdin) {
    child.stdin.on("error", () => {}); // a command that does not read its input closes the pipe early
    child.stdin.end(options.input);
  }
  child.stdout?.on("data", (c: Buffer) => options.onData(c));
  child.stderr?.on("data", (c: Buffer) => (options.onErrorData ?? options.onData)(c));
  return {
    pid: child.pid,
    exited,
    async killTree(graceMs: number) {
      const pid = child.pid;
      if (pid === undefined || done) return;
      try {
        options.stopDescendants?.();
      } catch {
        // best effort: the tree is stopped below anyway
      }
      if (windows) {
        killWindowsTree(pid);
      } else {
        signalGroup(pid, "SIGTERM");
        const timer = new Promise<void>((r) => setTimeout(r, graceMs));
        await Promise.race([exited, timer]);
        signalGroup(pid, "SIGKILL"); // the group may outlive its leader
      }
      await Promise.race([exited, new Promise<void>((r) => setTimeout(r, graceMs + 1000))]);
    },
  };
}

/** Runs a short command to completion (detection, snapshot); output captured, time bounded. */
export function runToCompletion(file: string, args: readonly string[], options: { cwd: string; env: Readonly<Record<string, string>>; timeoutMs: number }): { code: number | null; stdout: string; stderr: string } {
  const r = spawnSync(file, [...args], { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"], timeout: options.timeoutMs, windowsHide: true, encoding: "buffer" });
  return { code: r.status, stdout: r.stdout?.toString("utf8") ?? "", stderr: r.stderr?.toString("utf8") ?? "" };
}

/** True while a process with this id exists. */
export function processExists(pid: number): boolean {
  if (currentPlatform() === "windows") {
    const r = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8", windowsHide: true });
    return (r.stdout ?? "").includes(String(pid));
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
