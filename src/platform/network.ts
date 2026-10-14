// Implements: SPEC-PER-022 (§ 5.3 steps 1 to 3, FA-01, EF-01 to EF-03, ERR-01, ERR-02)
// The outgoing connections of the product: the proxy chosen for each destination (with its exceptions), a trust store
// made of the public authorities plus the extra ones, and the client certificate. The verification of the certificates
// is never turned off (EF-02).

import { rootCertificates } from "node:tls";

export interface NetworkSettings {
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  /** `NO_PROXY`: host names, domains (`.example.com` or `example.com`), `host:port`, or `*`. */
  readonly noProxy: readonly string[];
  /** PEM of the extra authorities (`<PREFIX>EXTRA_CA_CERTS`). */
  readonly extraCa?: string;
  /** PEM of the client certificate and of its key (mutual TLS). */
  readonly clientCert?: string;
  readonly clientKey?: string;
  /** Says how to add an authority, for the error of an unknown certificate (ERR-01). */
  readonly caHint: string;
}

/** Step 1: the proxy of a destination, unless an exception covers it. */
export function proxyFor(url: URL, s: NetworkSettings): string | undefined {
  const proxy = url.protocol === "https:" || url.protocol === "wss:" ? (s.httpsProxy ?? s.httpProxy) : s.httpProxy;
  if (!proxy) return undefined;
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  for (const raw of s.noProxy) {
    const entry = raw.trim().toLowerCase();
    if (entry === "") continue;
    if (entry === "*") return undefined;
    const [name, entryPort] = entry.split(/:(?=\d+$)/) as [string, string | undefined];
    if (entryPort && entryPort !== port) continue;
    const domain = name.replace(/^\*?\./, "");
    if (host === domain || host.endsWith(`.${domain}`)) return undefined;
  }
  return proxy;
}

const CERTIFICATE_ERRORS = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|certificate/i;

/** A `fetch` that follows the settings; its errors say what to do (FA-01, ERR-01, ERR-02), never with a credential (EF-03). */
export function networkFetch(s: NetworkSettings): typeof fetch {
  let warming: { origin: string; done: Promise<void> } | undefined;
  const ca = s.extraCa ? [...rootCertificates, s.extraCa] : undefined;
  const tls = ca || s.clientCert ? { ...(ca ? { ca } : {}), ...(s.clientCert ? { cert: s.clientCert, key: s.clientKey } : {}) } : undefined;
  const wrapped = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url);
    const proxy = proxyFor(url, s);
    try {
      // Initialization never waits. Only the first request joins the anonymous handshake of its own pool.
      if (warming?.origin === url.origin) {
        const pending = warming.done; warming = undefined;
        const signal = init?.signal;
        if (signal?.aborted) signal.throwIfAborted();
        if (!signal) await pending;
        else await new Promise<void>((resolve, reject) => {
          const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
          signal.addEventListener("abort", abort, { once: true });
          void pending.then(() => { signal.removeEventListener("abort", abort); resolve(); });
        });
      }
      return await fetch(input, { ...(init ?? {}), ...(proxy ? { proxy } : {}), ...(tls ? { tls } : {}) } as RequestInit);
    } catch (e) {
      const error = e as Error & { code?: string };
      const what = `${error?.code ?? ""} ${error?.message ?? ""}`;
      if (CERTIFICATE_ERRORS.test(what)) throw Object.assign(new Error(`Certificat du serveur non reconnu : ajoutez l'autorité de votre entreprise (${s.caHint}).`), { cause: e, code: error?.code });
      if (proxy && /ECONNREFUSED|ConnectionRefused|ENOTFOUND|FailedToOpenSocket|ConnectionClosed/i.test(what)) {
        throw Object.assign(new Error(`Mandataire injoignable : ${safeHost(proxy)}.`), { cause: e, code: error?.code });
      }
      throw e;
    }
  }) as typeof fetch;
  wrapped.preconnect = endpoint => { try { const url = new URL(String(endpoint)); if (!tls && !proxyFor(url, s)) { const done = warmProviderConnection(undefined, url.href); if (done) warming = { origin: url.origin, done }; } } catch { /* Optional warmup. */ } };
  return wrapped;
}

/** The host of a proxy, without the credentials it may carry (EF-03). */
export function safeHost(proxy: string): string {
  try {
    const u = new URL(proxy);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return "adresse illisible";
  }
}

// Implements: SPEC-API-022 (CA-01/02, no user data and no startup delay).
// Supports: gap E-167 (anonymous HEAD, skip dedicated proxy/TLS pools).
export function warmProviderConnection(network: typeof fetch | undefined, endpoint: string): Promise<void> | undefined {
  try { const url = new URL(endpoint); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return;
    if (network && network !== fetch) { network.preconnect?.(url.href); return; }
    return fetch(url.href, { method: "HEAD", redirect: "error", signal: AbortSignal.timeout(1000) }).then(async response => { await response.body?.cancel(); }).catch(() => {});
  }
  catch { /* An optional warm connection never interrupts or warns at startup. */ }
}
