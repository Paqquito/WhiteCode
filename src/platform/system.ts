// Supports: SPEC-PER-010 (§ 5.3 path normalisation), SPEC-OUT-002 (ENF-02 Windows and POSIX paths)
// Runtime adapter: operating system facts and path helpers. The only module allowed to use runtime-specific APIs.

import { homedir as osHomedir, platform as osPlatform, release as osRelease, arch as osArch, tmpdir as osTmpdir } from "node:os";
import { isAbsolute, join, normalize, resolve as resolvePath, sep, win32 } from "node:path";
import { realpathSync } from "node:fs";

export type PlatformName = "windows" | "macos" | "linux" | "other";

export interface SystemInfo {
  readonly platform: PlatformName;
  readonly arch: string;
  readonly release: string;
  readonly home: string;
  readonly tmp: string;
}

export function currentPlatform(): PlatformName {
  switch (osPlatform()) {
    case "win32":
      return "windows";
    case "darwin":
      return "macos";
    case "linux":
      return "linux";
    default:
      return "other";
  }
}

export function systemInfo(): SystemInfo {
  return { platform: currentPlatform(), arch: osArch(), release: osRelease(), home: osHomedir(), tmp: realPathOrSelf(osTmpdir()) };
}

/** True for an absolute path on the current platform (drive letter or UNC on Windows). */
export function isAbsolutePath(path: string, platform: PlatformName = currentPlatform()): boolean {
  if (platform === "windows") return win32.isAbsolute(path) && (/^[A-Za-z]:[\\/]/.test(path) || /^[\\/]{2}[^\\/]/.test(path));
  return isAbsolute(path);
}

/** Expands a leading `~/` (or `~` alone) to the home directory. */
export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(home, path.slice(2));
  return path;
}

export function absolute(path: string, base: string): string {
  return normalize(isAbsolute(path) ? path : resolvePath(base, path));
}

/** Real path when the target exists, otherwise the normalised path itself. */
export function realPathOrSelf(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return normalize(path);
  }
}

/** Canonical form used for path comparisons: forward slashes, lower case on case-insensitive systems. */
export function comparablePath(path: string, platform: PlatformName = currentPlatform()): string {
  const slashed = path.split(sep).join("/").replace(/\\/g, "/");
  return platform === "windows" || platform === "macos" ? slashed.toLowerCase() : slashed;
}

/** True when `child` is `parent` or lies inside it. */
export function isWithin(child: string, parent: string, platform: PlatformName = currentPlatform()): boolean {
  const c = comparablePath(child, platform).replace(/\/+$/, "");
  const p = comparablePath(parent, platform).replace(/\/+$/, "");
  return c === p || c.startsWith(`${p}/`);
}

/** Absolute path of an executable found on the search path, or undefined. */
export function findExecutable(name: string): string | undefined {
  return Bun.which(name) ?? undefined;
}
