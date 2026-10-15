// Supports: SPEC-MOD-021/022 (bounded authenticated local client transport).
import type { ResidentEndpoint } from "./supervisor";
import { residentFetch } from "../platform/resident-process";
export async function residentRequest(
  endpoint: ResidentEndpoint,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  const response = await residentFetch(
    endpoint.port,
    endpoint.token,
    path,
    body,
    signal,
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw Error("Service résident indisponible ou requête refusée.");
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error("Réponse résidente vide.");
  let length = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const value = await reader.read();
      if (value.done) break;
      if ((length += value.value.length) > 1048576)
        throw Error("Réponse résidente trop volumineuse.");
      chunks.push(value.value);
    }
    const raw: unknown = JSON.parse(Buffer.concat(chunks).toString());
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw Error("Réponse résidente invalide.");
    return raw as Record<string, unknown>;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
