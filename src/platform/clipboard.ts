// Implements: SPEC-CMD-015 (CA-01, EF-01, FA-01/02), gap E-151.
import { spawnSync } from "node:child_process";

export async function copyText(text: string): Promise<boolean> {
  const candidates = process.platform === "win32" ? [["clip.exe"]] : process.platform === "darwin" ? [["pbcopy"]] : [["wl-copy"], ["xclip", "-selection", "clipboard"]];
  for (const [command, ...args] of candidates) {
    const input = process.platform === "win32" ? Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]) : text;
    const result = spawnSync(command!, args, { input, windowsHide: true, timeout: 2000, stdio: ["pipe", "ignore", "ignore"] });
    if (!result.error && result.status === 0) return true;
  }
  return false;
}
