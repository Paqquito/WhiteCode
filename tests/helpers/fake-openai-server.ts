// Local server speaking the OpenAI-compatible streamed chat protocol, bound to 127.0.0.1 (no network).

export interface FakeChatTurn {
  readonly text?: string;
  readonly reasoning?: string;
  readonly toolCalls?: ReadonlyArray<{ id?: string; name: string; arguments: string }>;
  readonly finishReason?: string;
  readonly status?: number;
  readonly hang?: boolean;
  /** Delay before the response starts, as a server processing a long prompt before the first token. */
  readonly delayMs?: number;
  /** Omits the usage chunk. */
  readonly noUsage?: boolean;
}

export interface CapturedChatRequest {
  readonly path: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export interface FakeChatServer {
  readonly baseURL: string;
  readonly requests: CapturedChatRequest[];
  stop(): void;
}

export function startFakeOpenAI(turns: FakeChatTurn[]): FakeChatServer {
  const queue = [...turns];
  const requests: CapturedChatRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({ path: new URL(req.url).pathname, headers, body });
      const turn = queue.shift() ?? { text: "done" };
      if (turn.delayMs) await Bun.sleep(turn.delayMs);
      if (turn.status) return new Response(JSON.stringify({ error: { message: "failure", type: "server_error" } }), { status: turn.status, headers: { "content-type": "application/json" } });
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const chunk = (delta: unknown, finish: string | null = null, extra: Record<string, unknown> = {}) =>
            controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: body["model"], choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`));
          chunk({ role: "assistant", content: "" });
          if (turn.hang) return;
          if (turn.reasoning) chunk({ reasoning_content: turn.reasoning });
          if (turn.text) for (const piece of turn.text.match(/.{1,5}/gs) ?? []) chunk({ content: piece });
          (turn.toolCalls ?? []).forEach((c, index) => {
            chunk({ tool_calls: [{ index, id: c.id ?? `call_${index}`, type: "function", function: { name: c.name, arguments: "" } }] });
            const half = Math.ceil(c.arguments.length / 2);
            chunk({ tool_calls: [{ index, function: { arguments: c.arguments.slice(0, half) } }] });
            chunk({ tool_calls: [{ index, function: { arguments: c.arguments.slice(half) } }] });
          });
          chunk({}, turn.finishReason ?? ((turn.toolCalls?.length ?? 0) > 0 ? "tool_calls" : "stop"));
          if (!turn.noUsage) controller.enqueue(enc.encode(`data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 0, model: body["model"], choices: [], usage: { prompt_tokens: 50, completion_tokens: 9, total_tokens: 59 } })}\n\n`));
          controller.enqueue(enc.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { baseURL: `http://127.0.0.1:${server.port}/v1`, requests, stop: () => server.stop(true) };
}
