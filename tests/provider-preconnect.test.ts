import { expect, test } from "bun:test";
import { cli, workspace } from "./helpers/env";

test("SPEC-API-022/CA-01 — the first real SDK request reuses the anonymous startup connection", async () => {
  const ports: number[] = [], methods: string[] = [], heads: { headers: Headers; body: string }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request, server) {
    methods.push(request.method); ports.push(server.requestIP(request)!.port);
    if (request.method === "HEAD") { heads.push({ headers: request.headers, body: await request.text() }); return new Response("OK"); }
    const body = await request.json() as { model: string };
    return new Response(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta: { role: "assistant", content: "ready" }, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 1 } })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  try {
    const result = await cli(["--non-interactive", "PRIVATE_CONVERSATION_WITNESS"], workspace(), { userConfig: { api: { baseUrl: `http://127.0.0.1:${server.port}/v1` } }, env: { OPENAI_API_KEY: "fixture-only-preconnect-key" } });
    expect(result.code).toBe(0); expect(result.stdout).toContain("ready"); expect(methods).toEqual(["HEAD", "POST"]); expect(ports[1]).toBe(ports[0]); expect(heads[0]!.body).toBe(""); expect(heads[0]!.headers.has("authorization")).toBe(false);
  } finally { server.stop(true); }
});
test("SPEC-API-022/CA-02 — an unreachable warm connection neither blocks startup nor displays an error", async () => {
  const result = await cli(["--non-interactive", "/status"], workspace());
  expect(result.code).toBe(0); expect(result.stderr).not.toMatch(/ECONN|FailedToOpenSocket|préconnexion|preconnect/);
});
