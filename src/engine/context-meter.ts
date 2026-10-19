// Implements: SPEC-MOT-010 (§ 5.1 to 5.4, FA-01, EF-01 to EF-05, ERR-01, RG-01, RG-02, CA-01, CA-02, CA-04)
// Supports: SPEC-MOT-012 and SPEC-MOT-013 (occupation used by the thresholds), gap E-062 (coefficients by family)

import type { ResolvedModel } from "../providers/catalog";
import type { ContentPart, HistoryMessage, SystemBlock, ToolDefinition, ToolResultPart, Usage } from "../providers/types";
import { imageInfo } from "../tools/image-header";

export interface EstimationCoefficients {
  /** Characters per token for prose. */
  readonly text: number;
  /** Characters per token for source code. */
  readonly code: number;
  /** Characters per token for JSON (tool inputs, schemas). */
  readonly json: number;
  /** Pixels per token for images: the cost grows with the surface. */
  readonly pixelsPerToken: number;
}

/** Defaults (§ 6): about four characters per token for text; code and JSON count denser, to overestimate (RG-01). */
export const DEFAULT_COEFFICIENTS: EstimationCoefficients = { text: 4, code: 3.2, json: 2.8, pixelsPerToken: 750 };

export type Category = "system" | "tools" | "messages" | "attachments";

export interface Occupation {
  /** Estimated tokens of the context sent with the next request. */
  readonly tokens: number;
  /** Effective window: context window minus the output reserve (EF-03). */
  readonly effectiveWindow: number;
  /** Share of the effective window, bounded to [0, 1] (RG-02). */
  readonly ratio: number;
  /** True when a count of the provider is the reference (EF-01), false for a local estimate of everything (FA-01). */
  readonly fromProvider: boolean;
}

const looksLikeCode = (text: string) => {
  const sample = text.slice(0, 4000);
  const symbols = sample.match(/[{};=()<>[\]]/g)?.length ?? 0;
  return sample.length > 0 && symbols / sample.length > 0.04;
};

/** Local estimate of one part, by category (EF-02). */
export function estimatePart(part: ContentPart | ToolResultPart, c: EstimationCoefficients): { tokens: number; category: Category } {
  if (part.type === "text") return { tokens: Math.ceil(part.text.length / (looksLikeCode(part.text) ? c.code : c.text)), category: "messages" };
  if (part.type === "image") {
    const info = imageInfo(Buffer.from(part.dataBase64.slice(0, 64 * 1024), "base64"));
    const pixels = info ? info.width * info.height : 1_000_000;
    return { tokens: Math.ceil(pixels / c.pixelsPerToken), category: "attachments" };
  }
  if (part.type === "document") return { tokens: Math.ceil(part.dataBase64.length * 0.75 / c.text), category: "attachments" };
  let tokens = 8; // framing of a tool result
  let images = 0;
  for (const inner of part.content) {
    const e = estimatePart(inner, c);
    if (e.category === "attachments") images += e.tokens;
    else tokens += e.tokens;
  }
  return images > 0 && tokens <= 8 ? { tokens: tokens + images, category: "attachments" } : { tokens: tokens + images, category: "messages" };
}

export function estimateMessage(m: HistoryMessage, c: EstimationCoefficients): Record<Category, number> {
  const out: Record<Category, number> = { system: 0, tools: 0, messages: 0, attachments: 0 };
  if (m.role === "system_note") {
    out.messages += Math.ceil(m.text.length / c.text) + 4;
    return out;
  }
  if (m.role === "assistant") {
    out.messages += Math.ceil(JSON.stringify(m.native.content ?? m.text).length / c.json);
    return out;
  }
  for (const p of m.parts) {
    const e = estimatePart(p, c);
    out[e.category] += e.tokens;
  }
  return out;
}

export interface MeterOptions {
  readonly model: ResolvedModel;
  readonly outputReserveTokens: number;
  readonly coefficients?: Partial<EstimationCoefficients>;
  readonly warn?: (message: string) => void;
}

/** Occupation of the context of one agent (SPEC-MOT-010). */
export class ContextMeter {
  readonly coefficients: EstimationCoefficients;
  effectiveWindow: number;
  #model: ResolvedModel;
  /** Provider count of the whole context after the last response, and the number of messages it covered. */
  #baseline: { tokens: number; messages: number; segment: number } | undefined;
  /** Tokens by model and category, for the consumption follow-up (EF-05). */
  readonly consumption = new Map<string, { input: number; output: number; cacheRead: number; cacheWrite: number }>();

  constructor(readonly options: MeterOptions) {
    this.coefficients = { ...DEFAULT_COEFFICIENTS, ...options.coefficients };
    this.#model = options.model;
    this.effectiveWindow = ContextMeter.windowOf(options.model, options.outputReserveTokens);
    // ERR-01, CA-04: a model absent from every catalogue gets the prudent window, with a warning.
    if (options.model.source === "none") options.warn?.(`Taille de contexte du modèle ${options.model.id} inconnue : ${options.model.contextWindow} jetons supposés.`);
  }

  /** The reserve never takes more than half of the window. */
  static windowOf(model: ResolvedModel, reserve: number): number {
    const window = model.contextWindow;
    return Math.max(1, window - Math.min(reserve, Math.floor(window / 2)));
  }

  /** The model changed during the session (SPEC-CMD-045 § 5.3 step 2): its window becomes the reference. */
  setModel(model: ResolvedModel): void {
    this.#model = model;
    this.effectiveWindow = ContextMeter.windowOf(model, this.options.outputReserveTokens);
  }

  /** § 5.3 point 1: after each response, the provider counts become the reference (EF-01, CA-01). */
  recordResponse(usage: Usage, reported: boolean, historyLength: number, segment: number): void {
    const key = this.#model.id;
    const c = this.consumption.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    this.consumption.set(key, { input: c.input + usage.inputTokens, output: c.output + usage.outputTokens, cacheRead: c.cacheRead + usage.cacheReadTokens, cacheWrite: c.cacheWrite + usage.cacheWriteTokens });
    if (!reported) return;
    // The answer itself becomes part of the context: input of the request plus the output.
    const tokens = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens;
    this.#baseline = { tokens, messages: historyLength, segment };
  }

  /** After a rewrite of the history (compaction, micro-compaction), the provider count no longer applies. */
  invalidate(): void {
    this.#baseline = undefined;
  }

  /** Local estimate of the whole request, by category (EF-04). */
  breakdown(system: readonly SystemBlock[], tools: readonly ToolDefinition[], messages: readonly HistoryMessage[]): Record<Category, number> {
    const c = this.coefficients;
    const out: Record<Category, number> = { system: 0, tools: 0, messages: 0, attachments: 0 };
    for (const b of system) out.system += Math.ceil(b.text.length / c.text);
    for (const t of tools) out.tools += Math.ceil(JSON.stringify({ n: t.name, d: t.description, s: t.inputSchema }).length / c.json);
    for (const m of messages) {
      const e = estimateMessage(m, c);
      for (const k of Object.keys(e) as Category[]) out[k] += e[k];
    }
    return out;
  }

  /** § 5.1: last provider count + estimate of what was added since; otherwise a local estimate of everything (FA-01). */
  occupation(system: readonly SystemBlock[], tools: readonly ToolDefinition[], messages: readonly HistoryMessage[], segment: number): Occupation {
    const b = this.#baseline;
    let tokens: number;
    let fromProvider = false;
    if (b && b.segment === segment && b.messages <= messages.length) {
      const added = messages.slice(b.messages).reduce((n, m) => {
        const e = estimateMessage(m, this.coefficients);
        return n + e.messages + e.attachments + e.system + e.tools;
      }, 0);
      tokens = b.tokens + added;
      fromProvider = true;
    } else {
      const all = this.breakdown(system, tools, messages);
      tokens = all.system + all.tools + all.messages + all.attachments;
    }
    return { tokens, effectiveWindow: this.effectiveWindow, ratio: Math.min(1, Math.max(0, tokens / this.effectiveWindow)), fromProvider };
  }
}
