// Implements: SPEC-MOD-020 (EF-01/02: session-only authentication relay, credentials remain local).
import { timingSafeEqual } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { once } from "node:events";
import { StringDecoder } from "node:string_decoder";
import type { ResolvedModel } from "../providers/catalog";
import { ProviderError, type ModelProvider, type ModelRequest, type ModelEvent } from "../providers/types";

const MAX_BODY = 16 * 1024 * 1024;
export async function startSshRelay(o: { provider: ModelProvider; model: ResolvedModel; token: string; redact: (text: string) => string; allowed?: () => void }): Promise<{ port: number; url: string; close(): Promise<void> }> {
  const lifetime = new AbortController(); let busy = false;
  const server = createServer(async (req, res) => {
    const supplied = req.headers.authorization, expected = `Bearer ${o.token}`;
    if (req.method !== "POST" || req.url !== "/request" || typeof supplied !== "string" || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) { res.writeHead(403).end(); return; }
    if (busy) { res.writeHead(429).end(); return; } busy = true;
    const controller = new AbortController(), stop = () => controller.abort(); lifetime.signal.addEventListener("abort", stop, { once: true }); res.on("close", stop);
    try {
      let size = 0; const chunks: Buffer[] = [];
      for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) { res.writeHead(413).end(); return; } chunks.push(Buffer.from(chunk)); }
      const data = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Partial<ModelRequest>;
      if (!Array.isArray(data.system) || !Array.isArray(data.history) || !Array.isArray(data.tools) || typeof data.maxOutputTokens !== "number" || !Number.isSafeInteger(data.maxOutputTokens) || data.maxOutputTokens < 1 || data.maxOutputTokens > o.model.maxOutputTokens || !data.thinking || typeof data.thinking !== "object") { res.writeHead(400).end(); return; }
      o.allowed?.();
      // A remote peer can supply conversation data, never a destination or model/provider override.
      const request: ModelRequest = { model: o.model, system: data.system, history: data.history, tools: data.tools, maxOutputTokens: data.maxOutputTokens, thinking: data.thinking, ...(data.effort ? { effort: data.effort } : {}), purpose: data.purpose, segment: data.segment, contextEditing: data.contextEditing };
      res.writeHead(200, { "content-type": "application/x-ndjson", "cache-control": "no-store" });
      for await (const event of o.provider.stream(request, controller.signal)) {
        const line = o.redact(JSON.stringify(event)) + "\n";
        if (Buffer.byteLength(line) > MAX_BODY) throw new Error("Oversized provider event.");
        if (!res.write(line)) await once(res, "drain", { signal: controller.signal });
      }
      res.end();
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
    finally { busy = false; lifetime.signal.removeEventListener("abort", stop); res.off("close", stop); controller.abort(); }
  });
  server.requestTimeout = 60000; server.headersTimeout = 10000;
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const port = (server.address() as { port: number }).port;
  return { port, url: `http://127.0.0.1:${port}/request`, close: async () => { lifetime.abort(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
export function sshRelayProvider(endpoint: string, token: string, socketPath?: string): ModelProvider {
  return { id: "ssh-relay", async *stream(data, signal) {
    const body = JSON.stringify(data); if (Buffer.byteLength(body) > MAX_BODY) throw new ProviderError("invalid_request", "SSH relay request is too large.");
    const req = httpRequest(endpoint, { method: "POST", ...(socketPath ? { socketPath } : {}), headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body) }, signal });
    const response = new Promise<import("node:http").IncomingMessage>((resolve, reject) => { req.once("response", resolve); req.once("error", reject); }); req.end(body);
    try {
      const res = await response; if (res.statusCode !== 200) { res.destroy(); throw new ProviderError("connection", "SSH authentication relay refused the request."); }
      let pending = "", complete = false; const decoder = new StringDecoder("utf8");
      for await (const chunk of res) {
        pending += decoder.write(Buffer.from(chunk)); if (Buffer.byteLength(pending) > MAX_BODY) throw new ProviderError("malformed_response", "SSH relay event is too large.");
        for (let at = pending.indexOf("\n"); at >= 0; at = pending.indexOf("\n")) { const line = pending.slice(0, at); pending = pending.slice(at + 1); const event = JSON.parse(line) as ModelEvent; if (event.type === "message_complete") complete = true; yield event; }
      }
      if (!complete || (pending + decoder.end()).trim()) throw new ProviderError("connection", "SSH authentication relay was interrupted.");
    } finally { req.destroy(); }
  } };
}
