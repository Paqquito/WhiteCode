// Implements: SPEC-VOX-002 (owner-bound authenticated speech session and bounded persistent stream).
import type { CompanyAccount } from "../auth/company-account";
import type {
  AudioSocketConnect,
  AudioSocketPeer,
} from "../platform/audio-socket";
import type { SpeechConnection, SpeechUpdate } from "./input";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export async function openSpeech(options: {
  account: CompanyAccount;
  service: string;
  language: string;
  terms: readonly string[];
  signal: AbortSignal;
  receive: (event: SpeechUpdate) => void;
  connect: AudioSocketConnect;
  expectedBinding?: string;
}): Promise<SpeechConnection> {
  const signal = options.signal;
  signal.throwIfAborted();
  const before = await options.account.sessionBinding(),
    profile = await options.account.profile(),
    binding = await options.account.sessionBinding();
  if (
    !profile ||
    !binding ||
    before !== binding ||
    (options.expectedBinding !== undefined &&
      binding !== options.expectedBinding)
  )
    throw Error("Company account required for dictation.");
  const owner = {
      account: profile.account,
      organizationId: profile.organization.id,
    },
    base = new URL(options.service);
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  )
    throw Error("Invalid speech service.");
  const raw = await options.account.request(
    "speech",
    "session",
    {
      language: options.language,
      format: "pcm_s16le",
      sampleRate: 16000,
      channels: 1,
    },
    signal,
    owner,
  );
  if (
    !object(raw) ||
    typeof raw["url"] !== "string" ||
    typeof raw["token"] !== "string" ||
    !raw["token"].length ||
    raw["token"].length > 8192 ||
    /[\x00-\x20\x7f]/.test(raw["token"]) ||
    !Number.isFinite(raw["expiresAt"]) ||
    Number(raw["expiresAt"]) <= Date.now() ||
    Number(raw["expiresAt"]) > Date.now() + 120000
  )
    throw Error("Invalid speech session.");
  const url = new URL(raw["url"]),
    prefix = base.pathname.replace(/\/?$/, "/");
  if (
    raw["url"].length > 4096 ||
    url.protocol !== "wss:" ||
    url.host !== base.host ||
    !url.pathname.startsWith(prefix) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw Error("Speech connection must use the configured secure origin.");
  if ((await options.account.sessionBinding()) !== binding)
    throw Error("Speech account changed.");
  signal.throwIfAborted();
  return await new Promise<SpeechConnection>((resolve, reject) => {
    let peer: AudioSocketPeer | undefined,
      connected = false,
      closed = false,
      pending = 0,
      queue = Promise.resolve(),
      ping: ReturnType<typeof setInterval> | undefined;
    let socket: { close(): void } | undefined,
      expiration: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      close();
    }, 5000);
    const close = () => {
      if (closed) return;
      closed = true;
      if (!connected) reject(Error("Speech connection unavailable."));
      clearTimeout(timer);
      clearTimeout(expiration);
      clearInterval(ping);
      signal.removeEventListener("abort", abort);
      socket?.close();
      options.receive({ type: "closed" });
    };
    const abort = () => {
      close();
      if (!connected) reject(signal.reason ?? Error("Dictation interrupted."));
    };
    signal.addEventListener("abort", abort, { once: true });
    expiration = setTimeout(close, Number(raw["expiresAt"]) - Date.now());
    const connection: SpeechConnection = {
      send: (bytes) => {
        if (closed || !peer || pending >= 16 || bytes.byteLength > 65536)
          throw Error("Speech audio queue is full.");
        pending++;
        const copy = bytes.slice();
        queue = queue
          .then(async () => {
            if (closed || signal.aborted) return;
            if ((await options.account.sessionBinding()) !== binding) {
              close();
              return;
            }
            if (!closed && !signal.aborted) peer?.send(copy);
          })
          .catch(() => close())
          .finally(() => {
            pending--;
          });
      },
      finish: () => {
        void queue
          .then(() => {
            if (!closed) peer?.send(JSON.stringify({ type: "end" }));
          })
          .catch(() => close());
      },
      close,
    };
    try {
      socket = options.connect(
        url.href,
        { Authorization: "Bearer " + raw["token"] },
        {
          open: (value) => {
            void (async () => {
              if (
                closed ||
                signal.aborted ||
                (await options.account.sessionBinding()) !== binding
              ) {
                value.close();
                close();
                return;
              }
              peer = value;
              value.send(
                JSON.stringify({
                  type: "start",
                  language: options.language,
                  format: "pcm_s16le",
                  sampleRate: 16000,
                  channels: 1,
                  terms: options.terms.slice(0, 256),
                }),
              );
              connected = true;
              clearTimeout(timer);
              ping = setInterval(() => {
                try {
                  value.send(JSON.stringify({ type: "ping" }));
                } catch {
                  close();
                }
              }, 10000);
              resolve(connection);
            })().catch(() => close());
          },
          message: (text) => {
            try {
              if (text.length > 32768) throw Error();
              const event: unknown = JSON.parse(text);
              if (!object(event)) throw Error();
              if (event["type"] === "pong") return;
              if (
                !["provisional", "final"].includes(String(event["type"])) ||
                typeof event["text"] !== "string" ||
                event["text"].length > 8192 ||
                Object.keys(event).some(
                  (key) => !["type", "text"].includes(key),
                )
              )
                throw Error();
              options.receive({
                type: event["type"] as "provisional" | "final",
                text: event["text"],
              });
            } catch {
              close();
            }
          },
          closed: () => {
            close();
            if (!connected) reject(Error("Speech connection unavailable."));
          },
        },
      );
      if (closed) socket.close();
      if (signal.aborted) abort();
    } catch {
      close();
      reject(Error("Speech connection unavailable."));
    }
  });
}
