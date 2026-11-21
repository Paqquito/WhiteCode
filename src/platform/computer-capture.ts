// Supports: SPEC-INT-015 (application-only PrintWindow in a cancellable owned helper, PNG never written to disk).
import { dlopen } from "bun:ffi";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import type { ComputerWindow } from "./computer-control";

const CAPTURE = String.raw`
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class ApplicationWindowCapture {
 [StructLayout(LayoutKind.Sequential)] struct Rect { public int left,top,right,bottom; }
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint process);
 [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window,out Rect rect);
 [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
 public static void Run(ulong value,uint process,int width,int height) {
  IntPtr window=new IntPtr(unchecked((long)value)); uint actual; Rect rect;
  if(GetWindowThreadProcessId(window,out actual)==0||actual!=process||!GetClientRect(window,out rect)||rect.right!=width||rect.bottom!=height)throw new IOException("Target changed.");
  using(Bitmap bitmap=new Bitmap(width,height,PixelFormat.Format24bppRgb)) {
   using(Graphics graphics=Graphics.FromImage(bitmap)){IntPtr dc=graphics.GetHdc();try{if(!PrintWindow(window,dc,1))throw new IOException("Application capture unavailable.");}finally{graphics.ReleaseHdc(dc);}}
   if(GetWindowThreadProcessId(window,out actual)==0||actual!=process)throw new IOException("Target changed.");
   using(MemoryStream bytes=new MemoryStream()){bitmap.Save(bytes,ImageFormat.Png);if(bytes.Length>6291456)throw new IOException("Capture too large.");Console.Write(Convert.ToBase64String(bytes.ToArray()));}
  }
 }
}
`;
/** The blocking native API runs outside the main event loop so the registered emergency shortcut remains live. */
export async function captureComputerWindow(target: ComputerWindow, parent: AbortSignal): Promise<Uint8Array> {
  parent.throwIfAborted(); const kernel = dlopen("kernel32.dll", { GetWindowsDirectoryW: { args: ["buffer", "u32"], returns: "u32" } });
  let systemRoot: string; try { const value = Buffer.alloc(65536), count = kernel.symbols.GetWindowsDirectoryW(value, 32768); if (!count || count >= 32768) throw Error("System directory unavailable."); systemRoot = value.subarray(0, count * 2).toString("utf16le"); } finally { kernel.close(); }
  if (!/^[1-9][0-9]{0,19}$/.test(target.id) || !Number.isSafeInteger(target.pid) || target.pid < 1 || !Number.isSafeInteger(target.width) || !Number.isSafeInteger(target.height) || target.width < 1 || target.height < 1 || target.width > 4096 || target.height > 4096 || target.width * target.height > 4194304) throw Error("Invalid application capture target.");
  const script = "$ErrorActionPreference='Stop'\nif ([Console]::ReadLine() -ne 'capture') { exit 1 }\nAdd-Type -AssemblyName System.Drawing\nAdd-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'\n" + CAPTURE + "\n'@\n[ApplicationWindowCapture]::Run([UInt64]" + target.id + ",[UInt32]" + target.pid + "," + target.width + "," + target.height + ")";
  const scope = AbortSignal.any([parent, AbortSignal.timeout(15000)]), chunks: Buffer[] = []; let size = 0, overflow = false;
  const jobs = dlopen("kernel32.dll", { CreateJobObjectW: { args: ["ptr", "ptr"], returns: "u64" }, SetInformationJobObject: { args: ["u64", "i32", "buffer", "u32"], returns: "i32" }, AssignProcessToJobObject: { args: ["u64", "u64"], returns: "i32" }, TerminateJobObject: { args: ["u64", "u32"], returns: "i32" }, OpenProcess: { args: ["u32", "i32", "u32"], returns: "u64" }, CloseHandle: { args: ["u64"], returns: "i32" } });
  const job = jobs.symbols.CreateJobObjectW(null, null), limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
  if (!job || !jobs.symbols.SetInformationJobObject(job, 9, limits, limits.length)) { if (job) jobs.symbols.CloseHandle(job); jobs.close(); throw Error("Private application capture job unavailable."); }
  const child = spawn(join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { cwd: tmpdir(), env: { SystemRoot: systemRoot, windir: systemRoot, PATH: join(systemRoot, "System32"), TEMP: tmpdir(), TMP: tmpdir() }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin.on("error", () => {});
  const exited = new Promise<number | null>(resolve => { child.once("error", () => resolve(127)); child.once("close", resolve); });
  const processHandle = child.pid ? jobs.symbols.OpenProcess(0x101, 0, child.pid) : 0n;
  const assigned = processHandle && jobs.symbols.AssignProcessToJobObject(job, processHandle); if (processHandle) jobs.symbols.CloseHandle(processHandle);
  if (!assigned) { child.kill("SIGKILL"); jobs.symbols.CloseHandle(job); jobs.close(); child.stdout.destroy(); child.stderr.destroy(); throw Error("Application capture cannot be isolated in a private native job."); }
  // The helper cannot compile or capture until it belongs to our kill-on-close job.
  child.stdin.end("capture\n");
  // A native job ends the exact helper and its descendants without a synchronous taskkill process.
  const stop = () => { jobs.symbols.TerminateJobObject(job, 1); };
  child.stderr.on("data", () => {}); child.stdout.on("data", (bytes: Buffer) => { size += bytes.length; if (size > 9 * 1024 * 1024) { overflow = true; stop(); } else chunks.push(bytes); });
  let aborted!: () => void; const interrupted = new Promise<null>(resolve => { aborted = () => { stop(); resolve(null); }; }); scope.addEventListener("abort", aborted, { once: true }); if (scope.aborted) aborted();
  try { const code = await Promise.race([exited, interrupted]); scope.throwIfAborted(); if (overflow || code !== 0) throw Error("Application capture unavailable; verify native screen permissions and application support."); const encoded = Buffer.concat(chunks).toString("ascii").trim(), bytes = Buffer.from(encoded, "base64"); if (bytes.toString("base64") !== encoded || bytes.length > 6291456 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw Error("Invalid application capture response."); return bytes; }
  finally { scope.removeEventListener("abort", aborted); if (scope.aborted || overflow) stop(); child.stdout.removeAllListeners("data"); child.stdout.destroy(); child.stderr.destroy(); jobs.symbols.CloseHandle(job); jobs.close(); }
}
