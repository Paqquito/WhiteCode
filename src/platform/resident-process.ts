// Supports: SPEC-MOD-021, SPEC-MOD-022 (detached local process and loopback-only transport).
import { spawn } from "node:child_process";
export function detachProduct(
  file: string,
  args: readonly string[],
  options: { cwd: string; environment: Record<string, string> },
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.environment,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid!);
    });
  });
}
export function residentServer(
  handle: (request: Request) => Promise<Response>,
): { port: number; close(): Promise<void> } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    maxRequestBodySize: 1048576,
    idleTimeout: 5,
    fetch(request) {
      if (request.headers.has("origin"))
        return new Response("Forbidden", { status: 403 });
      return handle(request).catch(() =>
        Response.json(
          { error: "Local service request failed." },
          { status: 400 },
        ),
      );
    },
  });
  return {
    port: server.port!,
    close: async () => {
      await server.stop(true);
    },
  };
}
export function residentFetch(
  port: number,
  token: string,
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<Response> {
  if (
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535 ||
    !/^\/[a-z0-9/-]*$/.test(path)
  )
    throw Error("Invalid local endpoint.");
  const endpoint = `http://127.0.0.1:${port}`;
  return fetch(endpoint + path, {
    proxy: endpoint,
    redirect: "error",
    signal,
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
