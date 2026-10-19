import { profiledTest } from "./helpers/profiled-test";
// Supports: SPEC-PER-020, SPEC-MOD-013/016/017, SPEC-AGT-019, SPEC-OUT-032/047, SPEC-CMD-017/018/055/056/057/064/103/105, SPEC-EXT-027.
import { test, expect } from "bun:test";
import { SessionRelay, autoAttach } from "../src/remote/session-relay";
function setup(mirror = false) {
  const calls: any[] = [],
    messages: string[] = [],
    reports: string[] = [],
    trace: string[] = [],
    pending: any[] = [];
  let frames: any[] = [],
    ack = 0;
  const relay = new SessionRelay({
    account: {
      profile: async () => ({ account: "member", organization: { id: "org" } }),
      request: async (_s: string, path: string, body: any) => {
        calls.push({ path, body });
        if (path === "local/register")
          return {
            id: "local-one",
            url: "https://web.example.test/local/one",
            trustedDevice: true,
          };
        if (path.endsWith("/poll")) {
          ack = body.events.at(-1)?.seq ?? ack;
          const commands = frames;
          frames = [];
          return { ack, commands };
        }
        return {};
      },
    },
    webUrl: "https://web.example.test/",
    mirror,
    history: () => [{ role: "user", text: "prior turn" }],
    inject: (text) => {
      messages.push(text);
      return true;
    },
    report: (text) => reports.push(text),
    trace: (event) => trace.push(event),
    redact: (s) => s,
    refusal: () => undefined,
    intervalMs: 100000,
    approvalTimeoutMs: 1000,
  });
  return {
    relay,
    calls,
    messages,
    reports,
    trace,
    frames: (v: any[]) => (frames = v),
    pending,
  };
}
const internalProfileTest = profiledTest(import.meta.path, "internal");
test("SPEC-MOD-013/CA-01 — attaching registers the local history on the configured outgoing service and returns a validated link", async () => {
  const f = setup();
  expect(await f.relay.attach("", new AbortController().signal)).toBe(
    "https://web.example.test/local/one",
  );
  expect(f.calls[0].body.history[0].text).toBe("prior turn");
  expect(f.relay.state).toBe("connected");
  await f.relay.close();
});
test("SPEC-MOD-017/CA-01 — a mirrored session explicitly rejects remote messages and permission replies", async () => {
  const f = setup(true);
  await f.relay.attach("", new AbortController().signal);
  f.frames([
    { seq: 1, type: "message", text: "remote injection" },
    { seq: 2, type: "approval", requestId: "bad", answer: "allow" },
  ]);
  await f.relay.poll(new AbortController().signal);
  expect(f.messages).toHaveLength(0);
  await f.relay.poll(new AbortController().signal);
  expect(JSON.stringify(f.calls)).toContain("read_only");
  await f.relay.close();
});
test("SPEC-MOD-017/CA-02 — local turn events reach the mirror service in order and are acknowledged", async () => {
  const f = setup(true);
  await f.relay.attach("", new AbortController().signal);
  f.relay.event({ type: "assistant_text", text: "local answer" });
  await f.relay.poll(new AbortController().signal);
  expect(f.calls[1].body.events[0]).toMatchObject({
    seq: 1,
    event: { type: "assistant_text", text: "local answer" },
  });
  expect(f.relay.buffered).toBe(0);
  await f.relay.close();
});
test("SPEC-MOD-013/CA-03 — a mobile approval closes the exact local prompt and resolves only once", async () => {
  const f = setup();
  await f.relay.attach("", new AbortController().signal);
  let localClosed = false;
  const human = {
    request: async (_r: any, signal: AbortSignal) =>
      new Promise<any>((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            localClosed = true;
            resolve({ answer: "no" });
          },
          { once: true },
        ),
      ),
  };
  const waiting = f.relay
    .approvals(human)
    .request(
      {
        callId: "c",
        toolName: "run_shell",
        summary: "test",
        reason: "ask",
        origin: "default",
        suggestions: [],
      },
      new AbortController().signal,
    );
  await Promise.resolve();
  await f.relay.poll(new AbortController().signal);
  const event = f.calls[1].body.events.find(
    (e: any) => e.event.type === "approval_request",
  ).event;
  f.frames([
    { seq: 1, type: "approval", requestId: event.requestId, answer: "allow" },
  ]);
  await f.relay.poll(new AbortController().signal);
  expect(await waiting).toEqual({ answer: "yes" });
  expect(localClosed).toBe(true);
  f.frames([
    { seq: 2, type: "approval", requestId: event.requestId, answer: "deny" },
  ]);
  await f.relay.poll(new AbortController().signal);
  expect(f.relay.pendingApprovals).toBe(0);
  await f.relay.close();
});
test("SPEC-MOD-016/CA-01 — active build and dynamic options attach an interactive account without an explicit setting", () => {
  expect(
    autoAttach({
      interactive: true,
      build: true,
      dynamic: true,
      eligible: true,
    }),
  ).toBe(true);
});
test("SPEC-MOD-016/CA-02 — an explicit false prevents automatic attachment regardless of options", () => {
  expect(
    autoAttach({
      interactive: true,
      build: true,
      dynamic: true,
      eligible: true,
      explicit: false,
    }),
  ).toBe(false);
  expect(
    autoAttach({
      interactive: false,
      build: true,
      dynamic: true,
      eligible: true,
      explicit: true,
    }),
  ).toBe(false);
});
{
const test = internalProfileTest;
test("SPEC-CMD-103/CA-01 — injecting a disconnect preserves buffered events and observes a logged successful reconnect", async () => {
  const f = setup();
  await f.relay.attach("", new AbortController().signal);
  f.relay.event({ type: "text", text: "queued" });
  f.relay.kick("disconnect");
  expect(f.relay.state).toBe("reconnecting");
  await f.relay.poll(new AbortController().signal);
  expect(f.relay.state).toBe("connected");
  expect(f.trace).toContain("relay_reconnected");
  expect(f.calls[1].body.events[0].event.text).toBe("queued");
  await f.relay.close();
});
}

test("TECH — duplicate remote user messages are not replayed and no remote command can alter permission modes", async () => {
  const f = setup();
  await f.relay.attach("", new AbortController().signal);
  f.frames([
    { seq: 1, type: "message", text: "one" },
    { seq: 1, type: "message", text: "one" },
    { seq: 2, type: "mode", mode: "unrestricted" },
  ]);
  await f.relay.poll(new AbortController().signal);
  expect(f.messages).toEqual(["one"]);
  await f.relay.poll(new AbortController().signal);
  expect(JSON.stringify(f.calls)).toContain("unsupported");
  await f.relay.close();
});
