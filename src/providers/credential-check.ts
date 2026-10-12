// Implements: SPEC-API-011 (§ 5.3 validation before storage, ERR-01, RG-01).
// Supports: gap E-135 (read-only model-list request; generic errors never echo a provider response).
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import type { EnvironmentView } from "../config/environment";
import type { Settings } from "../config/settings";
import type { CredentialValidator } from "../auth/commands";
import { configuredNetwork } from "../config/network";

export function credentialValidator(settings: Settings, env: EnvironmentView): CredentialValidator {
  return async (provider, apiKey, signal) => {
    const baseURL = provider === "anthropic" ? env.public("ANTHROPIC_BASE_URL") : settings.get<string | undefined>("api.baseUrl") ?? env.public("OPENAI_BASE_URL");
    if (provider === "openai_compatible" && !baseURL) throw new Error("URL du fournisseur compatible manquante.");
    if (baseURL) {
      const url = new URL(baseURL);
      if (url.username || url.password || !["https:", "http:"].includes(url.protocol) || url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) throw new Error("URL du fournisseur refusée : HTTPS obligatoire hors hôte local.");
    }
    const options = { apiKey, ...(baseURL ? { baseURL } : {}), fetch: configuredNetwork(env), maxRetries: 0, timeout: 10_000 };
    try {
      if (provider === "anthropic") await new Anthropic(options).models.list({ limit: 1 }, { signal });
      else await new OpenAI(options).models.list({ signal });
    } catch (error) {
      const status = (error as { status?: number }).status;
      throw new Error(signal?.aborted ? "Authentification interrompue." : [401, 403].includes(status ?? 0) ? "Clé d'API refusée par le fournisseur." : "Validation de la clé impossible : vérifiez la connexion et l'accès à la liste des modèles.");
    }
  };
}
