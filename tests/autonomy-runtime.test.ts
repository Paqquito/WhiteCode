import { expect, test } from "bun:test";
import { ProactiveWake, WakeEvents } from "../src/autonomy/wake";
test("TECH — proactive timing cancels on typing, respects the minimum and pauses on busy or costly runs", () => {
  let now = 0, ready = true, pressure = false; const messages: string[] = [];
  const wake = new ProactiveWake({ now: () => now, intervalMs: () => 1, ready: () => ready, pressure: () => pressure, submit: message => { messages.push(message); return true; }, changed: () => {} });
  try {
    wake.toggle(); wake.poll(); now = 59999; wake.poll(); expect(messages).toHaveLength(0);
    wake.activity(); wake.poll(); now += 60000; wake.poll(); expect(messages).toHaveLength(1);
    ready = false; now += 60000; wake.poll(); expect(messages).toHaveLength(1);
    ready = true; pressure = true; wake.poll(); now += 60000; wake.poll(); expect(messages).toHaveLength(1);
    now += 180000; wake.poll(); expect(messages).toHaveLength(2);
    wake.toggle(); now += 1000000; wake.poll(); expect(messages).toHaveLength(2);
  } finally { wake.close(); }
});
test("TECH — a wait wakes on an addressed event, joins cancellation and releases its listeners", async () => {
  const events = new WakeEvents(), controller = new AbortController();
  const one = events.wait(600000, 300000, controller.signal); events.emit("message"); expect((await one).cause).toBe("message"); expect(events.waiting).toBe(0);
  const two = events.wait(600000, 300000, controller.signal); controller.abort(); expect((await two).cause).toBe("interruption"); expect(events.waiting).toBe(0);
});
test("TECH — rising budget pressure postpones a proactive wake that was already armed", () => {
  let now = 0, pressure = false, count = 0;
  const wake = new ProactiveWake({ now: () => now, intervalMs: () => 60000, ready: () => true, pressure: () => pressure, submit: () => { count++; return true; }, changed: () => {} });
  try { wake.toggle(); wake.poll(); now = 59000; pressure = true; wake.poll(); now = 60001; wake.poll(); expect(count).toBe(0); now = 299001; wake.poll(); expect(count).toBe(1); }
  finally { wake.close(); }
});
test("TECH — an addressed event arriving before wait is retained until the next request acknowledges it", async () => {
  const events = new WakeEvents(); events.emit("notification");
  expect((await events.wait(600000, 600000, new AbortController().signal)).cause).toBe("notification");
  events.emit("message"); events.acknowledge();
  expect((await events.wait(5, 1000, new AbortController().signal)).cause).toBe("deadline"); expect(events.waiting).toBe(0);
});
