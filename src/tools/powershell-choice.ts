// Supports: SPEC-OUT-009 (foreground PowerShell) and SPEC-OUT-033 (human choices).
import { createServer, type Socket } from "node:net";
import type { ToolContext } from "./types";

/** One local pipe per command. The script keeps its original arguments and resumes on the human's answer. */
export async function withChoicePipe<T>(ask: NonNullable<ToolContext["askCommandChoice"]>, signal: AbortSignal, run: (name: string) => Promise<T>): Promise<T> {
  const name = "choice-" + crypto.randomUUID();
  const lifetime = new AbortController();
  const active = AbortSignal.any([signal, lifetime.signal]);
  const clients = new Set<Socket>();
  let waiting = false;
  const server = createServer(socket => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    let input = "";
    socket.on("data", async chunk => {
      input += chunk;
      if (input.length > 65_536) { socket.destroy(); return; }
      if (!input.includes("\n")) return;
      socket.removeAllListeners("data");
      if (waiting || active.aborted) { socket.end('{"none":true}\n'); return; }
      waiting = true;
      try {
        const question = JSON.parse(input);
        const reply = await ask(question, active);
        if (!socket.destroyed) socket.end(JSON.stringify(reply) + "\n");
      } catch { socket.destroy(); }
      finally { waiting = false; }
    });
  });
  await new Promise<void>((resolve, reject) => server.once("error", reject).listen("\\\\.\\pipe\\" + name, resolve));
  try { return await run(name); }
  finally {
    lifetime.abort();
    for (const client of clients) client.destroy();
    server.close();
  }
}
