// Supports: SPEC-INT-020 (native local channel and bounded helpers), gap E-162.
import { spawn } from "node:child_process";
/** Arguments and standard input carry data, never shell source. No user credential reaches a helper. */
export async function notifyLocal(title: string, message: string, environment: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted || environment["SSH_CONNECTION"] || environment["SSH_TTY"]) return false;
  const windows = "Add-Type -AssemblyName System.Windows.Forms; $taskPayload=[Console]::In.ReadToEnd() | ConvertFrom-Json; $taskIcon=New-Object Windows.Forms.NotifyIcon; try { $taskIcon.Icon=[Drawing.SystemIcons]::Information; $taskIcon.Visible=$true; $taskIcon.BalloonTipTitle=$taskPayload.title; $taskIcon.BalloonTipText=$taskPayload.message; $taskIcon.ShowBalloonTip(1500); [Console]::Out.WriteLine('sent'); Start-Sleep -Milliseconds 1500 } finally { $taskIcon.Dispose() }";
  const command = process.platform === "win32" ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-Command", windows] : process.platform === "darwin" ? ["osascript", "-e", "on run argv\ndisplay notification (item 2 of argv) with title (item 1 of argv)\nend run", title, message] : ["notify-send", title, message];
  return new Promise<boolean>(resolve => {
    const child = spawn(command[0]!, command.slice(1), { env: environment, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let settled = false; const finish = (sent: boolean) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(sent); };
    const abort = () => { child.kill(); finish(false); };
    const timer = setTimeout(abort, 900);
    child.once("error", () => finish(false)); child.once("exit", code => finish(code === 0));
    let acknowledgement = "";
    child.stdout?.on("data", bytes => { if (process.platform === "win32") { acknowledgement = (acknowledgement + bytes.toString()).slice(0, 64); if (acknowledgement.includes("sent\n") || acknowledgement.includes("sent\r\n")) finish(true); } });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdin?.on("error", () => {}); child.stdin?.end(process.platform === "win32" ? JSON.stringify({ title, message }) : undefined);
  });
}
