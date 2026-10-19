// Implements: SPEC-API-014 (CA-01/02, memory-only credentials and a single authentication refresh).
// Supports: gap E-167.
import { startChild, launchLine } from "../platform/process";
import { splitArguments } from "../skills/invoke";
import { ProviderError, type ModelProvider, type ModelEvent } from "../providers/types";
export class CredentialHelper {
  #cached?: { value: string; expires: number };
  #operation?: { promise: Promise<string>; controller: AbortController; waiters: number };
  readonly #lifetime = new AbortController();
  constructor(readonly options: { readonly command: string; readonly cwd: string; readonly env: Readonly<Record<string, string>>; readonly ttlMs: () => number; readonly now?: () => number; readonly remember: (value: string) => void; readonly diagnostic: (data: { code: number | null; stderrBytes: number }) => void }) {}
  async get(signal: AbortSignal, rejected?: string): Promise<string> {
    signal.throwIfAborted(); this.#lifetime.signal.throwIfAborted();
    const cached = this.#cached;
    if (cached && cached.expires > (this.options.now ?? Date.now)() && (rejected === undefined || rejected !== cached.value)) return cached.value;
    if (this.#operation?.controller.signal.aborted) { await this.#operation.promise.catch(() => undefined); return this.get(signal, rejected); }
    if (!this.#operation) {
      const controller = new AbortController();
      const work = this.#read(controller.signal).then(value => { this.#lifetime.signal.throwIfAborted(); this.options.remember(value); this.#cached = { value, expires: (this.options.now ?? Date.now)() + Math.max(0, this.options.ttlMs()) }; return value; });
      const operation = { controller, waiters: 0, promise: work.finally(() => { if (this.#operation === operation) this.#operation = undefined; }) };
      this.#operation = operation;
    }
    const operation = this.#operation; operation.waiters++;
    try { return await new Promise<string>((resolve, reject) => {
      const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
      signal.addEventListener("abort", abort, { once: true });
      void operation.promise.then(value => { signal.removeEventListener("abort", abort); resolve(value); }, error => { signal.removeEventListener("abort", abort); reject(error); });
      if (signal.aborted) abort();
    }); } finally { operation.waiters--; if (operation.waiters === 0 && this.#operation === operation) operation.controller.abort(); }
  }
  async #read(signal: AbortSignal): Promise<string> {
    const [program, ...args] = splitArguments(this.options.command); if (!program) throw new Error("Credential helper command is empty.");
    const launch = launchLine(program, args, this.options.env), chunks: Buffer[] = [];
    let bytes = 0, stderrBytes = 0, timedOut = false, oversized = false, stopping: Promise<void> | undefined;
    const child = startChild(launch.file, launch.args, { cwd: this.options.cwd, env: this.options.env, onData: chunk => { bytes += chunk.length; if (bytes > 8192) { oversized = true; stop(); } else chunks.push(chunk); }, onErrorData: chunk => { stderrBytes = Math.min(1e9, stderrBytes + chunk.length); } });
    const stop = () => { stopping ??= child.killTree(100); };
    const abort = () => stop();
    signal.addEventListener("abort", abort, { once: true }); this.#lifetime.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; stop(); }, 10000);
    try {
      if (signal.aborted || this.#lifetime.signal.aborted) stop();
      const code = await child.exited; await stopping;
      this.options.diagnostic({ code, stderrBytes });
      if (signal.aborted || this.#lifetime.signal.aborted) throw new Error("Credential helper interrupted.");
      if (timedOut) throw new Error("Credential helper timed out.");
      if (oversized || code !== 0) throw new Error("Credential helper failed; its output was not retained.");
      const value = Buffer.concat(chunks).toString("utf8").trim();
      if (!value || /[\r\n\x00-\x1f\x7f]/.test(value)) throw new Error("Credential helper must return one nonempty line without control characters.");
      return value;
    } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); this.#lifetime.signal.removeEventListener("abort", abort); }
  }
  async close(): Promise<void> { this.#lifetime.abort(); this.#cached = undefined; await this.#operation?.promise.catch(() => undefined); }
}
/** Authenticate again only before any model event was exposed: never replay partly executed calls. */
export function credentialHelperProvider(helper: Pick<CredentialHelper, "get">, factory: (key: string) => ModelProvider, initialKey: string, redact: (text: string) => string, secrets: () => readonly string[]): ModelProvider {
  let activeKey = initialKey, activeProvider = factory(initialKey);
  const provider = (key: string) => { if (activeKey !== key) { activeKey = key; activeProvider = factory(key); } return activeProvider; };
  const enums: Record<string, readonly string[]> = { type: ["text_delta", "thinking_delta", "tool_call", "message_complete", "text", "image", "tool_result", "tool_use", "thinking", "redacted_thinking", "function"], role: ["assistant", "user", "system", "system_note"], provider: ["openai", "openai_compatible", "anthropic"], stopReason: ["end_turn", "tool_use", "max_tokens", "refusal", "pause_turn", "other"] };
  const scrub = (value: unknown): unknown => typeof value === "string" ? redact(value) : Array.isArray(value) ? value.map(scrub) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).map(([key, item]) => [redact(key), typeof item === "string" && enums[key]?.includes(item) ? item : scrub(item)])) : value;
  const safeError = (error: unknown) => error instanceof ProviderError ? new ProviderError(error.kind, redact(error.message), error.status, error.retryAfterMs, error.providerRequestId ? redact(error.providerRequestId) : undefined) : new Error(redact(error instanceof Error ? error.message : String(error)));
  return { id: activeProvider.id, preconnect: () => activeProvider.preconnect?.(), async *stream(request, signal) {
    let key = await helper.get(signal), emitted = false;
    const pending = new Map<"text_delta" | "thinking_delta", string>();
    function* clean(event?: ModelEvent): Generator<ModelEvent> {
      if (event?.type === "text_delta" || event?.type === "thinking_delta") {
        const buffer = (pending.get(event.type) ?? "") + event.text, values = secrets();
        let cut = Math.max(0, buffer.length - Math.max(0, ...values.map(value => value.length)) + 1), previous: number;
        // A secret crossing the output boundary stays buffered, including overlapping occurrences.
        do { previous = cut; for (const value of values.filter(Boolean)) for (let at = buffer.indexOf(value); at >= 0 && at < cut; at = buffer.indexOf(value, at + 1)) if (at + value.length > cut) cut = at; } while (cut !== previous);
        pending.set(event.type, buffer.slice(cut)); if (cut) yield { type: event.type, text: redact(buffer.slice(0, cut)) }; return;
      }
      for (const [type, text] of pending) if (text) yield { type, text: redact(text) }; pending.clear();
      if (event) yield scrub(event) as ModelEvent;
    }
    try { for await (const event of provider(key).stream(request, signal)) { emitted = true; yield* clean(event); } yield* clean(); }
    catch (error) { if (!(error instanceof ProviderError) || error.kind !== "authentication" || emitted || signal.aborted) { yield* clean(); throw safeError(error); }
      try { key = await helper.get(signal, key); for await (const event of provider(key).stream(request, signal)) yield* clean(event); yield* clean(); } catch (retryError) { yield* clean(); throw safeError(retryError); }
    }
  } };
}
