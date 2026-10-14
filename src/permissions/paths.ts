// Implements: SPEC-PER-010 (§ 5.1 table for writes, § 5.3 points 1 to 3, FA-02, EF-01, EF-02, EF-04), SPEC-OUT-003 (§ 12 product configuration always confirmed)
// Supports: gap E-045 (list of protected locations)

import { existsSync } from "node:fs";
import { basename, dirname, join, normalize } from "node:path";
import { comparablePath, isWithin, realPathOrSelf, type PlatformName } from "../platform/system";

/** Protected locations: writing there always requires a request, whatever the mode, except `unrestricted` (EF-02). */
export interface ProtectedLocations {
  /** Trusted composition may carve out an exclusively owned worktree; its nested configuration stays protected. */
  readonly ownedWorktrees?: readonly string[];
  /** Folders protected with their whole content (product configuration, key folders). */
  readonly directories: readonly string[];
  /** Individual protected files (shell configuration of the user). */
  readonly files: readonly string[];
  /** File names protected wherever they are (project instruction files). */
  readonly fileNames: readonly string[];
  /** Path segments protected wherever they are (internal folder of the version control system). */
  readonly segments: readonly string[];
}

export const NO_PROTECTED_LOCATIONS: ProtectedLocations = { directories: [], files: [], fileNames: [], segments: [] };

export interface ProtectedLocationSources {
  readonly home: string;
  readonly userConfigDir: string;
  readonly projectConfigDir: string;
  readonly instructionFileNames: readonly string[];
}

/** Protected locations derived from the identity and the home folder (gap E-045): no product name is written here. */
export function protectedLocations(s: ProtectedLocationSources): ProtectedLocations {
  const h = (...p: string[]) => join(s.home, ...p);
  return {
    directories: [s.userConfigDir, s.projectConfigDir, h(".ssh"), h(".gnupg"), h(".aws"), h(".kube"), h(".docker")],
    files: [
      h(".bashrc"), h(".bash_profile"), h(".bash_login"), h(".bash_logout"), h(".profile"), h(".zshrc"), h(".zshenv"), h(".zprofile"),
      h(".zlogin"), h(".config", "fish", "config.fish"), h(".inputrc"), h(".gitconfig"), h(".netrc"), h(".npmrc"),
      h("Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1"), h("Documents", "PowerShell", "profile.ps1"),
      h("Documents", "WindowsPowerShell", "Microsoft.PowerShell_profile.ps1"), h("Documents", "WindowsPowerShell", "profile.ps1"),
    ],
    fileNames: s.instructionFileNames,
    segments: [".git"],
  };
}

/** Windows forms rejected because they are ambiguous (§ 5.3 point 3): device prefixes, alternate streams, legacy short names. */
export function ambiguousPathReason(path: string, platform: PlatformName): string | undefined {
  if (platform !== "windows") return undefined;
  if (/^[\\/]{2}[?.][\\/]/.test(path)) return "Device paths are not accepted.";
  if (path.slice(2).includes(":")) return "Alternate data streams are not accepted.";
  if (path.split(/[\\/]/).some((segment) => /~\d+(\.|$)/.test(segment))) return "Short (8.3) file names are not accepted: use the full name.";
  return undefined;
}

/** UNC or network path (FA-02): a request is always required. */
export function isNetworkPath(path: string, platform: PlatformName): boolean {
  return platform === "windows" && /^[\\/]{2}[^\\/?.]/.test(path);
}

/** Real path of a target that may not exist yet: real path of its nearest existing ancestor, followed by the rest (EF-01). */
export function realTargetPath(path: string): string {
  const rest: string[] = [];
  let current = normalize(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return normalize(path);
    rest.unshift(basename(current));
    current = parent;
  }
  return rest.length === 0 ? realPathOrSelf(current) : join(realPathOrSelf(current), ...rest);
}

/** Both the requested path and the real path lie inside the allowed folders (EF-01). */
export function insideAllowed(path: string, allowed: readonly string[], platform: PlatformName): boolean {
  const inside = (p: string) => allowed.some((d) => isWithin(p, d, platform));
  return inside(path) && inside(realTargetPath(path));
}

function isProtectedOne(path: string, p: ProtectedLocations, platform: PlatformName): boolean {
  if (p.directories.some(d => isWithin(path, d, platform) && !p.ownedWorktrees?.some(copy => isWithin(copy, d, platform) && isWithin(path, copy, platform)))) return true;
  const c = comparablePath(path, platform);
  if (p.files.some((f) => comparablePath(f, platform) === c)) return true;
  const segments = c.split("/");
  const name = segments[segments.length - 1] ?? "";
  if (p.fileNames.some((n) => comparablePath(n, platform) === name)) return true;
  return p.segments.some((s) => segments.slice(0, -1).includes(comparablePath(s, platform)) || name === comparablePath(s, platform));
}

/** A write to `path` (requested or real) touches a protected location. */
export function isProtectedPath(path: string, p: ProtectedLocations, platform: PlatformName): boolean {
  return isProtectedOne(path, p, platform) || isProtectedOne(realTargetPath(path), p, platform);
}

/**
 * Contribution of a writing tool to the decision (step 5 of SPEC-PER-001): protected and network locations always ask.
 * Otherwise nothing: the default applies, and `auto_edit` allows writes inside the allowed folders (step 7).
 */
export function writeContribution(path: string, p: ProtectedLocations, platform: PlatformName): "ask" | undefined {
  return isNetworkPath(path, platform) || isProtectedPath(path, p, platform) ? "ask" : undefined;
}
