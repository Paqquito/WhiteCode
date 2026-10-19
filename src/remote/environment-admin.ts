// Supports: SPEC-MOD-013 (CA-02), SPEC-CMD-104 (start/status/stop of independent resident exposure).
import { createHash } from "node:crypto";
import { hostname } from "node:os";
import type { AdminDependencies } from "../admin/subcommands";
import { loadConfiguration } from "../config/load";
import { configuredNetwork } from "../config/network";
import { configuredCompanyAccount } from "../auth/company-runtime";
import { nativeCredentialVault } from "../platform/credential-vault";
import { ensureResident } from "../services/admin";
import { readResidentEndpoint } from "../services/supervisor";
import { residentRequest } from "../services/transport";
import { environmentDirectory } from "./environment";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };

export async function remoteEnvironmentOperation(deps: AdminDependencies, operation: string, options: { name?: string; capacity?: number } = {}): Promise<Record<string, unknown>> {
  if (!buildFlag("remote_control") || !buildFlag("mode_resident_service") || deps.env.ownBoolean("OFFLINE_MINIMAL")) throw Error("Service distant résident indisponible dans cette distribution ou ce mode.");
  if (!["start", "stop", "status"].includes(operation)) throw Error("Usage : /remote-access-server [start|stop|status].");
  deps.assertPolicy?.();
  const configuration = loadConfiguration({ ...deps, policyCapability: "remote" }), root = configuration.locations.configDir;
  let endpoint = readResidentEndpoint(root);
  if (operation === "start") {
    const account = configuredCompanyAccount(deps.identity, root, () => configuration.firstPass, deps.credentialVault ?? nativeCredentialVault({ environment: deps.env.childEnvironment() }), deps.companyFetch ?? configuredNetwork(deps.env));
    const binding = await account?.sessionBinding();
    if (!account || !binding || !(await account.profile())) throw Error("Connectez un compte de la société ; une clé d’API seule ne permet pas l’exposition du poste.");
    const capacity = options.capacity ?? configuration.firstPass.get<number>("remote.capacity"), name = options.name ?? hostname(), cwd = environmentDirectory(deps.cwd);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 16 || !name.trim() || name.length > 240 || /[\x00-\x1f\x7f]/.test(name)) throw Error("Nom ou capacité d’environnement invalide.");
    endpoint = await ensureResident(deps, root, true);
    const confirmed = createHash("sha256").update(binding).digest("hex");
    const state = await residentRequest(endpoint, "/remote/start", { cwd, name, capacity, binding: confirmed }, AbortSignal.any([...(deps.signal ? [deps.signal] : []), AbortSignal.timeout(25000)]));
    let unchanged = false;
    try { unchanged = await account.sessionBinding() === binding; }
    finally { if (!unchanged) await residentRequest(endpoint, "/remote/revoke", { id: state["id"], instance: state["instance"], binding: confirmed }, AbortSignal.timeout(10000)); }
    if (!unchanged) throw Error("Compte remplacé pendant le démarrage ; révocation de cette exposition demandée.");
    return state;
  }
  if (!endpoint) return { active: false };
  return residentRequest(endpoint, operation === "stop" ? "/remote/stop" : "/remote", operation === "stop" ? {} : undefined, AbortSignal.any([...(deps.signal ? [deps.signal] : []), AbortSignal.timeout(10000)]));
}
export function remoteEnvironmentText(state: Record<string, unknown>): string {
  return state["active"] === true ? `Service distant résident actif · ${Array.isArray(state["sessions"]) ? state["sessions"].length : 0} session(s) exposée(s).\nLien d’accès : ${String(state["url"])}` : "Service distant résident arrêté.";
}
