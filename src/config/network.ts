// Supports: SPEC-PER-022 (proxy and TLS settings shared by authentication and model requests), E-135.
import { readFileSync } from "node:fs";
import { networkFetch, type NetworkSettings } from "../platform/network";
import type { EnvironmentView } from "./environment";

export function configuredNetwork(env: EnvironmentView): typeof fetch { return networkFetch(configuredNetworkSettings(env)); }

export function configuredNetworkSettings(env: EnvironmentView): NetworkSettings {
  const pem = (name: string) => {
    const file = env.own(name);
    if (file === undefined) return undefined;
    try { return readFileSync(file, "utf8"); } catch { throw new Error(`Fichier illisible pour ${env.prefix}${name}.`); }
  };
  const proxy = (name: string) => env.public(name) ?? env.public(name.toLowerCase());
  const httpProxy = proxy("HTTP_PROXY"), httpsProxy = proxy("HTTPS_PROXY"), extraCa = pem("EXTRA_CA_CERTS"), clientCert = pem("TLS_CLIENT_CERT"), clientKey = pem("TLS_CLIENT_KEY");
  return { ...(httpProxy ? { httpProxy } : {}), ...(httpsProxy ? { httpsProxy } : {}), noProxy: (proxy("NO_PROXY") ?? "").split(","), ...(extraCa !== undefined ? { extraCa } : {}), ...(clientCert !== undefined ? { clientCert, clientKey } : {}), caHint: `variable ${env.prefix}EXTRA_CA_CERTS` };
}
