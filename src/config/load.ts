// Implements: SPEC-CFG-001 (§ 5.1 sources by scope, § 5.3 loading with the project trust), SPEC-PER-016 (trust decision before the project settings)
// Supports: SPEC-CFG-003 (CA-07, reject the mandatory version as a whole), gap E-120.
// Shared by the agent run and the administration sub-commands.

import type { Identity } from "../identity/identity";
import type { SystemInfo } from "../platform/system";
import type { EnvironmentView } from "./environment";
import { computeLocations, type Locations } from "./locations";
import { validateManagedPolicy } from "./managed-policy";
import { readSettingsFile, Settings, type ScopeSource } from "./settings";
import type { Scope } from "./settings-schema";
import { decideTrust, readUserState } from "./trust";

export interface LoadRequest {
  readonly identity: Identity;
  readonly env: EnvironmentView;
  readonly cwd: string;
  readonly system: SystemInfo;
  readonly managedDir?: string;
  /** `cli` scope source (`--config-source`). */
  readonly cliSource?: ScopeSource;
  readonly cliValues?: Record<string, unknown>;
  readonly allowedScopes?: readonly Scope[];
  /** `--allow-project-trust` (decision D-13). */
  readonly trustOption?: boolean;
}

export interface LoadedConfiguration {
  readonly locations: Locations;
  readonly sources: readonly ScopeSource[];
  /** Settings without the project scopes: the managed policy used before the trust decision. */
  readonly firstPass: Settings;
  readonly settings: Settings;
  readonly trust: ReturnType<typeof decideTrust>;
}

export function scopeSources(locations: Locations): ScopeSource[] {
  return [
    { scope: "managed", name: locations.managedSettingsFile, text: readSettingsFile(locations.managedSettingsFile) },
    { scope: "user", name: locations.userSettingsFile, text: readSettingsFile(locations.userSettingsFile) },
    { scope: "project", name: locations.projectSettingsFile, text: readSettingsFile(locations.projectSettingsFile) },
    { scope: "local", name: locations.localSettingsFile, text: readSettingsFile(locations.localSettingsFile) },
  ];
}

/** Loads every scope: a first pass without the project settings gives the managed policy used by the trust decision. */
export function loadConfiguration(r: LoadRequest): LoadedConfiguration {
  const locations = computeLocations(r.identity, r.env, r.cwd, r.system, r.managedDir);
  const sources = scopeSources(locations);
  if (r.cliSource) sources.push(r.cliSource);
  const policy = validateManagedPolicy(sources.find((s) => s.scope === "managed")?.text);
  const validatedSources = sources.map((s) => s.scope === "managed" ? { ...s, text: policy.settingsText } : s);
  const loadOptions = { sources: validatedSources, environment: r.env.settingsLayer(), cliValues: r.cliValues ?? {}, allowedScopes: r.allowedScopes };
  const firstPass = Settings.load({ ...loadOptions, projectTrusted: false });
  firstPass.issues.push(...policy.issues);
  const trust = decideTrust({
    projectRoot: locations.projectRoot,
    userState: readUserState(locations.userStateFile),
    managedTrustedDirectories: firstPass.get<string[]>("permissions.trustedDirectories"),
    trustOption: r.trustOption === true,
    platform: r.system.platform,
  });
  const settings = Settings.load({ ...loadOptions, projectTrusted: trust.trusted });
  settings.issues.push(...policy.issues);
  return { locations, sources, firstPass, settings, trust };
}
