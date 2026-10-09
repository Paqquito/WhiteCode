// Implements: SPEC-CFG-003 (§ 5.1 registry/profile, § 5.3 system channel > file, FA-02, CA-02), gaps E-123, E-125.
import type { Identity } from "../identity/identity";
import { readWindowsRegistryPolicy, type RegistryPolicyReader } from "../platform/registry";
import { readMacManagedProfile, type ProfilePolicyReader } from "../platform/managed-profile";
import type { SystemInfo } from "../platform/system";
import { validateManagedPolicy, type PolicyValidation } from "./managed-policy";

export interface ManagedSystemPolicy {
  readonly name: string;
  readonly kind: "registry" | "profile";
  read(): PolicyValidation;
}

export function managedSystemPolicy(identity: Identity, system: SystemInfo, registryReader?: RegistryPolicyReader, profileReader?: ProfilePolicyReader): ManagedSystemPolicy | undefined {
  if (system.platform === "windows") return managedRegistry(identity, system, registryReader);
  if (system.platform !== "macos") return undefined;
  const domain = identity.get("MANAGED_POLICY_DOMAIN");
  return managedChannel(`${domain}/Policy`, "profile", profileReader ?? (() => readMacManagedProfile(domain)));
}

export function managedRegistry(identity: Identity, system: SystemInfo, reader?: RegistryPolicyReader): ManagedSystemPolicy | undefined {
  if (system.platform !== "windows") return undefined;
  const key = identity.get("MANAGED_REGISTRY_KEY").replace(/\\+/g, "\\");
  const name = `HKLM\\${key}\\Policy`;
  const read = reader ?? (() => readWindowsRegistryPolicy(key));
  return managedChannel(name, "registry", read);
}

function managedChannel(name: string, kind: ManagedSystemPolicy["kind"], read: RegistryPolicyReader): ManagedSystemPolicy {
  const label = kind === "registry" ? "de registre" : "de profil macOS";
  return { name, kind, read() {
    let source;
    try { source = read(); } catch { source = { error: "unavailable" }; }
    if (source.error !== undefined) return { required: true, settingsText: undefined, issues: [{ code: "ERR-03", severity: "error", kind: "policy", scope: "managed", message: `Canal ${label} géré invalide ou illisible : ${name} (${source.error}). Périmètre inconnu ; fonctions d'agent bloquées.` }] };
    const policy = validateManagedPolicy(source.text);
    if (!source.writable) return { ...policy, issues: policy.issues.map((issue) => ({ ...issue, message: `${name} : ${issue.message}` })) };
    const issue = { code: "ERR-03", severity: policy.required ? "error" as const : "warning" as const, kind: "policy" as const, scope: "managed" as const, message: `Canal ${label} géré modifiable sans autorité administrateur : ${name}.${policy.required ? " Politique obligatoire invalide ; fonctions d'agent bloquées." : " Faites protéger cette source par votre administrateur."}` };
    return { ...policy, settingsText: policy.required ? undefined : policy.settingsText, issues: [...policy.issues, issue] };
  } };
}
