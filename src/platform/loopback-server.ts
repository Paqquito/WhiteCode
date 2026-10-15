// Supports: SPEC-SES-001 (§ 5.7 local transcript reader), gap E-137.
/** Runtime adapter for short-lived capability servers; never listens on a public interface. */
export function startLoopbackServer(handle: (request: Request) => Response, port = 0): { readonly port: number; close(options?: { readonly flushResponse?: boolean }): void } {
  const server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: 5, maxRequestBodySize: 1024, fetch: handle });
  server.unref();
  let closed = false;
  return { port: server.port!, close: (options) => { if (!closed) { closed = true; void server.stop(options?.flushResponse !== true); } } };
}

/** The local capability must never leave this machine through an environment proxy or a redirect. */
export function readLoopback(port: number, token: string, signal: AbortSignal): Promise<Response> {
  const endpoint = `http://127.0.0.1:${port}`;
  // Bun 1.4.2 ignores proxy:false and proxy:"". An explicit proxy to this same local server cannot leave loopback.
  return fetch(`${endpoint}/read/${token}`, { proxy: endpoint, redirect: "error", keepalive: false, signal });
}
