// Implements: SPEC-MCP-016 (CA-01/02, configured discovery and verified ordering).
// Supports: SPEC-PER-022, SPEC-CAD-002, gap E-164.
import { isSecureIdentityUrl } from "../identity/identity";
import { sanitize } from "../ui/text";
export interface RegistryConnector { readonly name: string; readonly description: string; readonly transport: "stdio" | "http" | "websocket"; readonly verified: boolean; readonly publisher?: string; readonly url?: string }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** Only the user's explicit query is sent, without repository context or account tokens. */
export async function searchConnectorRegistry(service: string | undefined, query: string, fetcher: typeof fetch, signal: AbortSignal): Promise<RegistryConnector[]> {
  if (!service || !isSecureIdentityUrl(service)) throw new Error("Registre de connecteurs non configuré ou adresse non autorisée.");
  if (!query.trim() || query.length > 200 || /[\u0000-\u001f\u007f]/.test(query)) throw new Error("Requête de recherche invalide (1 à 200 caractères).");
  const url = new URL("search", service.endsWith("/") ? service : service + "/"); url.searchParams.set("q", query.trim());
  const response = await fetcher(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(1900)]), redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Registre indisponible (HTTP ${response.status}).`); }
  const reader = response.body?.getReader(); if (!reader) throw new Error("Réponse de registre vide.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try { for (;;) { const { value, done } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > 524288) throw new Error("Réponse de registre trop volumineuse."); chunks.push(value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!object(data) || !Array.isArray(data["connectors"]) || data["connectors"].length > 1000) throw new Error("Réponse de registre invalide.");
  return data["connectors"].flatMap((raw: unknown): RegistryConnector[] => {
    if (!object(raw) || typeof raw["name"] !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw["name"]) || raw["name"].length > 48 || typeof raw["description"] !== "string" || raw["description"].length > 1000 || !["stdio", "http", "websocket"].includes(String(raw["transport"])) || raw["url"] !== undefined && (typeof raw["url"] !== "string" || !isSecureIdentityUrl(raw["url"]))) return [];
    return [{ name: raw["name"], description: sanitize(raw["description"], false), transport: raw["transport"] as RegistryConnector["transport"], verified: raw["verified"] === true, ...(typeof raw["publisher"] === "string" ? { publisher: sanitize(raw["publisher"], false).slice(0, 200) } : {}), ...(typeof raw["url"] === "string" ? { url: raw["url"] } : {}) }];
  }).sort((a, b) => Number(b.verified) - Number(a.verified) || a.name.localeCompare(b.name));
}
export function registryReport(rows: readonly RegistryConnector[]): string { return rows.length ? rows.map(row => `${row.name}${row.verified ? " [vérifié]" : ""} (${row.transport})${row.publisher ? ` — ${row.publisher}` : ""} : ${row.description}`).join("\n") : "Aucun connecteur correspondant."; }
