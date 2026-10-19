// Supports: SPEC-API-029, SPEC-PLA-002 (operator-run service and worker entry points).
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { HostedService } from "./service";
import type { HostedPrincipal } from "./service";
import { HostedWorker } from "./worker";
import { ModelCatalog } from "../providers/catalog";
import { ordinaryPrivateFile, readPrivateText } from "../shared/private-text";
import { startHostedHttp } from "../platform/hosted-http";
import { assertHostedControlFile } from "../platform/hosted-isolation";
import { restrictFileToOwner } from "../platform/private-file";
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function configuration(path: string): Record<string, unknown> { const raw: unknown = JSON.parse(readPrivateText(path, 1024 * 1024)); if (!object(raw)) throw Error("Configuration de service invalide."); return raw; }
function accounts(path: string): Array<HostedPrincipal & { tokenHash: string; repositories: string[] }> {
  const raw = configuration(path);
  if (!Array.isArray(raw.accounts) || raw.accounts.length > 10000 || raw.accounts.some(row => !object(row) || typeof row.account !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.account) || typeof row.organizationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(row.organizationId) || typeof row.administrator !== "boolean" || typeof row.tokenHash !== "string" || !/^[a-f0-9]{64}$/.test(row.tokenHash) || !Array.isArray(row.repositories) || !row.repositories.every(repository => typeof repository === "string" && repository.startsWith("https://")))) throw Error("Registre privé des comptes invalide.");
  return raw.accounts as Array<HostedPrincipal & { tokenHash: string; repositories: string[] }>;
}
const principal = (row: HostedPrincipal | undefined): HostedPrincipal | undefined => row ? { account: row.account, organizationId: row.organizationId, administrator: row.administrator } : undefined;
/** Opaque account tokens are issued by the distribution's account front end; this registry stores their hashes only. */
export async function startHostedServiceFile(path: string, overrides: { now?: () => number } = {}) {
  const raw = configuration(path);
  if (typeof raw.directory !== "string" || typeof raw.encryptionKeyFile !== "string" || typeof raw.accountsFile !== "string" || typeof raw.workerToken !== "string" || typeof raw.publicBaseUrl !== "string" || typeof raw.currency !== "string" || !Array.isArray(raw.providers) || !Array.isArray(raw.environments)) throw Error("Configuration du serveur incomplète.");
  const directory = resolve(raw.directory), keyFile = resolve(raw.encryptionKeyFile), inside = relative(directory, keyFile);
  if (!inside || !isAbsolute(inside) && inside !== ".." && !inside.startsWith(".." + sep)) throw Error("La clé de chiffrement doit être conservée hors du répertoire des données.");
  ordinaryPrivateFile(keyFile, 128); restrictFileToOwner(keyFile);
  const keyText = readPrivateText(keyFile, 128).trim(); if (!/^[A-Za-z0-9+/]{43}=$/.test(keyText)) throw Error("Clé de chiffrement de 32 octets requise.");
  const key = Buffer.from(keyText, "base64"), registry = resolve(raw.accountsFile);
  const providers = raw.providers.map(provider => {
    if (!object(provider) || typeof provider.id !== "string" || typeof provider.baseUrl !== "string" || !object(provider.model)) throw Error("Fournisseur de service invalide.");
    return { id: provider.id, baseUrl: provider.baseUrl, model: new ModelCatalog({ schemaVersion: 1, currency: raw.currency, models: [provider.model] }).entries[0]! };
  });
  const environments = raw.environments.map(environment => {
    if (!object(environment) || typeof environment.id !== "string" || typeof environment.provider !== "string" || !Array.isArray(environment.tools) || !environment.tools.every(tool => typeof tool === "string") || !Array.isArray(environment.connectors) || environment.connectors.length) throw Error("Environnement invalide : les connecteurs doivent être installés avant leur activation (v1 : aucun).");
    return { id: environment.id, provider: environment.provider, tools: environment.tools as string[], connectors: [] };
  });
  accounts(registry);
  const service = new HostedService({ directory, encryptionKey: key, publicBaseUrl: raw.publicBaseUrl, workerToken: raw.workerToken, currency: raw.currency, providers, environments,
    authenticate: async authorization => {
      const token = authorization?.match(/^Bearer ([\x21-\x7e]{16,4096})$/)?.[1]; if (!token) return;
      const digest = createHash("sha256").update(token).digest();
      return principal(accounts(registry).find(row => timingSafeEqual(Buffer.from(row.tokenHash, "hex"), digest)));
    },
    resolvePrincipal: async (account, organizationId) => principal(accounts(registry).find(row => row.account === account && row.organizationId === organizationId)),
    repositoryAccessible: async (repository, owner) => accounts(registry).find(row => row.account === owner.account && row.organizationId === owner.organizationId)?.repositories.includes(repository) === true,
    ...overrides,
  }); key.fill(0);
  let http: Awaited<ReturnType<typeof startHostedHttp>>;
  try {
    const tls = object(raw.tls) && typeof raw.tls.certFile === "string" && typeof raw.tls.keyFile === "string" ? { cert: readPrivateText(raw.tls.certFile, 262144), key: readPrivateText(raw.tls.keyFile, 262144) } : undefined;
    if (raw.port !== undefined && (!Number.isSafeInteger(raw.port) || Number(raw.port) < 0 || Number(raw.port) > 65535) || raw.hostname !== undefined && typeof raw.hostname !== "string") throw Error("Adresse d’écoute invalide.");
    http = await startHostedHttp(request => service.handle(request), { ...(raw.hostname ? { hostname: String(raw.hostname) } : {}), ...(raw.port !== undefined ? { port: Number(raw.port) } : {}), ...(tls ? { tls } : {}) });
    service.start();
  } catch (error) { await service.close(); throw error; }
  return { url: http.url, close: async () => { await service.close(); await http.close(); } };
}
export function hostedWorkerFile(path: string, environment: Readonly<Record<string, string>>) {
  assertHostedControlFile(resolve(path));
  const raw = configuration(path);
  if (typeof raw.root !== "string" || typeof raw.serviceUrl !== "string" || typeof raw.workerToken !== "string" || typeof raw.prefix !== "string" || typeof raw.productBinary !== "string" || !object(raw.isolation) || typeof raw.isolation.firstUid !== "number" || typeof raw.isolation.lastUid !== "number") throw Error("Configuration du travailleur incomplète : binaire installé et plage d’identités isolées requis.");
  return new HostedWorker({ root: resolve(raw.root), serviceUrl: raw.serviceUrl, workerToken: raw.workerToken, prefix: raw.prefix, productBinary: resolve(raw.productBinary), environment, isolation: { firstUid: raw.isolation.firstUid, lastUid: raw.isolation.lastUid } });
}
