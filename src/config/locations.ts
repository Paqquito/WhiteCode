// Implements: SPEC-CFG-001 (§ 5.1 locations, nested projects), SPEC-CAD-002 (§ 6.3.2, Q-02 XDG), SPEC-CFG-007 (CONFIG_HOME), SPEC-CFG-003 (managed file name)
// Every location is derived from the identity: no product folder name is hard-coded.

import { existsSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Identity } from "../identity/identity";
import { comparablePath, expandHome, realPathOrSelf, type SystemInfo } from "../platform/system";
import type { EnvironmentView } from "./environment";

export interface Locations {
  readonly configDir: string;
  readonly userSettingsFile: string;
  readonly userStateFile: string;
  readonly managedDir: string;
  readonly managedSettingsFile: string;
  /** Directory that owns the project settings (nearest ancestor holding the project folder), or the working directory. */
  readonly projectRoot: string;
  readonly projectSettingsFile: string;
  readonly localSettingsFile: string;
  readonly sessionsDir: string;
}

const MANAGED_FILE = "policy.json";
const PROJECT_SETTINGS = "config.json";
const LOCAL_SETTINGS = "config.local.json";
const USER_SETTINGS = "config.json";

export function userConfigDir(identity: Identity, env: EnvironmentView, system: SystemInfo): string {
  const override = env.own("CONFIG_HOME");
  if (override) return realPathOrSelf(expandHome(override, system.home));
  const xdg = env.public("XDG_CONFIG_HOME");
  if (xdg && system.platform !== "windows") return join(xdg, identity.get("PRODUCT_SLUG"));
  return expandHome(identity.get("CONFIG_DIR"), system.home);
}

function managedDir(identity: Identity, system: SystemInfo): string {
  switch (system.platform) {
    case "windows":
      return identity.get("MANAGED_DIR_WINDOWS");
    case "macos":
      return identity.get("MANAGED_DIR_MACOS");
    default:
      return identity.get("MANAGED_DIR_LINUX");
  }
}

/**
 * Nearest ancestor of `cwd` containing the project folder; the user configuration folder never counts as a
 * project folder, although both derive from the same slug (gap E-030).
 */
export function findProjectRoot(cwd: string, projectDirName: string, configDir: string, system: SystemInfo): string {
  const configComparable = comparablePath(realPathOrSelf(configDir), system.platform);
  let current = realPathOrSelf(cwd);
  for (;;) {
    const candidate = join(current, projectDirName);
    if (existsSync(candidate) && statSync(candidate).isDirectory() && comparablePath(realPathOrSelf(candidate), system.platform) !== configComparable) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) return realPathOrSelf(cwd);
    current = parent;
  }
}

export function computeLocations(identity: Identity, env: EnvironmentView, cwd: string, system: SystemInfo, managedDirOverride?: string): Locations {
  const configDir = userConfigDir(identity, env, system);
  const projectDirName = identity.get("PROJECT_DIR");
  const projectRoot = findProjectRoot(cwd, projectDirName, configDir, system);
  const mDir = managedDirOverride ?? managedDir(identity, system);
  return {
    configDir,
    userSettingsFile: join(configDir, USER_SETTINGS),
    userStateFile: join(configDir, basename(identity.get("USER_STATE_FILE"))),
    managedDir: mDir,
    managedSettingsFile: join(mDir, MANAGED_FILE),
    projectRoot,
    projectSettingsFile: join(projectRoot, projectDirName, PROJECT_SETTINGS),
    localSettingsFile: join(projectRoot, projectDirName, LOCAL_SETTINGS),
    sessionsDir: join(configDir, "sessions"),
  };
}
