// Desktop receiver fixture: a separate native process implements registration, deep-link receipt and history acknowledgement.
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { restrictFileToOwner } from "../../src/platform/private-file";
const [config, output, mode] = process.argv.slice(2) as [
    string,
    string,
    string,
  ],
  token = randomBytes(32).toString("base64url");
let transfer: Record<string, unknown> | undefined,
  opened = false;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  maxRequestBodySize: 8 * 1024 * 1024,
  async fetch(request) {
    if (
      request.headers.has("origin") ||
      request.headers.get("authorization") !== "Bearer " + token
    )
      return new Response("Denied", { status: 401 });
    const path = new URL(request.url).pathname,
      body = (await request.json()) as Record<string, unknown>;
    if (path === "/desktop/prepare") {
      transfer = body;
      return Response.json({
        status: "prepared",
        id: body.id,
        sessionId: body.sessionId,
        digest: body.digest,
      });
    }
    if (path === "/desktop/open" && transfer) {
      const url = new URL(String(body.url));
      if (url.searchParams.get("transfer") !== transfer.id)
        return new Response("Invalid link", { status: 400 });
      writeFileSync(output, JSON.stringify({ ...transfer, link: url.href }));
      opened = mode !== "no-ack";
      return Response.json({ ok: true });
    }
    if (path === "/desktop/status" && transfer && body.id === transfer.id)
      return Response.json({
        status: opened ? "opened" : "prepared",
        id: transfer.id,
        sessionId: transfer.sessionId,
        digest: mode === "bad-ack" ? "wrong" : transfer.digest,
      });
    return new Response("Unknown", { status: 404 });
  },
});
const directory = join(config, "desktop");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const file = join(directory, "instance.json");
writeFileSync(
  file,
  JSON.stringify({
    version: 1,
    pid: process.pid,
    port: server.port,
    token,
    updatedAt: Date.now(),
  }),
  { mode: 0o600 },
);
restrictFileToOwner(file);
// Native helper stays alive until the owning test terminates it.
console.log(readFileSync(file, "utf8"));
