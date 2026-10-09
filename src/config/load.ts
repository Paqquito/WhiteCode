// Implements: SPEC-CFG-001 (§ 5.1 sources by scope, § 5.3 loading with the project trust), SPEC-PER-016 (trust decision before the project settings)
// Supports: SPEC-CFG-003 (CA-02, CA-07, CA-13, CA-14, FA-02, validate file and native system channels as a whole), gaps E-120 to E-125.
// Shared by the agent run and the administration sub-commands.

import type { Identity } from "../identity/identity";
import type { SystemInfo } from "../platform/system";
import type { EnvironmentView } from "./environment";
import { computeLocations, type Locations } from "./locations";
import { readManagedPolicy, type PolicyCapability } from "./managed-policy";
import { managedSystemPolicy, type ManagedSystemPolicy } from "./managed-system-policy";
import type { RegistryPolicyReader } from "../platform/registry";
import type { ProfilePolicyReader } from "../platform/managed-profile";
import type { PolicyFileProtectionReader } from "../platform/policy-file";
import { readSettingsFile, Settings, type ScopeSource } from "./settings";
import type { Scope } from "./settings-schema";
import { decideTrust, readUserState } from "./trust";

export interface LoadRequest {
  readonly identity: Identity;
  readonly env: EnvironmentView;
  readonly cwd: string;
  readonly system: SystemInfo;
  readonly managedDir?: string;
  readonly registryPolicyReader?: RegistryPolicyReader;
  readonly profilePolicyReader?: ProfilePolicyReader;
  readonly policyFileProtection?: PolicyFileProtectionReader;
  readonly policyCapability?: PolicyCapability;
  /** `cli` scope source (`--config-source`). */
  readonly cliSource?: ScopeSource;
  readonly cliValues?: Record<string, unknown>;
  readonly allowedScopes?: readonly Scope[];
  /** `--allow-project-trust` (decision D-13). */
  readonly trustOption?: boolean;
}

export interface LoadedConfiguration {
  readonly systemPolicy?: ManagedSystemPolicy;
  readonly locations: Locations;
  readonly sources: readonly ScopeSource[];
  /** Settings without the project scopes: the managed policy used before the trust decision. */
  readonly firstPass: Settings;
  readonly settings: Settings;
  readonly trust: ReturnType<typeof decideTrust>;
}

export function scopeSources(locations: Locations): ScopeSource[] {
  return [
    { scope: "managed", name: locations.managedSettingsFile, text: undefined }, // Replaced only by a validated policy reader.
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
  const policy = readManagedPolicy(locations.managedSettingsFile, r.identity.resolved.policyAnchor, r.policyCapability ?? "local", r.policyFileProtection);
  const validatedSources = sources.map((s) => s.scope === "managed" ? { ...s, text: policy.settingsText } : s);
  const systemPolicy = managedSystemPolicy(r.identity, r.system, r.registryPolicyReader, r.profilePolicyReader);
  const systemPolicyValue = systemPolicy?.read();
  if (systemPolicy) validatedSources.push({ scope: "managed", name: systemPolicy.name, text: systemPolicyValue?.settingsText });
  const loadOptions = { sources: validatedSources, environment: r.env.settingsLayer(), cliValues: r.cliValues ?? {}, allowedScopes: r.allowedScopes };
  const firstPass = Settings.load({ ...loadOptions, projectTrusted: false });
  firstPass.issues.push(...policy.issues);
  firstPass.issues.push(...(systemPolicyValue?.issues ?? []));
  const trust = decideTrust({
    projectRoot: locations.projectRoot,
    userState: readUserState(locations.userStateFile),
    managedTrustedDirectories: firstPass.get<string[]>("permissions.trustedDirectories"),
    trustOption: r.trustOption === true,
    platform: r.system.platform,
  });
  const settings = Settings.load({ ...loadOptions, projectTrusted: trust.trusted });
  settings.issues.push(...policy.issues);
  settings.issues.push(...(systemPolicyValue?.issues ?? []));
  return { locations, sources: validatedSources, firstPass, settings, trust, systemPolicy };
}
