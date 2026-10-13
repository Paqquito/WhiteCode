// Implements: SPEC-OBS-008 (CA-01, EF-01, FA-01/02, RG-01), SPEC-OBS-009 (CA-01, EF-02), SPEC-OBS-013 (CA-01, EF-01, RG-01), gap E-150.
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { restrictFileToOwner } from "../platform/private-file";

export type PerformancePhase = "startup" | "query" | "headless";
export interface PerformanceSample { readonly name: string; readonly phase: PerformancePhase; readonly startMs: number; readonly durationMs: number; readonly rssBytes: number; readonly heapUsedBytes: number; readonly sizeBytes?: number }
export interface PerformanceOptions {
  readonly directory: string;
  readonly trace?: string;
  readonly profile?: string;
  readonly slowMs?: number;
  readonly now?: () => number;
  readonly originMs?: number;
  readonly warn: (message: string) => void;
  readonly log: (name: string, durationMs: number, sizeBytes: number) => void;
  readonly maxEvents?: number;
}

/** An exclusively created, owner-only file; later writes use its original descriptor, never a substituted path. */
class PerformanceFile {
  #fd: number | undefined;
  readonly #identity: { ino: number; dev: number };
  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    this.#identity = fstatSync(this.#fd);
    try { restrictFileToOwner(path); } catch (error) { this.close(); throw error; }
  }
  write(value: unknown): void {
    if (this.#fd === undefined) return;
    const file = lstatSync(this.path);
    if (!file.isFile() || file.nlink !== 1 || file.ino !== this.#identity.ino || file.dev !== this.#identity.dev) throw new Error("Diagnostic file changed.");
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    for (let offset = 0; offset < bytes.length;) offset += writeSync(this.#fd, bytes, offset, bytes.length - offset, offset);
    ftruncateSync(this.#fd, bytes.length);
  }
  close(): void { if (this.#fd !== undefined) closeSync(this.#fd); this.#fd = undefined; }
}

export class PerformanceRecorder {
  readonly #o: PerformanceOptions;
  readonly #now: () => number;
  readonly #start: number;
  readonly #phases: Set<string>;
  readonly #samples: PerformanceSample[] = [];
  readonly #recent: Array<{ name: string; durationMs: number; sizeBytes: number; expiresMs: number }> = [];
  readonly #files = new Map<"trace" | "profile", PerformanceFile>();
  readonly #timer: ReturnType<typeof setInterval> | undefined;
  #rotation = 0;
  #track = 1;
  readonly #traceEvents: Array<Record<string, unknown>> = [];
  constructor(options: PerformanceOptions) {
    this.#o = options; this.#now = options.now ?? (() => performance.now()); this.#start = options.originMs ?? this.#now();
    this.#phases = new Set((options.profile ?? "").split(","));
    if ([...this.#phases].some(phase => phase !== "" && !["startup", "query", "headless", "all"].includes(phase))) { this.#phases.clear(); options.warn("Profil de performance invalide : startup, query, headless ou all attendus."); }
    if (options.trace) this.#open("trace", options.trace === "1" ? join(options.directory, "performance-trace.json") : options.trace);
    if (this.#phases.size && !this.#phases.has("")) this.#open("profile", join(options.directory, "performance-profile.json"));
    if (this.#files.size) { this.#timer = setInterval(() => this.flush(), 500); this.#timer.unref?.(); }
  }
  #open(kind: "trace" | "profile", path: string): void {
    try { this.#files.set(kind, new PerformanceFile(path)); }
    catch { this.#o.warn(`Diagnostic de performance inaccessible, désactivé : ${path}.`); }
  }
  get recent(): readonly { name: string; durationMs: number; sizeBytes: number }[] { const now = this.#now(); return this.#recent.filter(sample => sample.expiresMs > now).map(({ expiresMs, ...sample }) => sample); }
  get paths(): readonly string[] { return [...this.#files.values()].map(file => file.path); }
  start(name: string, phase: PerformancePhase, sizeBytes = 0): (measuredSize?: number) => void {
    const started = this.#now(); let ended = false;
    return measuredSize => { if (ended) return; ended = true; const memory = process.memoryUsage(); this.record({ name, phase, startMs: started - this.#start, durationMs: Math.max(0, this.#now() - started), rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, sizeBytes: measuredSize ?? sizeBytes }); };
  }
  record(sample: PerformanceSample): void {
    // Only fixed instrumentation names and numeric measurements enter these files.
    if (!/^[a-z][a-z0-9_.-]*$/.test(sample.name) || !["startup", "query", "headless"].includes(sample.phase) || ![sample.startMs, sample.durationMs, sample.rssBytes, sample.heapUsedBytes, sample.sizeBytes ?? 0].every(value => Number.isFinite(value) && value >= 0)) return;
    const limit = this.#o.maxEvents ?? 4096;
    if (this.#files.has("trace")) {
      if (this.#traceEvents.length >= limit) { this.flush(); const previous = this.#files.get("trace")!; previous.close(); this.#files.delete("trace"); this.#open("trace", `${this.#o.trace === "1" ? join(this.#o.directory, "performance-trace.json") : this.#o.trace}.${++this.#rotation}.json`); this.#traceEvents.length = 0; }
      this.#traceEvents.push({ name: sample.name, cat: sample.phase, ph: "X", ts: Math.round(sample.startMs * 1000), dur: Math.max(1, Math.round(sample.durationMs * 1000)), pid: process.pid, tid: this.#track++, args: { sizeBytes: sample.sizeBytes ?? 0, rssBytes: sample.rssBytes, heapUsedBytes: sample.heapUsedBytes } });
    }
    if (this.#files.has("profile") && (this.#phases.has("all") || this.#phases.has(sample.phase))) { this.#samples.push({ name: sample.name, phase: sample.phase, startMs: sample.startMs, durationMs: sample.durationMs, rssBytes: sample.rssBytes, heapUsedBytes: sample.heapUsedBytes, sizeBytes: sample.sizeBytes }); if (this.#samples.length > limit) this.#samples.shift(); }
    if (this.#o.slowMs !== undefined && sample.durationMs > this.#o.slowMs) {
      this.#o.log(sample.name, sample.durationMs, sample.sizeBytes ?? 0);
      this.#recent.push({ name: sample.name, durationMs: sample.durationMs, sizeBytes: sample.sizeBytes ?? 0, expiresMs: this.#now() + 5000 }); if (this.#recent.length > 5) this.#recent.shift();
    }
  }
  flush(): void {
    for (const [kind, file] of this.#files) {
      try { file.write(kind === "trace" ? { traceEvents: this.#traceEvents, displayTimeUnit: "ms" } : { version: 1, samples: this.#samples }); }
      catch { file.close(); this.#files.delete(kind); this.#o.warn(`Écriture du diagnostic impossible, désactivé : ${file.path}.`); }
    }
  }
  close(): void { clearInterval(this.#timer); this.flush(); for (const file of this.#files.values()) file.close(); }
}
