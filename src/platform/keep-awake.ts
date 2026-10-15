// Implements: SPEC-INT-022 (native idle-sleep inhibition, process/thread-owned lifetime, display untouched), gap E-218.
import { dlopen } from "bun:ffi";
import { startChild } from "./process";
import { findExecutable } from "./system";
export type AwakeRelease = () => Promise<void>;
const openPowerApi = () =>
  dlopen("kernel32.dll", {
    SetThreadExecutionState: { args: ["u32"], returns: "u32" },
  });
let power: ReturnType<typeof openPowerApi> | undefined,
  leases = 0,
  previous = 0;
/** All Windows calls run synchronously on this runtime's event-loop thread; leases share its one native requirement. */
export async function acquireAwake(
  environment: Readonly<Record<string, string>>,
): Promise<AwakeRelease> {
  if (process.platform === "win32") {
    if (!leases) {
      power = openPowerApi();
      previous = power.symbols.SetThreadExecutionState(0x80000001);
      if (!previous) {
        power.close();
        power = undefined;
        throw Error("Power inhibition unavailable.");
      }
      power.symbols.SetThreadExecutionState((previous | 0x80000001) >>> 0);
    }
    leases++;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      if (--leases === 0) {
        power!.symbols.SetThreadExecutionState(previous | 0x80000000);
        power!.close();
        power = undefined;
      }
    };
  }
  const program = findExecutable(
    process.platform === "darwin" ? "caffeinate" : "systemd-inhibit",
  );
  if (!program) throw Error("Power inhibition unavailable.");
  const hold = 'printf "AWAKE_READY\\n"; cat >/dev/null';
  const args =
    process.platform === "darwin"
      ? ["-i", "/bin/sh", "-c", hold]
      : [
          "--what=sleep",
          "--mode=block",
          "--who=terminal-agent",
          "--why=Active terminal work",
          "sh",
          "-c",
          hold,
        ];
  let ready = () => {},
    reject = (error: Error) => {},
    buffer = "";
  const started = new Promise<void>((resolve, no) => {
    ready = resolve;
    reject = no;
  });
  const child = startChild(program, args, {
    cwd: "/",
    env: environment,
    keepInputOpen: true,
    onData: (bytes) => {
      buffer = (buffer + bytes.toString()).slice(-1024);
      if (buffer.includes("AWAKE_READY")) ready();
    },
    onErrorData: () => {},
  });
  const timer = setTimeout(
    () => reject(Error("Power inhibition unavailable.")),
    3000,
  );
  void child.exited.then(() => reject(Error("Power inhibitor closed.")));
  try {
    await started;
  } catch (error) {
    await child.killTree(0);
    throw error;
  } finally {
    clearTimeout(timer);
  }
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    child.input?.end();
    await child.killTree(100);
  };
}
