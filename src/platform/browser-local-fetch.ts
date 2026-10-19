// Supports: SPEC-INT-011 (the authenticated MCP connection never leaves the owned loopback endpoint).
export function browserLoopbackFetch(port: number): typeof fetch {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error("Invalid browser bridge port."); const origin = `http://127.0.0.1:${port}`;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => { const url = new URL(input instanceof Request ? input.url : String(input)); if (url.origin !== origin || url.pathname !== "/mcp" || url.search || url.hash) throw Error("Browser MCP request escaped its loopback endpoint."); return fetch(input, { ...init, proxy: origin, redirect: "error" }); }) as typeof fetch;
}
