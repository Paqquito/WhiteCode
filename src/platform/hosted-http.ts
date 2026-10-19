// Supports: SPEC-API-029, SPEC-PLA-002 (bounded executable service transport).
/** Plain HTTP is restricted to loopback; deployments terminate TLS here or at an authenticated reverse proxy. */
export async function startHostedHttp(handle: (request: Request) => Promise<Response>, options: { hostname?: string; port?: number; tls?: { cert: string; key: string } } = {}) {
  const hostname = options.hostname ?? "127.0.0.1";
  if (!options.tls && !["127.0.0.1", "::1"].includes(hostname)) throw Error("Une écoute publique exige TLS.");
  const server = Bun.serve({ hostname, port: options.port ?? 0, maxRequestBodySize: 1024 * 1024, idleTimeout: 60, ...(options.tls ? { tls: options.tls } : {}),
    async fetch(request) {
      const response = await handle(request);
      response.headers.set("Cache-Control", "no-store");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
      return response;
    },
  });
  return { url: `${options.tls ? "https" : "http"}://${hostname === "::1" ? "[::1]" : hostname}:${server.port}/`, close: async () => { await server.stop(true); } };
}
