// Supports: SPEC-CMD-107 (CA-01, displayed identifier shared by actual spans), gap E-161.
// Implements: SPEC-OBS-001/002/004/011/020 (bounded exports, refusal, private diagnostics).
// Supports: SPEC-CFG-008, SPEC-MOT-001, SPEC-SES-012, E-157.
// Supports: SPEC-OBS-005/007/010 (consented metadata and measured frame histogram), E-160.
import { buildFlag } from "../extension-points/build-flags" with { type: "macro" };
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ProviderError, type ContentPart, type ModelProvider } from "../providers/types";
import type { EngineEvent } from "../engine/events";
import { writeAtomic } from "../tools/text-file";
import { currentPlatform } from "../platform/system";
import { maskSecrets } from "../shared/secrets";

const TOOLS = new Set(["read_file", "write_file", "edit_file", "run_shell", "run_powershell", "find_files", "search_content", "fetch_url", "spawn_agent", "configure", "submit_result", "background_output", "other"]);
const EVENTS = ["session_started", "message_submitted", "api_request", "api_error", "tool_result", "permission", "session_ended", "render_summary"] as const;
type EventName = typeof EVENTS[number];
type Attributes = Record<string, string | number | boolean>;
type OtlpAttribute = { key: string; value: { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean } };
const attributes = (a: Attributes): OtlpAttribute[] => Object.entries(a).map(([key, value]) => ({ key, value: typeof value === "string" ? { stringValue: value } : typeof value === "boolean" ? { boolValue: value } : Number.isSafeInteger(value) ? { intValue: String(value) } : { doubleValue: value } }));
const nano = () => String(BigInt(Date.now()) * 1_000_000n);
const toolName = (name: string) => TOOLS.has(name) ? name : "other";

/** Compile-time call vocabulary plus a runtime allowlist: persisted data and ports remain untrusted. */
export function productAttributes(input: Readonly<Record<string, unknown>>): Attributes {
  const out: Attributes = {};
  for (const [key, value] of Object.entries(input)) {
    if (["length", "tokens", "duration_ms", "count"].includes(key) && typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12) out[key] = value;
    if (key === "tool" && typeof value === "string" && TOOLS.has(value)) out[key] = value;
    if (key === "result" && ["ok", "error", "cancelled"].includes(String(value))) out[key] = String(value);
    if (key === "decision" && ["allow", "deny", "ask"].includes(String(value))) out[key] = String(value);
  }
  return out;
}

function ordinaryDirectory(path: string): void {
  const missing: string[] = [];
  for (let p = resolve(path); ; p = dirname(p)) {
    if (existsSync(p)) { const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw new Error("Dossier de diagnostic non ordinaire."); }
    else missing.push(p);
    if (p === dirname(p)) break;
  }
  for (const p of missing.reverse()) {
    try { mkdirSync(p, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink()) throw e; }
  }
}
function ordinaryFile(path: string, max: number): boolean {
  try { const s = lstatSync(path); return s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= max; } catch { return false; }
}
function exportUrl(value: string | undefined, insecureLocal = false): string | undefined {
  if (!value) return undefined;
  try { const u = new URL(value); if ((u.protocol !== "https:" && !(insecureLocal && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))) || u.username || u.password || u.hash || u.search) return undefined; return u.href; } catch { return undefined; }
}

export interface ObserverOptions {
  readonly experimentBaseline?: boolean;
  readonly onLoggedError?: (stack: string) => void;
  readonly enhanced?: boolean; readonly includeToolContent?: boolean;
  readonly commonProductAttributes?: Readonly<Record<string, string>>; readonly commonTraceAttributes?: Readonly<Record<string, string>>;
  readonly slug: string; readonly eventPrefix: string; readonly version: string;
  readonly configDir: string; readonly platform: string; readonly persist: boolean;
  readonly sessionId: () => string; readonly entrypoint: "interactive" | "non-interactive" | "control";
  readonly productEnabled: () => boolean; readonly otelEnabled: () => boolean;
  readonly errorEnabled: () => boolean; readonly includePrompts: boolean; readonly includeSessionId: boolean;
  readonly environment: (name: string) => string | undefined;
  readonly productUrl?: string; readonly errorUrl?: string;
  readonly fetch: typeof fetch; readonly warn: (message: string) => void;
  readonly console: (message: string) => void;
  readonly diagnosticRetentionDays: number; readonly secrets: readonly string[];
}
interface Span {
  traceId: string; spanId: string; parentSpanId?: string; name: string; kind: number;
  startTimeUnixNano: string; endTimeUnixNano?: string; attributes: OtlpAttribute[];
  status: { code: number; message?: string };
}
interface Interaction { root: Span; spans: Span[]; calls: Map<string, { span?: Span; name: string; start: number }> }
interface ProductEvent { name: EventName; attributes: Attributes }

export class SessionObserver {
  readonly #o: ObserverOptions;
  readonly #context = new AsyncLocalStorage<Interaction>();
  readonly #started = nano(); readonly #instance = randomUUID(); readonly #device = randomUUID();
  readonly #metrics = new Map<string, { name: string; attributes: Attributes; value: number }>();
  readonly #durations = new Map<string, { name: string; values: number[] }>();
  readonly #diagnostics: Array<Record<string, unknown>> = [];
  readonly #deduplicated = new Set<string>(); readonly #abort = new AbortController();
  #productAbort = new AbortController();
  #products: ProductEvent[] = []; #logs: Array<Record<string, unknown>> = []; #spans: Span[] = [];
  #previousFiles: string[] = []; #timer?: ReturnType<typeof setInterval>; #flushing?: Promise<void>;
  #closed = false;
  #manualTrace?: string;
  #traceStopped = false;
  #renderSummary?: { frames: number; durationMs: number; slowFrames: number; buckets: readonly number[] };

  constructor(options: ObserverOptions) { this.#o = options; }
  get traceId(): string | undefined { return this.#manualTrace; }
  beginTrace(): string { this.#traceStopped = false; return this.#manualTrace ??= randomBytes(16).toString("hex"); }
  stopTrace(): void { this.#traceStopped = true; this.#manualTrace = undefined; }
  start(): void {
    this.#diagnostic("session_started");
    if (this.#o.persist && this.#o.productEnabled() && exportUrl(this.#o.productUrl)) this.#loadPending();
    this.#record("session_started", {}); this.#count("session.usage", {}, 1);
    this.#persist();
    this.#timer = setInterval(() => { this.#persist(); void this.flush(); }, 5000); this.#timer.unref();
  }
  /** Refusal also stops connections which started before a settings reload. */
  recheck(): void {
    if (!this.#o.productEnabled()) { this.#productAbort.abort(); this.#products = []; }
    else if (this.#productAbort.signal.aborted) this.#productAbort = new AbortController();
  }
  #diagnostic(event: "session_started" | "session_ended" | "connection_error" | "api_error" | "unexpected_error", kind?: string): void {
    if (this.#diagnostics.length >= 512) this.#diagnostics.shift();
    this.#diagnostics.push({ at: Date.now(), event, ...(kind ? { kind } : {}) });
  }
  #record(name: EventName, data: Attributes): void {
    if (!this.#o.productEnabled() || !exportUrl(this.#o.productUrl)) { this.#products = []; return; }
    if (this.#products.length < 256) this.#products.push({ name, attributes: { ...productAttributes(data), ...this.#o.commonProductAttributes, ...(this.#o.experimentBaseline ? { "experiment.baseline": true } : {}) } });
  }
  #log(name: EventName, data: Attributes): void {
    if (!this.#o.otelEnabled() || this.#logs.length >= 512) return;
    const ctx = this.#context.getStore();
    this.#logs.push({ timeUnixNano: nano(), severityNumber: 9, severityText: "INFO", body: { stringValue: name }, attributes: attributes(data), ...(ctx ? { traceId: ctx.root.traceId, spanId: ctx.root.spanId } : {}) });
  }
  #count(name: string, data: Attributes, n: number): void {
    if (!this.#o.otelEnabled() || !Number.isFinite(n) || n < 0) return;
    const key = name + JSON.stringify(data), previous = this.#metrics.get(key);
    if (!previous && this.#metrics.size >= 128) return;
    this.#metrics.set(key, { name, attributes: data, value: (previous?.value ?? 0) + n });
  }
  #duration(name: string, ms: number): void {
    if (!this.#o.otelEnabled()) return;
    const previous = this.#durations.get(name) ?? { name, values: [] };
    if (previous.values.length < 10000) previous.values.push(Math.max(0, ms));
    this.#durations.set(name, previous);
  }
  #span(name: string, data: Attributes = {}): Span | undefined {
    const ctx = this.#context.getStore();
    if (!ctx || this.#traceStopped || !this.#o.otelEnabled() || ctx.spans.length >= 1000) return undefined;
    const span: Span = { traceId: ctx.root.traceId, spanId: randomBytes(8).toString("hex"), parentSpanId: ctx.root.spanId, name, kind: 1, startTimeUnixNano: nano(), attributes: attributes(data), status: { code: 0 } };
    ctx.spans.push(span); return span;
  }
  async interaction<T>(parts: string | readonly ContentPart[], signal: AbortSignal, run: () => Promise<T>): Promise<T> {
    const root: Span = { traceId: this.#manualTrace ?? randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex"), name: "interaction", kind: 1, startTimeUnixNano: nano(), attributes: [], status: { code: 0 } };
    const ctx: Interaction = { root, spans: [root], calls: new Map() }, start = Date.now();
    return this.#context.run(ctx, async () => {
      const prompt = typeof parts === "string" ? parts : parts.filter(p => p.type === "text").map(p => p.text).join("\n");
      this.#record("message_submitted", { length: prompt.length });
      const data: Attributes = { length: prompt.length };
      if (this.#o.includePrompts) { let safe = maskSecrets(prompt); for (const secret of this.#o.secrets.filter(Boolean)) safe = safe.split(secret).join("[redacted]"); data.content = safe.slice(0, 16384); }
      this.#log("message_submitted", data);
      let failed = false;
      try { return await run(); } catch (e) { failed = true; throw e; }
      finally {
        const cancelled = signal.aborted;
        for (const span of ctx.spans) { span.endTimeUnixNano ??= nano(); if (cancelled) span.status = { code: 2, message: "cancelled" }; else if (failed) span.status = { code: 2, message: "error" }; }
        this.#duration("interaction.duration", Date.now() - start);
        if (!this.#traceStopped && this.#o.otelEnabled() && this.#spans.length + ctx.spans.length <= 2000) this.#spans.push(...ctx.spans);
      }
    });
  }
  provider(provider: ModelProvider): ModelProvider {
    const observer = this;
    return { id: provider.id, async *stream(request, signal) {
      const start = Date.now(), span = observer.#span("model_request", { request_kind: request.purpose ?? "main" }); let first = false;
      observer.#record("api_request", {}); observer.#log("api_request", {});
      try {
        for await (const event of provider.stream(request, signal)) {
          if (!first) { first = true; observer.#duration("api.first_token", Date.now() - start); }
          if (event.type === "message_complete" && event.usageReported !== false) for (const [kind, n] of Object.entries(event.usage)) observer.#count("token.usage", { type: kind }, n);
          yield event;
        }
      } catch (e) {
        if (!signal.aborted) {
          const known = e instanceof ProviderError;
          observer.#diagnostic(known && e.kind === "connection" ? "connection_error" : "api_error", known ? e.kind : "unexpected");
          observer.#record("api_error", { result: "error" }); observer.#log("api_error", { result: "error" });
          if (known) observer.#o.onLoggedError?.(observer.#safeContent(e.stack ?? e.message));
          if (!known) observer.reportUnexpected(e);
          if (span) span.status = { code: 2, message: "error" };
        }
        throw e;
      } finally { if (span) span.endTimeUnixNano = nano(); observer.#duration("api.duration", Date.now() - start); }
    } };
  }
  event(event: EngineEvent): void {
    const ctx = this.#context.getStore();
    if (event.type === "tool_call") {
      const name = toolName(event.name), span = this.#span("tool", { tool: name });
      if (buildFlag("telemetry_enhanced") && span && this.#o.enhanced) {
        const input = JSON.stringify(event.input) ?? "";
        span.attributes.push(...attributes({ "tool.input.bytes": Buffer.byteLength(input) }));
        if (this.#o.includeToolContent) span.attributes.push(...attributes({ "tool.input.content": this.#safeContent(input) }));
      }
      ctx?.calls.set(event.callId, { span, name, start: Date.now() });
    } else if (event.type === "tool_started") {
      const call = ctx?.calls.get(event.callId); if (call?.span) call.span.attributes.push(...attributes({ permission_wait_ms: Math.max(0, Date.now() - call.start) }));
    } else if (event.type === "tool_result") {
      const call = ctx?.calls.get(event.callId), name = call?.name ?? "other", result = event.isError ? "error" : "ok";
      if (buildFlag("telemetry_enhanced") && call?.span && this.#o.enhanced) {
        call.span.attributes.push(...attributes({ "tool.output.bytes": Buffer.byteLength(event.output) }));
        if (this.#o.includeToolContent) call.span.attributes.push(...attributes({ "tool.output.content": this.#safeContent(event.output) }));
      }
      if (call?.span) { call.span.endTimeUnixNano = nano(); call.span.status = { code: event.isError ? 2 : 0 }; } ctx?.calls.delete(event.callId);
      this.#count("tool.usage", { tool: name, result }, 1); this.#duration("tool.duration", event.durationMs);
      const data = { tool: name, result, duration_ms: event.durationMs }; this.#record("tool_result", data); this.#log("tool_result", data);
    } else if (event.type === "permission") {
      const data = { decision: event.decision }; this.#record("permission", data); this.#log("permission", data); this.#count("permission.usage", data, 1);
    } else if (event.type === "usage" && event.cost !== undefined) this.#count("cost.usage", {}, event.cost);
  }
  hook(durationMs: number): void {
    const span = this.#span("hook"); if (span) { span.startTimeUnixNano = String(BigInt(Date.now() - Math.round(durationMs)) * 1_000_000n); span.endTimeUnixNano = nano(); }
    this.#duration("hook.duration", durationMs);
  }
  reportUnexpected(error: unknown): void {
    this.#o.onLoggedError?.(this.#safeContent(error instanceof Error ? error.stack ?? error.message : String(error)));
    this.#diagnostic("unexpected_error");
    if (!this.#o.errorEnabled() || !exportUrl(this.#o.errorUrl)) return;
    const type = error instanceof TypeError ? "TypeError" : error instanceof RangeError ? "RangeError" : error instanceof SyntaxError ? "SyntaxError" : "Error";
    const frames = (error instanceof Error ? error.stack ?? "" : "").split("\n").slice(1, 21).map(line => ({ filename: "[redacted]", function: ["runTurn", "run", "runOnce", "stream", "execute", "processRequest"].find(name => new RegExp(`(?:at |^|\\s)${name}(?: |\\()`).test(line)) ?? "frame", lineno: Math.min(1_000_000, Number(/:(\d+):\d+\)?$/.exec(line)?.[1] ?? 0)) })).reverse();
    const signature = createHash("sha256").update(JSON.stringify({ type, frames })).digest("hex");
    if (this.#deduplicated.has(signature) || this.#deduplicated.size >= 32) return;
    this.#deduplicated.add(signature);
    const id = randomBytes(16).toString("hex"), event = JSON.stringify({ event_id: id, timestamp: Date.now() / 1000, platform: "javascript", level: "error", release: this.#o.version, fingerprint: [signature], exception: { values: [{ type, value: "Unexpected product error", stacktrace: { frames } }] } });
    const body = JSON.stringify({ event_id: id, sent_at: new Date().toISOString() }) + "\n" + JSON.stringify({ type: "event", length: Buffer.byteLength(event), content_type: "application/json" }) + "\n" + event + "\n";
    // Fire-and-forget uses the same bounded connection scope as every other exporter.
    const sending = this.#post(this.#o.errorUrl!, body, "application/x-sentry-envelope", () => this.#o.errorEnabled(), undefined, this.#productAbort.signal);
    this.#reports.add(sending); void sending.finally(() => this.#reports.delete(sending));
  }
  readonly #reports = new Set<Promise<boolean>>();
  #sessionId(): string { try { return this.#o.sessionId(); } catch { return this.#instance; } }
  #safeContent(content: string): string { let safe = maskSecrets(content); for (const secret of this.#o.secrets.filter(Boolean)) safe = safe.split(secret).join("[redacted]"); return safe.slice(0, 4096); }
  render(summary: { frames: number; durationMs: number; slowFrames: number; buckets: readonly number[] }): void {
    this.#count("render.frames", {}, summary.frames); this.#count("render.slow_frames", {}, summary.slowFrames);
    this.#renderSummary = { ...summary, buckets: [...summary.buckets] };
    this.#log("render_summary", { frames: summary.frames, duration_ms: summary.durationMs, slow_frames: summary.slowFrames });
  }
  #resource(): { attributes: OtlpAttribute[] } {
    return { attributes: attributes({ "service.name": this.#o.slug, "service.version": this.#o.version, "entrypoint": this.#o.entrypoint, ...this.#o.commonTraceAttributes, ...(this.#o.experimentBaseline ? { "experiment.baseline": true } : {}), ...(this.#o.includeSessionId ? { "session.id": this.#sessionId() } : {}) }) };
  }
  #metricData(): Array<Record<string, unknown>> {
    const groups = new Map<string, Array<Record<string, unknown>>>(), time = nano();
    for (const m of this.#metrics.values()) { const list = groups.get(m.name) ?? []; list.push({ attributes: attributes(m.attributes), startTimeUnixNano: this.#started, timeUnixNano: time, ...(Number.isSafeInteger(m.value) ? { asInt: String(m.value) } : { asDouble: m.value }) }); groups.set(m.name, list); }
    const result: Array<Record<string, unknown>> = [...groups].map(([name, dataPoints]) => ({ name: this.#o.slug + "." + name, sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints } }));
    if (this.#renderSummary) result.push({ name: this.#o.slug + ".render.duration", unit: "ms", histogram: { aggregationTemporality: 2, dataPoints: [{ startTimeUnixNano: this.#started, timeUnixNano: time, count: String(this.#renderSummary.frames), sum: this.#renderSummary.durationMs, explicitBounds: [1, 5, 10, 20, 50, 100, 500], bucketCounts: this.#renderSummary.buckets.map(String) }] } });
    const bounds = [5, 20, 100, 500, 2000, 10000];
    for (const d of this.#durations.values()) {
      const buckets = Array.from({ length: bounds.length + 1 }, () => 0); for (const value of d.values) buckets[bounds.findIndex(b => value <= b) === -1 ? bounds.length : bounds.findIndex(b => value <= b)]!++;
      result.push({ name: this.#o.slug + "." + d.name, unit: "ms", histogram: { aggregationTemporality: 2, dataPoints: [{ startTimeUnixNano: this.#started, timeUnixNano: time, count: String(d.values.length), sum: d.values.reduce((a, b) => a + b, 0), explicitBounds: bounds, bucketCounts: buckets.map(String) }] } });
    }
    return result;
  }
  async #post(url: string, body: string, type: string, enabled: () => boolean, headers?: Record<string, string>, scope?: AbortSignal): Promise<boolean> {
    if (!enabled() || this.#abort.signal.aborted) return false;
    const signal = AbortSignal.any([this.#abort.signal, AbortSignal.timeout(1500), ...(scope ? [scope] : [])]);
    let onAbort: () => void = () => {};
    try {
      const aborted = new Promise<never>((_, reject) => { onAbort = () => reject(new Error("Exporter cancelled")); if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true }); });
      const r = await Promise.race([this.#o.fetch(url, { method: "POST", headers: { ...headers, "content-type": type }, body, redirect: "error", signal }), aborted]);
      void r.body?.cancel().catch(() => undefined); return r.ok;
    } catch { return false; }
    finally { signal.removeEventListener("abort", onAbort); }
  }
  async #export(signal: "metrics" | "logs" | "traces", body: unknown): Promise<boolean> {
    if (!this.#o.otelEnabled()) return true;
    const env = this.#o.environment, upper = signal.toUpperCase(), exporter = env(`OTEL_${upper}_EXPORTER`) ?? (signal === "traces" ? "none" : "otlp");
    if (exporter === "none") return true;
    if (exporter === "console") { this.#o.console(JSON.stringify({ signal, data: body })); return true; }
    if (exporter !== "otlp") { this.#o.warn("Exportateur de télémétrie non reconnu ; signal ignoré."); return true; }
    const protocol = env(`OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`) ?? env("OTEL_EXPORTER_OTLP_PROTOCOL") ?? "http/json";
    if (protocol !== "http/json") { this.#o.warn("Protocole de télémétrie non pris en charge : utilisez http/json."); return true; }
    const specific = env(`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`), base = env("OTEL_EXPORTER_OTLP_ENDPOINT");
    const url = exportUrl(specific ?? (base ? base.replace(/\/$/, "") + "/v1/" + signal : undefined), true);
    if (!url) return false;
    const headers: Record<string, string> = {};
    try { for (const pair of (env(`OTEL_EXPORTER_OTLP_${upper}_HEADERS`) ?? env("OTEL_EXPORTER_OTLP_HEADERS") ?? "").split(",").filter(Boolean)) { const at = pair.indexOf("="), key = pair.slice(0, at).trim(), value = decodeURIComponent(pair.slice(at + 1).trim()); if (at <= 0 || !/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || /[\r\n\u0000]/.test(value)) return false; headers[key] = value; } } catch { return false; }
    return this.#post(url, JSON.stringify(body), "application/json", this.#o.otelEnabled, headers);
  }
  async flush(): Promise<void> {
    if (this.#flushing) return this.#flushing;
    this.#flushing = this.#flush().finally(() => { this.#flushing = undefined; }); return this.#flushing;
  }
  async #flush(): Promise<void> {
    if (!this.#o.productEnabled()) this.#products = [];
    if (this.#products.length && exportUrl(this.#o.productUrl)) {
      const pending = this.#products.splice(0), events = pending.map(e => ({ name: this.#o.eventPrefix + e.name, attributes: e.attributes, metadata: { version: this.#o.version, os: this.#o.platform, mode: this.#o.entrypoint, session: this.#sessionId(), device: this.#device } }));
      if (!await this.#post(this.#o.productUrl!, JSON.stringify({ events }), "application/json", this.#o.productEnabled, undefined, this.#productAbort.signal)) this.#products = this.#o.productEnabled() ? [...pending, ...this.#products].slice(0, 256) : [];
      else { for (const file of this.#previousFiles) if (ordinaryFile(file, 65536)) { try { unlinkSync(file); } catch {} } this.#previousFiles = []; }
    }
    if (!this.#o.otelEnabled()) { this.#logs = []; this.#spans = []; return; }
    const resource = this.#resource(), scope = { name: this.#o.slug, version: this.#o.version }, logs = this.#logs.splice(0), spans = this.#spans.splice(0);
    const results = await Promise.allSettled([
      this.#export("metrics", { resourceMetrics: [{ resource, scopeMetrics: [{ scope, metrics: this.#metricData() }] }] }),
      logs.length ? this.#export("logs", { resourceLogs: [{ resource, scopeLogs: [{ scope, logRecords: logs }] }] }) : Promise.resolve(true),
      spans.length ? this.#export("traces", { resourceSpans: [{ resource, scopeSpans: [{ scope, spans }] }] }) : Promise.resolve(true),
    ]);
    for (const result of results) if (result.status === "rejected" || !result.value) this.#o.warn("Export de télémétrie indisponible ; données bornées conservées jusqu'à l'arrêt.");
    if (results[1]?.status === "fulfilled" && !results[1].value) this.#logs = [...logs, ...this.#logs].slice(0, 512);
    if (results[2]?.status === "fulfilled" && !results[2].value) this.#spans = [...spans, ...this.#spans].slice(0, 2000);
  }
  #loadPending(): void {
    const dir = join(this.#o.configDir, "telemetry");
    try {
      ordinaryDirectory(dir);
      for (const name of readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).slice(0, 16)) {
        const file = join(dir, name); if (!ordinaryFile(file, 65536)) continue;
        const saved: unknown = JSON.parse(readFileSync(file, "utf8")); if (!Array.isArray(saved)) continue;
        for (const item of saved) { if (!item || typeof item !== "object" || !EVENTS.includes(item.name) || !item.attributes || typeof item.attributes !== "object") continue; if (this.#products.length < 256) this.#products.push({ name: item.name, attributes: productAttributes(item.attributes) }); }
        this.#previousFiles.push(file);
      }
    } catch { this.#o.warn("File de télémétrie indisponible."); }
  }
  #persist(): void {
    if (!this.#o.persist) return;
    try {
      const dir = join(this.#o.configDir, "diagnostics"); ordinaryDirectory(dir);
      // UUID-only owned names; never follow or remove foreign files. Fixed per-session bound (512 records).
      let total = 0;
      const files = readdirSync(dir).filter(n => /^[a-f0-9-]{36}\.jsonl$/.test(n)).map(name => join(dir, name)).filter(f => ordinaryFile(f, 131072)).map(file => ({ file, stat: lstatSync(file) })).sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      for (const f of files) { total += f.stat.size; if (Date.now() - f.stat.mtimeMs > this.#o.diagnosticRetentionDays * 86400_000 || total > 2 * 1024 * 1024) unlinkSync(f.file); }
      writeAtomic(join(dir, this.#instance + ".jsonl"), Buffer.from(this.#diagnostics.map(d => JSON.stringify(d)).join("\n") + "\n"), currentPlatform(), true);
      if (this.#closed && this.#o.productEnabled() && this.#products.length) {
        const pendingDir = join(this.#o.configDir, "telemetry"); ordinaryDirectory(pendingDir);
        const existing = readdirSync(pendingDir).filter(n => /^[a-f0-9-]{36}\.json$/.test(n)).map(n => join(pendingDir, n)).filter(f => ordinaryFile(f, 65536)).sort((a, b) => lstatSync(a).mtimeMs - lstatSync(b).mtimeMs);
        while (existing.length >= 16) unlinkSync(existing.shift()!);
        writeAtomic(join(pendingDir, this.#instance + ".json"), Buffer.from(JSON.stringify(this.#products)), currentPlatform(), true);
      }
    } catch { this.#o.warn("Journal de diagnostic indisponible."); }
  }
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; clearInterval(this.#timer);
    this.#record("session_ended", {}); this.#diagnostic("session_ended");
    const timeout = setTimeout(() => this.#abort.abort(), 2200);
    try { await this.flush(); await Promise.allSettled([...this.#reports]); }
    finally { clearTimeout(timeout); this.#abort.abort(); this.#persist(); }
  }
}
