// Implements: SPEC-PER-016 (EF-01, EF-02, FA-01, FA-02), SPEC-CFG-010 (approved folders in the user state), decision D-05 (`--allow-project-trust`)
// Decides whether the project settings and active project elements may be read.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import picomatch from "picomatch";
import { comparablePath, isWithin, realPathOrSelf, type PlatformName } from "../platform/system";
import { writeAtomic } from "../tools/text-file";

export type TrustSource = "user-state" | "managed" | "option" | "none";

export interface TrustDecision {
  readonly trusted: boolean;
  readonly source: TrustSource;
}

export interface UserState {
  readonly trustedProjects?: readonly string[];
  /** SPEC-API-008 step 1: day of the last notice about each deprecated model. */
  readonly modelNotices?: Readonly<Record<string, string>>;
}

/** Writes `patch` over the user state file, keeping the other fields (SPEC-CFG-010). */
export function updateUserState(path: string, patch: Partial<UserState>, platform: PlatformName): void {
  const next = { ...readUserState(path), ...patch };
  mkdirSync(dirname(path), { recursive: true });
  writeAtomic(path, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8"), platform);
}

export function readUserState(path: string): UserState {
  if (!existsSync(path)) return {};
  try {
    const data: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof data === "object" && data !== null ? (data as UserState) : {};
  } catch {
    return {};
  }
}

export interface TrustInputs {
  readonly projectRoot: string;
  readonly userState: UserState;
  /** Glob patterns of `permissions.trustedDirectories` (managed scope). */
  readonly managedTrustedDirectories: readonly string[];
  /** `--allow-project-trust` given for this run (never persisted). */
  readonly trustOption: boolean;
  readonly platform: PlatformName;
}

export function decideTrust(input: TrustInputs): TrustDecision {
  const root = realPathOrSelf(input.projectRoot);
  // FA-02: a trusted parent folder covers its sub-folders.
  for (const approved of input.userState.trustedProjects ?? []) {
    if (typeof approved === "string" && isWithin(root, approved, input.platform)) return { trusted: true, source: "user-state" };
  }
  const comparable = comparablePath(root, input.platform);
  for (const pattern of input.managedTrustedDirectories) {
    const glob = comparablePath(pattern, input.platform).replace(/\/+$/, "");
    const matcher = picomatch([glob, `${glob}/**`], { dot: true, nocase: input.platform === "windows" });
    if (matcher(comparable)) return { trusted: true, source: "managed" };
  }
  if (input.trustOption) return { trusted: true, source: "option" };
  return { trusted: false, source: "none" };
}
