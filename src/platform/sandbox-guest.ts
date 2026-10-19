// Supports: SPEC-PER-015 (loopback proxy inside an isolated network namespace, linked only by a preconnected descriptor).
import { Socket, createServer } from "node:net";
import { startChild } from "./process";
import { sandboxChannel } from "./sandbox-channel";
/** Internal native entry point. It owns no host credential and cannot create host Unix sockets. */
export async function sandboxGuest(args: readonly string[], environment: Readonly<Record<string, string>>): Promise<number> {
  const [cwd, file, ...command] = args; if (!cwd?.startsWith("/") || !file?.startsWith("/")) throw Error("Invalid sandbox guest launch.");
  const peers = new Map<number, Socket>();
  let next = 0, lines = "", failed = false, finished = false, child: ReturnType<typeof startChild> | undefined;
  const send = (value: unknown) => { if (!failed) channel.write(JSON.stringify(value) + "\n"); };
  const fail = () => { if (failed || finished) return; failed = true; process.stderr.write("Sandbox relay disconnected; command stopped.\n"); for (const socket of peers.values()) socket.destroy(); void child?.killTree(100); };
  const channel = sandboxChannel(3, bytes => {
    lines += bytes.toString(); if (lines.length > 131072) { fail(); return; }
    for (;;) {
      const cut = lines.indexOf("\n"); if (cut === -1) break;
      try {
        const frame = JSON.parse(lines.slice(0, cut)) as { id: number; data?: string; end?: boolean }; lines = lines.slice(cut + 1);
        const peer = peers.get(frame.id); if (!peer) continue;
        if (frame.data !== undefined) { if (typeof frame.data !== "string" || frame.data.length > 90000) throw Error(); peer.write(Buffer.from(frame.data, "base64")); }
        if (frame.end) { peers.delete(frame.id); peer.end(); }
      } catch { fail(); break; }
    }
  }, fail);
  const server = createServer(socket => {
    if (peers.size >= 32 || failed) { socket.destroy(); return; }
    const id = ++next; peers.set(id, socket); send({ id, open: true });
    socket.on("data", value => { const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value); for (let at = 0; at < bytes.length; at += 32768) send({ id, data: bytes.subarray(at, at + 32768).toString("base64") }); });
    socket.on("error", () => {}); socket.on("close", () => { if (peers.delete(id)) send({ id, end: true }); });
    socket.setTimeout(60000, () => socket.destroy());
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("Sandbox loopback proxy unavailable.");
  const proxy = `http://127.0.0.1:${address.port}`, env = { ...environment, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, ALL_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, all_proxy: proxy, NO_PROXY: "", no_proxy: "" };
  try {
    child = startChild(file, command, { cwd, env, onData: bytes => process.stdout.write(bytes) });
    if (failed) await child.killTree(100);
    const code = await child.exited; return failed ? 1 : code ?? 1;
  } finally { finished = true; server.close(); for (const socket of peers.values()) socket.destroy(); channel.close(); }
}
