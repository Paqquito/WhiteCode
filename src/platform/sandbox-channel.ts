// Supports: SPEC-PER-015 (bounded nonblocking transport over a preconnected capability descriptor).
import { closeSync, readSync, writeSync } from "node:fs";
/** This descriptor is already connected: no filesystem socket address is ever accepted. */
export function sandboxChannel(fd: number, receive: (bytes: Buffer) => void, ended: () => void) {
  const buffer = Buffer.alloc(65536), pending: Buffer[] = []; let queued = 0, offset = 0, closed = false, pumping = false;
  const close = () => { if (closed) return; closed = true; clearInterval(timer); try { closeSync(fd); } catch {} ended(); };
  const pump = () => {
    if (closed || pumping) return; pumping = true;
    try {
      for (let count = 0; count < 8 && pending.length; count++) {
        const bytes = pending[0]!;
        try { const written = writeSync(fd, bytes, offset, bytes.length - offset); offset += written; queued -= written; if (offset === bytes.length) { pending.shift(); offset = 0; } }
        catch (error) { if (["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) break; throw error; }
      }
      for (let count = 0; count < 8; count++) {
        let length: number;
        try { length = readSync(fd, buffer, 0, buffer.length, null); }
        catch (error) { if (["EAGAIN", "EWOULDBLOCK"].includes((error as NodeJS.ErrnoException).code ?? "")) break; throw error; }
        if (!length) { close(); break; } receive(Buffer.from(buffer.subarray(0, length))); if (closed) break;
      }
    } catch { close(); }
    finally { pumping = false; }
  };
  const timer = setInterval(pump, 5); timer.unref();
  return { write(value: string) { if (closed) return; const bytes = Buffer.from(value); if ((queued += bytes.length) > 2 * 1024 * 1024) { close(); return; } pending.push(bytes); pump(); }, close };
}
