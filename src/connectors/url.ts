// Supports: SPEC-MCP-003 (EF-02, RG-01), gap E-146.
import { ConnectionError } from "./stdio-client";
/** No address, query or credentials are included in diagnostics. */
export function secureConnectorUrl(value: string): URL {
  try {
    const u = new URL(value);
    if (u.username || u.password || u.hash || !(u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname)))) throw new Error();
    return u;
  } catch { throw new ConnectionError("URL non sécurisée refusée."); }
}
