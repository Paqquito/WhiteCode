// Implements: SPEC-CFG-003 (§ 5.3 registry > file, FA-02, CA-02), gap E-123.
import type { Identity } from "../identity/identity";
import { readWindowsRegistryPolicy, type RegistryPolicyReader } from "../platform/registry";
import type { SystemInfo } from "../platform/system";
import { validateManagedPolicy, type PolicyValidation } from "./managed-policy";

export interface ManagedRegistry {
  readonly name: string;
  read(): PolicyValidation;
}

export function managedRegistry(identity: Identity, system: SystemInfo, reader?: RegistryPolicyReader): ManagedRegistry | undefined {
  if (system.platform !== "windows") return undefined;
  const key = identity.get("MANAGED_REGISTRY_KEY").replace(/\\+/g, "\\");
  const name = `HKLM\\${key}\\Policy`;
  const read = reader ?? (() => readWindowsRegistryPolicy(key));
  return { name, read() {
    let source;
    try { source = read(); } catch { source = { error: "unavailable" }; }
    if (source.error !== undefined) return { required: true, settingsText: undefined, issues: [{ code: "ERR-03", severity: "error", kind: "policy", scope: "managed", message: `Canal de registre géré invalide ou illisible : ${name} (${source.error}). Périmètre inconnu ; fonctions d'agent bloquées.` }] };
    const policy = validateManagedPolicy(source.text);
    if (!source.writable) return { ...policy, issues: policy.issues.map((issue) => ({ ...issue, message: `${name} : ${issue.message}` })) };
    const issue = { code: "ERR-03", severity: policy.required ? "error" as const : "warning" as const, kind: "policy" as const, scope: "managed" as const, message: `Canal de registre géré modifiable sans autorité administrateur : ${name}.${policy.required ? " Politique obligatoire invalide ; fonctions d'agent bloquées." : " Faites protéger cette source par votre administrateur."}` };
    return { ...policy, settingsText: policy.required ? undefined : policy.settingsText, issues: [...policy.issues, issue] };
  } };
}
