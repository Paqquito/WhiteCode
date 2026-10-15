// Supports: SPEC-VOX-002 (real account boundary and safe persistent audio transport).
import { expect, test } from "bun:test";
import {
  audioSocketConnector,
  type AudioSocketHandlers,
} from "../src/platform/audio-socket";
import { openSpeech } from "../src/voice/speech";
import { companyFixture } from "./helpers/company";
import { configuredCompanyAccount } from "../src/auth/company-runtime";
import { Identity } from "../src/identity/identity";
import { Settings } from "../src/config/settings";

test("TECH — an audio WebSocket never follows an HTTP redirect with its scoped credential", async () => {
  let hits = 0;
  const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        hits++;
        return new Response("unexpected");
      },
    }),
    redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        Response.redirect(`http://127.0.0.1:${destination.port}/socket`, 302),
    });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("WebSocket redirect deadline")),
        2000,
      );
      audioSocketConnector({ noProxy: ["*"], caHint: "test" })(
        `ws://127.0.0.1:${redirect.port}/socket`,
        { Authorization: "Bearer fixture-scoped-only" },
        {
          open: (peer) => peer.close(),
          message: () => {},
          closed: () => {
            clearTimeout(timer);
            resolve();
          },
        },
      );
    });
    expect(hits).toBe(0);
  } finally {
    redirect.stop(true);
    destination.stop(true);
  }
});
test("TECH — speech uses the account only for a scoped session and streams binary PCM with project vocabulary", async () => {
  const f = companyFixture();
  await f.login();
  const service = "https://company.example.test/speech/",
    identity = new Identity({
      ...f.identity.resolved,
      values: {
        ...f.identity.resolved.values,
        SERVICE_SPEECH_TO_TEXT: { value: service, origin: "provided" },
      },
    }),
    account = configuredCompanyAccount(
      identity,
      f.ws.configHome,
      () => Settings.load({ sources: [], projectTrusted: false }),
      f.vault,
      f.network,
    )!;
  f.handle((path) =>
    path === "/speech/session"
      ? {
          url: "wss://company.example.test/speech/stream",
          token: "fixture-scoped-only",
          expiresAt: Date.now() + 60000,
        }
      : undefined,
  );
  let handlers: AudioSocketHandlers | undefined;
  const frames: Array<string | Uint8Array> = [],
    events: unknown[] = [],
    scope = new AbortController();
  let closed = 0;
  const connection = await openSpeech({
    account,
    service,
    language: "fr",
    terms: ["user", "account", "service"],
    signal: scope.signal,
    receive: (event) => events.push(event),
    connect: (url, headers, receive) => {
      expect(url).toBe("wss://company.example.test/speech/stream");
      expect(headers).toEqual({ Authorization: "Bearer fixture-scoped-only" });
      handlers = receive;
      queueMicrotask(() =>
        receive.open({
          send: (frame) => {
            frames.push(frame);
            if (typeof frame === "string" && JSON.parse(frame).type === "end")
              receive.message(
                JSON.stringify({ type: "final", text: "Terminé." }),
              );
          },
          close: () => {
            closed++;
          },
        }),
      );
      return {
        close: () => {
          closed++;
        },
      };
    },
  });
  try {
    expect(JSON.parse(String(frames[0])).terms).toEqual([
      "user",
      "account",
      "service",
    ]);
    connection.send(new Uint8Array([0, 0, 0, 20]));
    connection.finish();
    await new Promise((r) => setTimeout(r, 20));
    expect(frames[1]).toEqual(new Uint8Array([0, 0, 0, 20]));
    expect(events).toContainEqual({ type: "final", text: "Terminé." });
    expect(
      f.sent.find((request) => request.path === "/speech/session")
        ?.authorization,
    ).toBe("Bearer fixture-company-only");
    handlers!.message(JSON.stringify({ type: "provisional", text: "latest" }));
    expect(events).toContainEqual({ type: "provisional", text: "latest" });
  } finally {
    connection.close();
    scope.abort();
  }
  expect(closed).toBeGreaterThan(0);
});
test("TECH — disconnecting the account closes speech before another captured frame is sent", async () => {
  const f = companyFixture();
  await f.login();
  const service = "https://company.example.test/speech/",
    identity = new Identity({
      ...f.identity.resolved,
      values: {
        ...f.identity.resolved.values,
        SERVICE_SPEECH_TO_TEXT: { value: service, origin: "provided" },
      },
    }),
    account = configuredCompanyAccount(
      identity,
      f.ws.configHome,
      () => Settings.load({ sources: [], projectTrusted: false }),
      f.vault,
      f.network,
    )!;
  f.handle((path) =>
    path === "/speech/session"
      ? {
          url: "wss://company.example.test/speech/stream",
          token: "fixture-scoped-only",
          expiresAt: Date.now() + 60000,
        }
      : undefined,
  );
  const audio: Uint8Array[] = [],
    events: unknown[] = [],
    scope = new AbortController();
  const connection = await openSpeech({
    account,
    service,
    language: "fr",
    terms: [],
    signal: scope.signal,
    receive: (event) => events.push(event),
    connect: (_url, _headers, handlers) => {
      queueMicrotask(() =>
        handlers.open({
          send: (frame) => {
            if (typeof frame !== "string") audio.push(frame);
          },
          close: () => handlers.closed(),
        }),
      );
      return { close: () => handlers.closed() };
    },
  });
  try {
    await account.signOut(scope.signal);
    connection.send(new Uint8Array([10, 10]));
    const deadline = Date.now() + 2000;
    while (
      !events.some((event) => (event as { type?: string }).type === "closed") &&
      Date.now() < deadline
    )
      await new Promise((r) => setTimeout(r, 10));
    expect(audio).toEqual([]);
    expect(events).toContainEqual({ type: "closed" });
  } finally {
    connection.close();
    scope.abort();
  }
});
