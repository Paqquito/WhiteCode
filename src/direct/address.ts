// Supports: SPEC-MOD-018 (transport boundaries), SPEC-MOD-019 (local listener by default).
import { isAbsolute, resolve } from "node:path";
import { isLoopback, parseListenAddress } from "../control/remote";

export type DirectAddress =
  | { readonly kind: "websocket"; readonly url: string; readonly hostname: string; readonly secure: boolean }
  | { readonly kind: "unix"; readonly path: string };
export type DirectListen = { readonly kind: "tcp"; readonly hostname: string; readonly port: number } | { readonly kind: "unix"; readonly path: string };

function ordinaryAddress(value: string, localPath = false): void {
  if (!value || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !localPath && value.includes(" ")) throw new Error("Adresse de serveur invalide.");
}
function unixAddress(value: string): { readonly kind: "unix"; readonly path: string } {
  const path = value.slice(5);
  if (!path || !isAbsolute(path)) throw new Error("Le socket local exige un chemin absolu.");
  return { kind: "unix", path: resolve(path) };
}
/** No supplied URL is included in errors: credentials belong only in the authenticated opening headers. */
export function parseDirectAddress(value: string): DirectAddress {
  ordinaryAddress(value, value.startsWith("unix:"));
  if (value.startsWith("unix:")) return unixAddress(value);
  let url: URL; try { url = new URL(value); } catch { throw new Error("Adresse de serveur invalide."); }
  if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !url.hostname) throw new Error("Adresse WebSocket sans identifiant, paramètre ni fragment requise.");
  if (url.protocol === "ws:" && !isLoopback(url.hostname)) throw new Error("Un transport chiffré est requis hors boucle locale.");
  return { kind: "websocket", url: url.href, hostname: url.hostname, secure: url.protocol === "wss:" };
}
export function parseDirectListen(value: string | undefined, encrypted: boolean): DirectListen {
  if (value?.startsWith("unix:")) { ordinaryAddress(value, true); return unixAddress(value); }
  if (value !== undefined) ordinaryAddress(value);
  const parsed = parseListenAddress(value ?? "127.0.0.1:0");
  if (typeof parsed === "string" || !parsed.hostname || /[/?#@]/.test(parsed.hostname)) throw new Error("Adresse d’écoute invalide.");
  if (!encrypted && !isLoopback(parsed.hostname)) throw new Error("Un transport chiffré est requis hors boucle locale.");
  return { kind: "tcp", ...parsed };
}
