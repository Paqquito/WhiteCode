// Implements: SPEC-VOX-001/002/004 (bounded push-to-talk state, provisional text and final fallback).
export type SpeechUpdate =
  { type: "provisional" | "final"; text: string } | { type: "closed" };
export interface SpeechConnection {
  send(bytes: Uint8Array): void;
  finish(): void;
  close(): void;
}
export interface MicrophoneCapture {
  stop(): Promise<void>;
}
export type VoiceState =
  "off" | "ready" | "connecting" | "listening" | "finalizing" | "error";
export interface VoiceOptions {
  readonly allowed: () => boolean;
  readonly terms: () => readonly string[];
  readonly capture: (
    write: (bytes: Uint8Array) => void,
    signal: AbortSignal,
    failed: () => void,
  ) => Promise<MicrophoneCapture>;
  readonly transcription: (
    terms: readonly string[],
    signal: AbortSignal,
    receive: (event: SpeechUpdate) => void,
  ) => Promise<SpeechConnection>;
  readonly insert: (text: string) => void;
  readonly report: (message: string) => void;
  readonly changed: () => void;
  readonly minHoldMs?: number;
  readonly finalTimeoutMs?: number;
  readonly maxHoldMs?: number;
}
export class VoiceInput {
  #opening?: Promise<void>;
  #enabled = false;
  #closed = false;
  #held = false;
  #serial = 0;
  #pressedAt = 0;
  #scope?: AbortController;
  #microphone?: MicrophoneCapture;
  #speech?: SpeechConnection;
  #finalReceived = false;
  #resolveFinal?: () => void;
  #limit?: ReturnType<typeof setTimeout>;
  #stopping: Promise<void> = Promise.resolve();
  #level = 0;
  #provisional = "";
  #state:
    "off" | "ready" | "connecting" | "listening" | "finalizing" | "error" =
    "off";
  constructor(readonly options: VoiceOptions) {}
  get state() {
    return this.#state;
  }
  get provisional() {
    return this.#provisional;
  }
  get enabled() {
    return this.#enabled;
  }
  #set(state: VoiceState) {
    this.#state = state;
    this.options.changed();
  }
  enable(value: boolean): void {
    if (this.#closed) return;
    this.#enabled = value;
    if (!value) void this.cancel();
    else this.#set("ready");
  }
  indicator(reduced: boolean): string {
    if (this.#state === "off") return "";
    if (this.#state === "listening")
      return `Dictée · écoute ${reduced ? "●" : "[" + "█".repeat(this.#level) + "·".repeat(4 - this.#level) + "]"}${this.#provisional ? " · " + this.#provisional.replace(/\s+/g, " ").slice(-120) : ""}`;
    return this.#state === "ready"
      ? "Dictée · maintenir Ctrl+Espace"
      : this.#state === "connecting"
        ? "Dictée · connexion…"
        : this.#state === "finalizing"
          ? "Dictée · finalisation…"
          : "Dictée · indisponible";
  }
  press(): Promise<void> {
    if (this.#opening) return this.#opening;
    const pending = this.#press();
    this.#opening = pending;
    void pending
      .finally(() => {
        if (this.#opening === pending) this.#opening = undefined;
      })
      .catch(() => {});
    return pending;
  }
  async #press(): Promise<void> {
    if (
      this.#closed ||
      !this.#enabled ||
      this.#held ||
      this.#state === "finalizing" ||
      !this.options.allowed()
    )
      return;
    this.#held = true;
    this.#pressedAt = Date.now();
    this.#provisional = "";
    this.#level = 0;
    this.#finalReceived = false;
    const serial = ++this.#serial,
      scope = new AbortController();
    this.#scope = scope;
    this.#set("connecting");
    let stage: "transcription" | "microphone" = "transcription";
    try {
      await this.#stopping;
      if (serial !== this.#serial || !this.#held || scope.signal.aborted)
        return;
      const speech = await this.options.transcription(
        this.options.terms(),
        scope.signal,
        (event) => {
          if (serial !== this.#serial || scope.signal.aborted) return;
          if (event.type === "closed") {
            this.#finalReceived = true;
            this.#resolveFinal?.();
            if (this.#held) void this.release();
            return;
          }
          if (
            typeof event.text !== "string" ||
            event.text.length > 8192 ||
            /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(event.text)
          )
            return;
          if (this.#finalReceived && event.type === "provisional") return;
          this.#provisional = event.text;
          this.#finalReceived = event.type === "final";
          if (this.#finalReceived) this.#resolveFinal?.();
          this.options.changed();
        },
      );
      if (
        serial !== this.#serial ||
        !this.#held ||
        scope.signal.aborted ||
        !this.options.allowed()
      ) {
        speech.close();
        return;
      }
      this.#speech = speech;
      stage = "microphone";
      const capture = await this.options.capture(
        (bytes) => {
          if (!this.#held || serial !== this.#serial || scope.signal.aborted)
            return;
          if (!this.options.allowed() || bytes.byteLength > 65536) {
            void this.cancel();
            return;
          }
          let peak = 0;
          const view = new DataView(
            bytes.buffer,
            bytes.byteOffset,
            bytes.byteLength,
          );
          for (let i = 0; i + 1 < bytes.byteLength; i += 2)
            peak = Math.max(peak, Math.abs(view.getInt16(i, true)) / 32768);
          this.#level = Math.min(4, Math.ceil(peak * 4));
          try {
            speech.send(bytes);
          } catch {
            void this.release();
          }
          this.options.changed();
        },
        scope.signal,
        () => {
          if (serial !== this.#serial || scope.signal.aborted) return;
          this.options.report(
            "Microphone indisponible ou refusé : autorisez le microphone dans les réglages de confidentialité du système pour votre terminal, puis réessayez.",
          );
          void this.cancel().then(() => {
            if (this.#enabled && !this.#closed) this.#set("error");
          });
        },
      );
      if (
        serial !== this.#serial ||
        !this.#held ||
        scope.signal.aborted ||
        !this.options.allowed()
      ) {
        await capture.stop();
        return;
      }
      this.#microphone = capture;
      this.#set("listening");
      this.#limit = setTimeout(
        () => {
          this.options.report("Dictée arrêtée après la durée maximale.");
          void this.release();
        },
        Math.min(60000, this.options.maxHoldMs ?? 60000),
      );
    } catch {
      if (serial !== this.#serial || scope.signal.aborted) return;
      this.options.report(
        stage === "microphone"
          ? "Microphone indisponible ou refusé : autorisez le microphone dans les réglages de confidentialité du système pour votre terminal, puis réessayez."
          : "Transcription vocale indisponible ; aucune capture n’a été conservée.",
      );
      await this.cancel();
      if (this.#enabled && !this.#closed) this.#set("error");
    }
  }
  async #stopMicrophone(): Promise<void> {
    const microphone = this.#microphone;
    this.#microphone = undefined;
    if (microphone)
      this.#stopping = Promise.all([this.#stopping, microphone.stop()])
        .then(() => {})
        .catch(() => {
          this.options.report("L’arrêt du microphone a échoué.");
        });
    await this.#stopping;
  }
  async release(): Promise<void> {
    if (!this.#held) return;
    this.#held = false;
    clearTimeout(this.#limit);
    this.#limit = undefined;
    const scope = this.#scope,
      serial = this.#serial,
      speech = this.#speech;
    if (!speech) {
      scope?.abort();
      this.#serial++;
      this.#set(this.#enabled ? "ready" : "off");
      return;
    }
    const short =
      Date.now() - this.#pressedAt < (this.options.minHoldMs ?? 100);
    this.#set("finalizing");
    try {
      await this.#stopMicrophone();
      if (short) {
        this.#provisional = "";
        return;
      }
      speech.finish();
      if (!this.#finalReceived) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new Promise<void>((resolve) => {
              this.#resolveFinal = resolve;
            }),
            new Promise<void>((resolve) => {
              timer = setTimeout(
                resolve,
                Math.min(10000, this.options.finalTimeoutMs ?? 3000),
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          this.#resolveFinal = undefined;
        }
      }
      if (
        serial === this.#serial &&
        !scope?.signal.aborted &&
        this.options.allowed() &&
        this.#provisional.trim()
      )
        this.options.insert(this.#provisional);
    } catch {
      this.options.report("Finalisation vocale indisponible.");
    } finally {
      speech.close();
      if (this.#speech === speech) this.#speech = undefined;
      scope?.abort();
      if (serial === this.#serial) this.#set(this.#enabled ? "ready" : "off");
    }
  }
  async cancel(): Promise<void> {
    this.#held = false;
    this.#serial++;
    clearTimeout(this.#limit);
    this.#limit = undefined;
    this.#scope?.abort();
    this.#resolveFinal?.();
    const speech = this.#speech;
    this.#speech = undefined;
    speech?.close();
    await this.#stopMicrophone();
    this.#provisional = "";
    this.#set(this.#enabled && !this.#closed ? "ready" : "off");
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.#enabled = false;
    await this.cancel();
    await this.#opening;
  }
}
