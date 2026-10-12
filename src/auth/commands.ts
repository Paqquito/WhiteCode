// Implements: SPEC-CMD-040 (§ 5.3, CA-01), SPEC-API-011 (CA-02), SPEC-PER-027 (explicit consent and managed choice).
// Supports: gap E-135 (provider-key login; company account authentication is delivered separately).
import type { Identity } from "../identity/identity";
import type { Settings } from "../config/settings";
import { CredentialStore } from "./credentials";
import type { CredentialVault } from "../platform/credential-vault";

export interface AuthUi {
  secret(title: string): Promise<string | undefined>;
  confirm(title: string): Promise<boolean>;
  notice(message: string): void;
}
export type CredentialValidator = (provider: string, key: string, signal?: AbortSignal) => Promise<void>;
export function credentialStore(identity: Identity, configDir: string, settings: Settings, vault?: CredentialVault, warn?: (message: string) => void, latestSettings?: () => Settings, migrate = true): CredentialStore {
  return new CredentialStore({ service: identity.get("KEYCHAIN_SERVICE"), configDir, preference: settings.get("auth.credentialStore"), migrate, ...(vault ? { vault } : {}), ...(warn ? { warn } : {}), ...(latestSettings ? { mayUseFile: () => latestSettings().get("auth.credentialStore") !== "keychain" } : {}) });
}

export async function loginWithKey(provider: string | undefined, store: () => CredentialStore, ui: AuthUi, validate: CredentialValidator, signal?: AbortSignal, assertCurrent: () => void = () => {}): Promise<boolean> {
  if (!provider || !["anthropic", "openai", "openai_compatible"].includes(provider)) throw new Error("Choisissez un fournisseur pris en charge dans api.provider avant la connexion.");
  const value = await ui.secret("Clé d'API (saisie masquée) — ne saisissez jamais votre mot de passe");
  if (value === undefined) return false;
  if (/[\u0000-\u0020\u007f]/.test(value)) throw new Error("La clé d'API contient des caractères invalides.");
  assertCurrent();
  await validate(provider, value, signal);
  assertCurrent();
  await store().save("provider:" + provider, value, async () => {
    const accepted = await ui.confirm("Trousseau indisponible ou fichier choisi : stockage non chiffré. Accepter le fichier à droits privés ?");
    assertCurrent(); return accepted;
  }, assertCurrent);
  ui.notice("Clé acceptée par le fournisseur et enregistrée.");
  return true;
}

export async function logout(store: CredentialStore, ui: AuthUi, assertCurrent: () => void = () => {}): Promise<boolean> {
  if (!await ui.confirm("Supprimer les identifiants enregistrés du produit et terminer l'accès ?")) return false;
  assertCurrent(); await store.clear(assertCurrent);
  ui.notice("Identifiants supprimés. Les clés des archives locales sont conservées ; les variables du terminal restent sous votre contrôle.");
  return true;
}
