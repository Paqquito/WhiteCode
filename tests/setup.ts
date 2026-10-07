// Test preload: no test may reach the network (SPEC-BLD-007 EF-02). Local servers bound to 127.0.0.1 are allowed.

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error(`Network access forbidden in tests: ${url.host}`);
  return realFetch(input, init);
}) as typeof fetch;
