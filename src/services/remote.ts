// Supports: SPEC-MOD-013 (CA-02), SPEC-CMD-104 (resident service composition).
import { hostname } from "node:os";
import { createHash } from "node:crypto";
import type { AdminDependencies } from "../admin/subcommands";
import { configuredCompanyAccount } from "../auth/company-runtime";
import { configuredNetwork, configuredNetworkSettings } from "../config/network";
import { loadConfiguration } from "../config/load";
import { ManagedPolicyGuard } from "../config/managed-policy";
import { PUBLIC_SECRET_VARIABLES } from "../config/environment";
import { nativeCredentialVault } from "../platform/credential-vault";
import { connectNetworkWebSocket } from "../platform/socket-network";
import { limitsSource } from "../permissions/limits-source";
import { RemoteEnvironment, environmentDirectory } from "../remote/environment";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
import type { ResidentSupervisor } from "./supervisor";

/** One exposure per resident profile, independent of every requesting terminal's lifetime. */
export class ResidentRemote {
  #environment?: RemoteEnvironment;
  #boot?: Promise<unknown>;
  #config?: string;
  #stopping?: Promise<void>;
  constructor(readonly deps: AdminDependencies, readonly supervisor: ResidentSupervisor) {}
  state(): unknown { return this.#environment?.state ?? { active: false }; }
  async start(body: Record<string, unknown>): Promise<unknown> {
    if (!buildFlag("remote_control") || !buildFlag("mode_resident_service") || this.deps.env.ownBoolean("OFFLINE_MINIMAL") || Object.keys(body).some(key => !["cwd", "name", "capacity", "binding"].includes(key)) || typeof body["binding"] !== "string" || !/^[a-f0-9]{64}$/.test(body["binding"])) throw Error("Exposition distante indisponible.");
    const root = environmentDirectory(body["cwd"]), configuration = loadConfiguration({ ...this.deps, cwd: root, policyCapability: "remote" });
    const capacity = body["capacity"] ?? configuration.firstPass.get<number>("remote.capacity"), name = body["name"] ?? hostname();
    if (typeof name !== "string" || typeof capacity !== "number") throw Error("Nom ou capacité invalide.");
    const signature = JSON.stringify([root, capacity, name, body["binding"]]);
    if (this.#stopping) await this.#stopping;
    if (this.#environment?.state.active || this.#boot) {
      if (signature !== this.#config) throw Error("Un environnement est déjà inscrit pour ce profil ; arrêtez-le avant de le remplacer.");
      return this.#boot ?? this.#environment!.state;
    }
    if (!this.deps.identity.has("SERVICE_WEB_APP") || !this.deps.identity.has("SERVICE_REMOTE_SESSIONS")) throw Error("Service de contrôle absent de cette distribution.");
    const vault = this.deps.credentialVault ?? nativeCredentialVault({ environment: this.deps.env.childEnvironment() });
    const account = configuredCompanyAccount(this.deps.identity, configuration.locations.configDir, () => loadConfiguration({ ...this.deps, cwd: root, policyCapability: "remote" }).firstPass, vault, this.deps.companyFetch ?? configuredNetwork(this.deps.env));
    if (!account || !(await account.profile())) throw Error("Connectez un compte de la société ; une clé d’API seule ne permet pas l’exposition du poste.");
    const binding = await account.sessionBinding();
    if (!binding || createHash("sha256").update(binding).digest("hex") !== body["binding"]) throw Error("Compte modifié depuis la demande du client.");
    const guard = new ManagedPolicyGuard(configuration.locations.managedSettingsFile, this.deps.identity.resolved.policyAnchor, configuration.systemPolicy, this.deps.policyFileProtection, configuration.cachePolicy);
    const assertPolicy = () => {
      this.deps.assertPolicy?.();
      const issues = guard.check("remote"); if (issues.length) throw Error(issues.map(issue => issue.message).join("\n"));
      if (limitsSource({ managedDir: configuration.locations.managedDir, configDir: configuration.locations.configDir, organizationId: this.deps.identity.resolved.policyAnchor?.organizationId, protection: this.deps.policyFileProtection, report: () => {} }).authority().required) throw Error("Source obligatoire de limites de compte non satisfaite par le service résident ; exposition refusée.");
    };
    const secrets = PUBLIC_SECRET_VARIABLES.map(name => this.deps.env.public(name)).filter((value): value is string => !!value);
    const environment = new RemoteEnvironment({ account, initialBinding: body["binding"], vault, vaultService: this.deps.identity.get("KEYCHAIN_SERVICE") + ":remote-devices", root, name, capacity,
      serviceUrl: this.deps.identity.get("SERVICE_REMOTE_SESSIONS"), webUrl: this.deps.identity.get("SERVICE_WEB_APP"), assertPolicy,
      redact: value => secrets.reduce((safe, secret) => safe.split(secret).join("[redacted credential]"), value), report: () => {},
      connect: (url, headers, handlers) => connectNetworkWebSocket(url, headers, handlers, configuredNetworkSettings(this.deps.env)),
      workers: { create: (id, cwd, prompt, binding) => this.supervisor.createRemote(id, cwd, prompt, binding), list: binding => this.supervisor.remoteWorkers(binding) },
    });
    this.#environment = environment; this.#config = signature;
    const boot = environment.start(AbortSignal.timeout(20000)).then(() => {
      if (!environment.state.active) throw Error("L’exposition a été arrêtée pendant son démarrage.");
      return environment.state;
    }).catch(async error => { await environment.close(); if (this.#environment === environment) this.#environment = undefined; throw error; }).finally(() => { if (this.#boot === boot) this.#boot = undefined; });
    this.#boot = boot; return boot;
  }
  stop(): Promise<void> {
    if (this.#stopping) return this.#stopping;
    const environment = this.#environment;
    this.#stopping = (async () => { await environment?.close(); if (this.#environment === environment) { this.#environment = undefined; this.#config = undefined; } })().finally(() => { this.#stopping = undefined; });
    return this.#stopping;
  }
  async revoke(body: Record<string, unknown>): Promise<{ revoked: boolean }> {
    if (Object.keys(body).some(key => !["id", "instance", "binding"].includes(key)) || typeof body["id"] !== "string" || typeof body["instance"] !== "string" || typeof body["binding"] !== "string") throw Error("Révocation d’environnement invalide.");
    const state = this.#environment?.state;
    if (!state || state.id !== body["id"] || state.instance !== body["instance"] || state.binding !== body["binding"]) return { revoked: false };
    // The comparison and capture in stop() contain no await: a newer exposure cannot be revoked.
    await this.stop(); return { revoked: true };
  }
}
