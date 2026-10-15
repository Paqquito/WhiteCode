// Implements: SPEC-API-028, SPEC-API-023 (configured company account, separate provider identity).
// Supports: gap E-173 (versioned client service paths supplied by the distribution).
import type { Identity } from "../identity/identity";
import type { Settings } from "../config/settings";
import type { CredentialVault } from "../platform/credential-vault";
import { CompanyAccount, type AccountProfile, type CompanyService } from "./company-account";
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
export function configuredCompanyAccount(identity: Identity, configDir: string, settings: () => Settings, vault: CredentialVault, network: typeof fetch): CompanyAccount | undefined {
  if(!buildFlag("company_account"))return undefined;
  if (!["SERVICE_OAUTH_AUTHORIZE", "SERVICE_OAUTH_TOKEN", "OAUTH_CLIENT_ID", "SERVICE_WEB_APP"].every(name => identity.has(name))) return undefined;
  const at = (base: string, path: string) => new URL(path, base.replace(/\/?$/, "/")).href;
  const web = identity.get("SERVICE_WEB_APP"), consoleUrl = identity.has("SERVICE_CONSOLE") ? identity.get("SERVICE_CONSOLE") : undefined;
  const services: Partial<Record<CompanyService, string>> = { account: at(web, "api/account/"), connectors: at(web, "api/connectors/"), events: at(web, "api/events/"), share: at(web, "api/share/") };
  if (consoleUrl) for (const name of ["settings", "policy", "memory", "metrics"] as const) services[name] = at(consoleUrl, `api/${name}/`);
  if (identity.has("SERVICE_REMOTE_SESSIONS")) { services.sessions = identity.get("SERVICE_REMOTE_SESSIONS"); services.triggers = at(identity.get("SERVICE_REMOTE_SESSIONS"), "triggers/"); }
  if(identity.has("SERVICE_SPEECH_TO_TEXT"))services.speech=identity.get("SERVICE_SPEECH_TO_TEXT");
  return new CompanyAccount({ configDir, vault, keychainService: identity.get("KEYCHAIN_SERVICE"), authorizeUrl: identity.get("SERVICE_OAUTH_AUTHORIZE"), tokenUrl: identity.get("SERVICE_OAUTH_TOKEN"), clientId: identity.get("OAUTH_CLIENT_ID"), services, fetch: network, forceOrganization: () => settings().get<string | undefined>("auth.forceOrganization") });
}
export function describeAccount(profile: AccountProfile | undefined): string {
  return profile ? `Méthode : compte de la société\nCompte : ${profile.account}\nOrganisation : ${profile.organization.name} (${profile.organization.id})\nRôles : ${profile.roles.join(", ")}\nExpiration : ${new Date(profile.expiresAt).toISOString()}` : "Compte de la société : non connecté.";
}
