import { expect, test } from "bun:test";
import { FramedLink } from "../src/control/remote";
import type { WsPeer } from "../src/platform/websocket";

const fixture = (maxBufferedBytes?: number) => {
  const sent: string[] = [], closed: number[] = [];
  const link = new FramedLink({ resumeWindowMs: 1000, keepAliveMs: 1000, maxFrameBytes: 10000, maxBuffered: 100, maxBufferedBytes, notice: () => {}, trace: () => {} });
  const peer: WsPeer = { send: text => sent.push(text), close: code => closed.push(code ?? 1000), remoteAddress: "127.0.0.1" };
  return { link, sent, closed, peer };
};
test("TECH — remote execution admission waits for a connected host and is interruptible", async () => {
  const f = fixture(), controller = new AbortController(); let resumed = false;
  try {
    const waiting = f.link.waitAttached(controller.signal).then(() => { resumed = true; });
    await Promise.resolve(); expect(resumed).toBe(false);
    f.link.open(f.peer); await waiting; expect(resumed).toBe(true);
    f.link.closed(f.peer);
    const cancelled = f.link.waitAttached(controller.signal); controller.abort();
    await expect(cancelled).rejects.toBeDefined();
  } finally { f.link.close(); }
});
test("TECH — closing a remote link rejects waiting execution instead of admitting another operation", async () => {
  const f = fixture(), pending = f.link.waitAttached(new AbortController().signal);
  f.link.close(); await expect(pending).rejects.toThrow("closed");
});
test("TECH — replay memory is bounded in bytes and cannot silently resume across discarded events", () => {
  const f = fixture(200);
  try {
    f.link.open(f.peer);
    f.link.sendLine(JSON.stringify({ type: "control_init", protocolVersion: "1.0" }));
    const initialization = JSON.parse(f.sent[0]!);
    for (let i = 0; i < 10; i++) f.link.sendLine(JSON.stringify({ type: "text_delta", text: "x".repeat(100) }));
    f.link.closed(f.peer); f.link.open(f.peer);
    f.link.receive(f.peer, JSON.stringify({ type: "resume", resumeToken: initialization.resumeToken, lastSeq: 0 }));
    expect(f.closed).toContain(4410); expect(f.link.expired).toBe(true);
  } finally { f.link.close(); }
});

test("TECH — an authenticated inbound flood closes the bounded direct link", () => {
  const f = fixture();
  const link = new FramedLink({ resumeWindowMs: 1000, keepAliveMs: 1000, maxFrameBytes: 10000, maxBuffered: 100, maxInboundBytes: 100, notice: () => {}, trace: () => {} });
  try { link.open(f.peer); link.receive(f.peer, JSON.stringify({ type: "user", content: "x".repeat(200) })); expect(link.ended).toBe(true); expect(f.closed).toContain(4429); }
  finally { link.close(); }
});

test("TECH — ending an already expired link also closes every pending reattachment", () => {
  const first = fixture(), pending = fixture();
  const link = new FramedLink({ resumeWindowMs: 0, keepAliveMs: 60000, maxFrameBytes: 10000, maxBuffered: 100, maxPending: 1, notice: () => {}, trace: () => {} });
  try {
    link.open(first.peer); link.open(pending.peer); link.closed(first.peer);
    expect(link.expired).toBe(true); link.close(); expect(pending.closed).toContain(1001);
  } finally { link.close(); }
});
