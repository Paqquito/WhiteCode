// Supports: SPEC-CMD-076 and SPEC-VOX-001/002/003/004 (real interactive composition; only hardware and speech service simulated).
import { expect, test } from "bun:test";
import { interactive, sleep } from "./helpers/interactive";
import { companyFixture } from "./helpers/company";
import { Identity } from "../src/identity/identity";
import { ScriptedProvider } from "./helpers/scripted-provider";
import type { AudioSocketHandlers } from "../src/platform/audio-socket";

async function fixture(
  options: {
    denied?: boolean;
    final?: string;
    reduced?: boolean;
    read?: boolean;
  } = {},
) {
  const f = companyFixture();
  await f.login();
  const service = "https://company.example.test/speech/",
    identity = new Identity({
      ...f.identity.resolved,
      values: {
        ...f.identity.resolved.values,
        SERVICE_SPEECH_TO_TEXT: { value: service, origin: "provided" },
      },
    });
  f.handle((path) =>
    path === "/speech/session"
      ? {
          url: "wss://company.example.test/speech/stream",
          token: "fixture-scoped-only",
          expiresAt: Date.now() + 60000,
        }
      : undefined,
  );
  let opens = 0,
    stops = 0,
    handler: AudioSocketHandlers | undefined,
    frame: (bytes: Uint8Array) => void = () => {};
  const sent: Array<string | Uint8Array> = [],
    controller = new AbortController(),
    p = new ScriptedProvider(
      options.read
        ? [
            {
              toolCalls: [
                {
                  name: "read_file",
                  input: {
                    path: f.ws.write(
                      "project/src/userAccountService.ts",
                      "export const count=1;",
                    ),
                  },
                },
              ],
            },
            { text: "Read complete." },
          ]
        : [],
    );
  const run = interactive([], f.ws, {
    provider: p,
    identity,
    signal: controller.signal,
    userConfig: {
      ui: { promptSuggestions: false, reducedMotion: options.reduced ?? false },
      sessions: { autoTitle: false },
    },
    extra: {
      ...f.extra,
      microphone: async (write) => {
        opens++;
        if (options.denied) throw Error("denied fixture microphone");
        frame = write;
        return {
          stop: async () => {
            stops++;
          },
        };
      },
      speechSocket: (_url, _headers, handlers) => {
        handler = handlers;
        queueMicrotask(() =>
          handlers.open({
            send: (data) => {
              sent.push(data);
              if (
                typeof data === "string" &&
                JSON.parse(data).type === "end" &&
                options.final
              )
                handlers.message(
                  JSON.stringify({ type: "final", text: options.final }),
                );
            },
            close: () => handlers.closed(),
          }),
        );
        return { close: () => handlers.closed() };
      },
    },
  });
  const activate = async () => {
    await run.idle();
    run.type("/dictation\r");
    await run.waitFor(
      (text) => text.includes("Autoriser la dictée"),
      "dictation consent",
    );
    await sleep(400);
    run.type("o");
    await run.waitFor(
      (text) => text.includes("Dictée · maintenir"),
      "dictation ready",
    );
  };
  return {
    ...f,
    p,
    run,
    requests: f.sent,
    sent,
    activate,
    opens: () => opens,
    stops: () => stops,
    frame: (bytes: Uint8Array) => frame(bytes),
    provisional: (text: string) =>
      handler!.message(JSON.stringify({ type: "provisional", text })),
    press: () => run.raw("\u001b[32;5:1u"),
    release: () => run.raw("\u001b[32;5:3u"),
    close: async () => {
      controller.abort();
      await run.done;
    },
  };
}

test("SPEC-CMD-076/CA-01 — the actual first activation asks for consent before any speech request or microphone capture", async () => {
  const f = await fixture();
  try {
    await f.run.idle();
    f.run.type("/dictation\r");
    await f.run.waitFor(
      (text) => text.includes("Autoriser la dictée"),
      "consent",
    );
    f.press();
    expect(f.opens()).toBe(0);
    expect(f.requests.some((item) => item.path === "/speech/session")).toBe(
      false,
    );
    await sleep(400);
    f.run.type("n");
    await f.run.waitFor(
      (text) => text.includes("Dictée non activée"),
      "declined",
    );
    expect(f.sent).toEqual([]);
    expect(f.opens()).toBe(0);
    expect(f.requests.some((item) => item.path === "/speech/session")).toBe(
      false,
    );
  } finally {
    await f.close();
  }
}, 15000);
test("SPEC-VOX-001/CA-01 — SPEC-VOX-002/CA-01 — the terminal shows partial speech and inserts the final text at release without sending it", async () => {
  const f = await fixture({ final: "Texte final conservé." });
  try {
    await f.activate();
    expect(f.opens()).toBe(0);
    f.press();
    await f.run.waitFor(
      (text) => text.includes("Dictée · écoute"),
      "listening",
    );
    f.frame(new Uint8Array([255, 127]));
    f.provisional("Texte provisoire visible.");
    await f.run.waitFor(
      (text) => text.includes("Texte provisoire visible."),
      "provisional",
    );
    await sleep(120);
    f.release();
    await f.run.waitFor(
      (text) => text.includes("Texte final conservé."),
      "inserted final",
    );
    expect(f.stops()).toBe(1);
    expect(f.p.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);
test("SPEC-VOX-001/CA-02 — a denied microphone in the native interface explains the operating-system privacy setting", async () => {
  const f = await fixture({ denied: true });
  try {
    await f.activate();
    f.press();
    await f.run.waitFor(
      (text) => text.includes("réglages de confidentialité"),
      "microphone guidance",
    );
    expect(f.opens()).toBe(1);
    expect(f.p.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);
test("SPEC-VOX-002/CA-02 — missing final transcription leaves the last partial text in the actual draft", async () => {
  const f = await fixture();
  try {
    await f.activate();
    f.press();
    await f.run.waitFor(
      (text) => text.includes("Dictée · écoute"),
      "listening",
    );
    f.provisional("Derniers mots disponibles.");
    await sleep(120);
    f.release();
    await f.run.waitFor(
      (text) =>
        text.includes("Texte collé") &&
        text.includes("Derniers mots disponibles."),
      "partial fallback",
      6000,
    );
    expect(f.stops()).toBe(1);
    expect(f.p.requests).toHaveLength(0);
  } finally {
    await f.close();
  }
}, 15000);
test("SPEC-VOX-003/CA-01 — a file actually read in this session contributes its identifier words to speech startup", async () => {
  const f = await fixture({ read: true });
  try {
    await f.run.idle();
    f.run.type("Read the file.\r");
    await f.run.waitFor((text) => text.includes("Read complete."), "file read");
    await f.activate();
    f.press();
    await f.run.waitFor(
      (text) => text.includes("Dictée · écoute"),
      "listening",
    );
    const start = f.sent.find(
      (data) => typeof data === "string" && JSON.parse(data).type === "start",
    );
    expect(JSON.parse(String(start)).terms).toEqual(
      expect.arrayContaining(["user", "account", "service"]),
    );
    expect(JSON.stringify(f.sent)).not.toContain("export const count");
  } finally {
    await f.close();
  }
}, 15000);
test("SPEC-VOX-004/CA-01 — a native terminal displays a microphone gauge while holding the dictation key", async () => {
  const f = await fixture();
  try {
    await f.activate();
    f.press();
    await f.run.waitFor(
      (text) => text.includes("Dictée · écoute"),
      "listening",
    );
    f.frame(new Uint8Array([255, 127]));
    await f.run.waitFor((text) => text.includes("écoute [████]"), "live gauge");
  } finally {
    await f.close();
  }
}, 15000);
test("SPEC-VOX-004/CA-02 — reduced motion displays a static native listening indicator", async () => {
  const f = await fixture({ reduced: true });
  try {
    await f.activate();
    f.press();
    await f.run.waitFor(
      (text) => text.includes("écoute ●"),
      "static listening",
    );
    f.frame(new Uint8Array([255, 127]));
    expect(f.run.screen().join("\n")).not.toContain("écoute [████]");
  } finally {
    await f.close();
  }
}, 15000);
test("TECH — a legacy key without a release report never starts audio capture", async () => {
  const f = await fixture();
  try {
    await f.activate();
    f.run.raw("\u0000");
    await f.run.waitFor(
      (text) => text.includes("ne transmet pas le relâchement"),
      "legacy keyboard refusal",
    );
    expect(f.opens()).toBe(0);
    expect(f.requests.some((item) => item.path === "/speech/session")).toBe(
      false,
    );
  } finally {
    await f.close();
  }
}, 15000);
