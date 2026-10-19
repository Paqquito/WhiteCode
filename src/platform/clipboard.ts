// Implements: SPEC-CMD-015 (CA-01, EF-01, FA-01/02), gap E-151.
import { spawnSync } from "node:child_process";
import { IMAGE_MAX_BYTES } from "../tools/image-header";
import { readProcessEnvironment } from "./environment";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };

// Implements: SPEC-INT-018 (CA-01, explicit keyboard image paste); gap E-162.
export async function readClipboardImage(environment: Readonly<Record<string, string | undefined>> = readProcessEnvironment()): Promise<Buffer | undefined> {
  if (!buildFlag("ui_native_clipboard_image")) throw Error("Native clipboard images unavailable in this build.");
  if (environment["SSH_CONNECTION"] || environment["SSH_TTY"]) return undefined;
  const windows = "Add-Type -AssemblyName System.Windows.Forms; $taskImage=[Windows.Forms.Clipboard]::GetImage(); if ($null -ne $taskImage) { $taskStream=New-Object IO.MemoryStream; try { if ($taskImage.Width*$taskImage.Height -gt 32000000) { exit 1 }; $taskImage.Save($taskStream,[Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($taskStream.ToArray()) } finally { $taskStream.Dispose(); $taskImage.Dispose() } }";
  const commands = process.platform === "win32" ? [["powershell.exe", "-NoProfile", "-NonInteractive", "-Sta", "-Command", windows]] : process.platform === "darwin" ? [["osascript", "-e", "the clipboard as «class PNGf»"]] : [["wl-paste", "--no-newline", "--type", "image/png"], ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]];
  for (const [command, ...args] of commands) {
    const result = spawnSync(command!, args, { env: environment, windowsHide: true, timeout: 2500, maxBuffer: IMAGE_MAX_BYTES * 2 + 2048, stdio: ["ignore", "pipe", "ignore"] });
    if (result.error || result.status !== 0 || !result.stdout.length) continue;
    let bytes = result.stdout;
    if (process.platform === "win32") {
      const encoded = bytes.toString("ascii").trim(); if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) continue;
      bytes = Buffer.from(encoded, "base64"); if (bytes.toString("base64") !== encoded) continue;
    } else if (process.platform === "darwin") {
      const encoded = /^«data PNGf([A-Fa-f0-9]+)»$/.exec(bytes.toString("utf8").trim())?.[1]; if (!encoded || encoded.length % 2) continue;
      bytes = Buffer.from(encoded, "hex");
    }
    if (bytes.length <= IMAGE_MAX_BYTES && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return bytes;
  }
  return undefined;
}

export async function copyText(text: string): Promise<boolean> {
  const candidates = process.platform === "win32" ? [["clip.exe"]] : process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"]];
  for (const [command, ...args] of candidates) {
    const input = process.platform === "win32" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]) : text;
    const result = spawnSync(command!, args, { input, windowsHide: true, timeout: 2000, stdio: ["pipe", "ignore", "ignore"] });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}
