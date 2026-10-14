// Local server speaking the public streaming format of the provider (server-sent events), bound to 127.0.0.1.
// It lets the real SDK and the real adapter run end to end without any network access (SPEC-BLD-007 EF-02).

export interface FakeTurn {
  readonly text?: string;
  readonly toolUses?: ReadonlyArray<{ id: string; name: string; input: unknown }>;
  readonly stopReason?: string;
  readonly stopDetails?: unknown;
  /** HTTP status to return instead of a stream. */
  readonly status?: number;
  /** Error type of that status (default: overloaded_error). */
  readonly errorType?: string;
  /** Applied edits reported in the final message delta (service-side clearing). */
  readonly appliedEdits?: unknown[];
  /** Keeps the stream open without events (idle timeout tests). */
  readonly hang?: boolean;
}

export interface CapturedRequest {
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown>;
}

export interface FakeServer {
  readonly url: string;
  readonly requests: CapturedRequest[];
  stop(): void;
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export function startFakeAnthropic(turns: FakeTurn[]): FakeServer {
  const queue = [...turns];
  const requests: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method === "HEAD") return new Response(null);
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => (headers[k] = v));
      const body = (await req.json()) as Record<string, unknown>;
      requests.push({ headers, body });
      const turn = queue.shift() ?? { text: "done" };
      if (turn.status) {
        return new Response(JSON.stringify({ type: "error", error: { type: turn.errorType ?? "overloaded_error", message: "rejected by the fake server" } }), { status: turn.status, headers: { "content-type": "application/json", "request-id": "req_err" } });
      }
      const stream = new ReadableStream({
        async start(controller) {
          const enc = new TextEncoder();
          const send = (e: string, d: unknown) => controller.enqueue(enc.encode(sse(e, d)));
          send("message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: String(body["model"]), content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
          if (turn.hang) return; // never closes
          let index = 0;
          send("content_block_start", { type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
          send("content_block_delta", { type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig-abc" } });
          send("content_block_stop", { type: "content_block_stop", index });
          index++;
          if (turn.text) {
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "text", text: "" } });
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "text_delta", text: turn.text } });
            send("content_block_stop", { type: "content_block_stop", index });
            index++;
          }
          for (const t of turn.toolUses ?? []) {
            send("content_block_start", { type: "content_block_start", index, content_block: { type: "tool_use", id: t.id, name: t.name, input: {} } });
            send("content_block_delta", { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(t.input) } });
            send("content_block_stop", { type: "content_block_stop", index });
            index++;
          }
          const stop = turn.stopReason ?? ((turn.toolUses?.length ?? 0) > 0 ? "tool_use" : "end_turn");
          send("message_delta", { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null, ...(turn.stopDetails ? { stop_details: turn.stopDetails } : {}) }, usage: { output_tokens: 7 }, ...(turn.appliedEdits ? { context_management: { applied_edits: turn.appliedEdits } } : {}) });
          send("message_stop", { type: "message_stop" });
          controller.close();
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "request-id": "req_123" } });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}
