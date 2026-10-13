// Supports: SPEC-INS-001 (platform signature before activation), SPEC-CMD-035, E-156.
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { PlatformName } from "./system";

export async function verifyArtifactSignature(path: string, platform: PlatformName, systemRoot = "C:\\Windows"): Promise<void> {
  const command = platform === "windows" ? join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "/usr/bin/codesign";
  const script = `$ErrorActionPreference='Stop'; if ((Get-AuthenticodeSignature -LiteralPath '${path.replace(/'/g, "''")}').Status -ne 'Valid') { exit 1 }`;
  const args = platform === "windows" ? ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")] : ["--verify", "--deep", "--strict", path];
  if (platform !== "windows" && platform !== "macos") throw new Error("Signature de plateforme non prise en charge.");
  const env=platform==='windows' ? {SystemRoot:systemRoot,PATH:join(systemRoot,'System32')} : {PATH:'/usr/bin:/bin'};
  await new Promise<void>((resolve, reject) => execFile(command, args, { env, timeout: 15000, maxBuffer: 8192, windowsHide: true }, error => error ? reject(new Error("Signature de plateforme invalide ; installation annulée.")) : resolve()));
}
