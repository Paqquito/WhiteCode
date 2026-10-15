// Implements: SPEC-MOT-032 (read-triggered tracking, bounded background updates and conflict refusal).
// Supports: SPEC-SES-006, gap E-174.
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { readPrivateText } from "../shared/private-text";
import { containsSecret } from "../shared/secrets";
import { MemoryJobs } from "../memory/jobs";
import { textOutcome, type Tool } from "../tools/types";
const fingerprint = (text: string) => createHash("sha256").update(text).digest("hex");
interface Document { readonly path: string; readonly hash: string; readonly header: string; readonly title: string }
interface Options {
  readonly signal: AbortSignal;
  readonly enabled: () => boolean;
  readonly header: () => string;
  readonly everyTurns: number;
  readonly denied: (path: string) => boolean;
  readonly redact: (text: string) => string;
  readonly update: (document: Document, signal: AbortSignal, wrap: (tool: Tool<never>) => Tool<never>) => Promise<void>;
  readonly notify: (path: string, title: string) => void;
  readonly report: (error: unknown) => void;
}
export class LivingDocuments {
  readonly #documents = new Map<string, Document>();
  readonly #jobs: MemoryJobs;
  #turns = 0;
  constructor(readonly options: Options) { this.#jobs = new MemoryJobs({ signal: options.signal, report: (_purpose, error) => options.report(error) }); }
  read(path: string): void {
    if (!this.options.enabled() || this.options.denied(path) || this.#documents.size >= 16 && !this.#documents.has(resolve(path))) return;
    try { const text = readPrivateText(path, 128000), header = text.split(/\r?\n/, 1)[0]!, prefix = this.options.header(); if (!prefix || !header.startsWith(prefix + " ") || containsSecret(text) || this.options.redact(text) !== text) return;
      this.#documents.set(resolve(path), { path: resolve(path), hash: fingerprint(text), header, title: header.slice(prefix.length).trim() });
    } catch { /* A special or oversized document is not followed. */ }
  }
  turn(): void {
    if (!this.options.enabled() || ++this.#turns % this.options.everyTurns !== 0) return;
    for (const document of this.#documents.values()) this.#jobs.launch(document.path, async signal => {
      const unchanged = () => { if (!this.options.enabled() || this.options.denied(document.path)) return false; try { return fingerprint(readPrivateText(document.path, 128000)) === document.hash; } catch { return false; } };
      if (!unchanged()) return;
      const wrap = (tool: Tool<never>): Tool<never> => ({ ...tool, execute: async (input, context) => {
        const proposed = (input as { content?: unknown }).content;
        if (!unchanged() || typeof proposed !== "string" || Buffer.byteLength(proposed) > 128000 || proposed.split(/\r?\n/, 1)[0] !== document.header || containsSecret(proposed) || this.options.redact(proposed) !== proposed) return textOutcome("Living document update abandoned: the source changed, its header was removed, or the proposed content is unsafe.", true, "invalid_input");
        const result = await tool.execute(input, context);
        if (!result.isError) { this.read(document.path); this.options.notify(document.path, document.title); }
        return result;
      } });
      await this.options.update(document, signal, wrap);
    });
  }
  abort(): void { this.#jobs.abort(); }
  close(waitMs = 0): Promise<void> { return this.#jobs.close(waitMs); }
}
