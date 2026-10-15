// Supports: SPEC-VOX-001/002/003/004 (capture lifetime, streaming transcription and bounded vocabulary).
import { expect, test } from "bun:test";
import { VoiceInput, type SpeechUpdate } from "../src/voice/input";
import { speechVocabulary } from "../src/voice/vocabulary";

function fixture(options: { denied?: boolean; final?: boolean } = {}) {
  let update: (event: SpeechUpdate) => void = () => {},
    frame: (bytes: Uint8Array) => void = () => {},
    stopped = 0,
    closed = 0;
  const drafts: string[] = [],
    notices: string[] = [],
    states: string[] = [],
    sent: Uint8Array[] = [];
  const voice = new VoiceInput({
    allowed: () => true,
    terms: () => ["project"],
    capture: async (write) => {
      if (options.denied) throw Error("microphone denied");
      frame = write;
      return {
        stop: async () => {
          stopped++;
        },
      };
    },
    transcription: async (_terms, _signal, receive) => {
      update = receive;
      return {
        send: (bytes) => {
          sent.push(bytes);
        },
        finish: () => {
          if (options.final) receive({ type: "final", text: "Final text." });
        },
        close: () => {
          closed++;
        },
      };
    },
    insert: (text) => drafts.push(text),
    report: (text) => notices.push(text),
    changed: () => states.push(voice.state),
    minHoldMs: 0,
    finalTimeoutMs: 20,
  });
  voice.enable(true);
  return {
    voice,
    drafts,
    notices,
    states,
    sent,
    frame: (bytes: Uint8Array) => frame(bytes),
    update: (event: SpeechUpdate) => update(event),
    stopped: () => stopped,
    closed: () => closed,
  };
}

test("SPEC-VOX-001/CA-01 — capture stops at release and finalized dictation is inserted once without any submission channel", async () => {
  const f = fixture({ final: true });
  try {
    await f.voice.press();
    f.frame(new Uint8Array([0, 20, 0, 15]));
    f.update({ type: "provisional", text: "Partial" });
    expect(f.drafts).toEqual([]);
    await f.voice.release();
    expect(f.drafts).toEqual(["Final text."]);
    expect(f.stopped()).toBe(1);
    expect(f.closed()).toBe(1);
    f.frame(new Uint8Array([1, 1]));
    expect(f.sent).toHaveLength(1);
  } finally {
    await f.voice.close();
  }
});
test("SPEC-VOX-001/CA-02 — a refused microphone produces the operating-system permission guidance and closes the speech connection", async () => {
  const f = fixture({ denied: true });
  try {
    await f.voice.press();
    expect(f.notices.join()).toContain("microphone");
    expect(f.notices.join()).toContain("réglages");
    expect(f.closed()).toBe(1);
    expect(f.drafts).toEqual([]);
  } finally {
    await f.voice.close();
  }
});
test("SPEC-VOX-002/CA-01 — successive provisional messages update the visible state while capture continues", async () => {
  const f = fixture();
  try {
    await f.voice.press();
    f.update({ type: "provisional", text: "One" });
    expect(f.voice.provisional).toBe("One");
    f.update({ type: "provisional", text: "One two" });
    expect(f.voice.provisional).toBe("One two");
    expect(f.voice.indicator(false)).toContain("One two");
    expect(f.voice.state).toBe("listening");
  } finally {
    await f.voice.close();
  }
});
test("SPEC-VOX-002/CA-02 — release without a final message inserts the last provisional at the bounded deadline", async () => {
  const f = fixture();
  try {
    await f.voice.press();
    f.update({ type: "provisional", text: "Last usable words." });
    const started = Date.now();
    await f.voice.release();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.drafts).toEqual(["Last usable words."]);
    expect(f.voice.state).toBe("ready");
    expect(f.closed()).toBe(1);
  } finally {
    await f.voice.close();
  }
});
test("SPEC-VOX-003/CA-01 — consulted filename words reach the bounded project-first vocabulary without file contents", () => {
  const vocabulary = speechVocabulary({
    files: ["src/userAccountService.ts"],
    project: "DemoProject",
    branches: ["fix/http-client"],
    extra: [],
  });
  expect(vocabulary).toEqual(
    expect.arrayContaining(["user", "account", "service"]),
  );
  expect(
    speechVocabulary({
      files: Array.from({ length: 2000 }, (_, i) => "part" + i + "Name.ts"),
      project: "Demo",
      branches: [],
      extra: [],
    }),
  ).toHaveLength(256);
});
test("SPEC-VOX-004/CA-01 — the listening indicator displays the microphone level from captured PCM", async () => {
  const f = fixture();
  try {
    await f.voice.press();
    f.frame(new Uint8Array([255, 127, 255, 127]));
    expect(f.voice.indicator(false)).toContain("écoute");
    expect(f.voice.indicator(false)).toContain("█");
  } finally {
    await f.voice.close();
  }
});
test("SPEC-VOX-004/CA-02 — reduced motion uses a static listening symbol regardless of the measured level", async () => {
  const f = fixture();
  try {
    await f.voice.press();
    const first = f.voice.indicator(true);
    f.frame(new Uint8Array([255, 127, 255, 127]));
    expect(f.voice.indicator(true)).toBe(first);
    expect(first).toContain("●");
  } finally {
    await f.voice.close();
  }
});
test("TECH — releasing while speech opens cannot start a microphone afterwards", async () => {
  let opened = () => {};
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  let captures = 0,
    closed = 0;
  const voice = new VoiceInput({
    allowed: () => true,
    terms: () => [],
    capture: async () => {
      captures++;
      return { stop: async () => {} };
    },
    transcription: async () => {
      await ready;
      return {
        send: () => {},
        finish: () => {},
        close: () => {
          closed++;
        },
      };
    },
    insert: () => {
      throw Error("Unexpected draft");
    },
    report: () => {},
    changed: () => {},
  });
  voice.enable(true);
  const pressing = voice.press();
  await Promise.resolve();
  await voice.release();
  opened();
  await pressing;
  expect(captures).toBe(0);
  expect(closed).toBe(1);
  await voice.close();
});
test("TECH — closing waits for late native capture creation and its actual shutdown", async () => {
  let entered = () => {},
    open = () => {},
    stop = () => {},
    closed = false,
    stopped = false;
  const captureEntered = new Promise<void>((r) => {
      entered = r;
    }),
    captureOpen = new Promise<void>((r) => {
      open = r;
    }),
    captureStopped = new Promise<void>((r) => {
      stop = r;
    });
  const voice = new VoiceInput({
    allowed: () => true,
    terms: () => [],
    transcription: async () => ({
      send: () => {},
      finish: () => {},
      close: () => {},
    }),
    capture: async () => {
      entered();
      await captureOpen;
      return {
        stop: async () => {
          await captureStopped;
          stopped = true;
        },
      };
    },
    insert: () => {
      throw Error("Unexpected insertion");
    },
    report: () => {},
    changed: () => {},
  });
  voice.enable(true);
  const press = voice.press();
  await captureEntered;
  const closing = voice.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  open();
  await Promise.resolve();
  expect(closed).toBe(false);
  stop();
  await Promise.all([press, closing]);
  expect(stopped).toBe(true);
  expect(closed).toBe(true);
});
