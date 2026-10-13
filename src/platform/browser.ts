// Supports: SPEC-MCP-006, SPEC-OUT-029 (human-approved authorization URL, no shell interpolation), gap E-155.
import { findExecutable, type PlatformName } from "./system";
import { runToCompletion } from "./process";
/** The caller validates the URL and obtains human consent before invoking this launcher. */
export function openAuthorizationUrl(url: string, platform: PlatformName, cwd: string, environment: Readonly<Record<string, string>>, powerShell?: string): boolean {
  if (platform === "windows") {
    if (!powerShell) return false;
    return runToCompletion(powerShell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `Start-Process -WindowStyle Hidden -FilePath '${url.replace(/'/g, "''")}'`], { cwd, env: environment, timeoutMs: 2000 }).code === 0;
  }
  const launcher = findExecutable(platform === "macos" ? "open" : "xdg-open");
  return launcher !== undefined && runToCompletion(launcher, [url], { cwd, env: environment, timeoutMs: 2000 }).code === 0;
}
