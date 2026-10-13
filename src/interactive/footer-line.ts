// Implements: SPEC-IHM-021 (coalesced non-blocking commands, bounded output, last good value).
// Supports: SPEC-SES-001 (revocable transcript reference supplied by the composition), E-159.
import type { CommandRun } from "../hooks/command";
import { sanitize, type Span } from "../ui/text";
import type { Style } from "../ui/style";

/** Only SGR colours and emphasis are interpreted; all other terminal controls become visible text. */
export function footerSpans(value: string): Span[] {
  const spans: Span[] = []; let style: Style = {}, at = 0;
  for (const match of value.matchAll(/\u001b\[([0-9;]*)m/g)) {
    if (match.index! > at) spans.push({ text: sanitize(value.slice(at, match.index)), style: { ...style } });
    const codes = match[1] ? match[1].split(";").map(Number) : [0];
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) style = {};
      else if (code === 1) style = { ...style, bold: true };
      else if (code === 2) style = { ...style, dim: true };
      else if (code === 22) style = { ...style, bold: false, dim: false };
      else if (code >= 30 && code <= 37 || code >= 90 && code <= 97) style = { ...style, fg: { ansi: code >= 90 ? code - 90 + 8 : code - 30 } };
      else if (code === 39) { const { fg: _fg, ...other } = style; style = other; }
      else if (code === 38 && codes[i + 1] === 5 && codes[i + 2] !== undefined) { style = { ...style, fg: { ansi: Math.min(255, codes[i + 2]!) } }; i += 2; }
      else if (code === 38 && codes[i + 1] === 2 && codes.length > i + 4) { style = { ...style, fg: { rgb: codes.slice(i + 2, i + 5).map(value => Math.min(255, value)) as [number, number, number] } }; i += 4; }
    }
    at = match.index! + match[0].length;
  }
  if (at < value.length) spans.push({ text: sanitize(value.slice(at)), style }); return spans;
}

export class FooterLine {
  #pending: Readonly<Record<string, unknown>> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #active: Promise<void> | undefined;
  #controller: AbortController | undefined;
  #lastAt = -Infinity;
  #closed = false;
  #warned = false;
  value: readonly Span[] | undefined;
  constructor(private readonly options: { run: (data: Readonly<Record<string, unknown>>, signal: AbortSignal) => Promise<CommandRun>; redact: (text: string) => string; changed: () => void; warn: (text: string) => void }) {}
  update(data: Readonly<Record<string, unknown>>): void { if (this.#closed) return; this.#pending = data; this.#schedule(); }
  #schedule(): void {
    if (this.#closed || this.#active || this.#timer || !this.#pending) return;
    const delay = Math.max(0, 300 - (Date.now() - this.#lastAt));
    this.#timer = setTimeout(() => { this.#timer = undefined; this.#active = this.#run().finally(() => { this.#active = undefined; this.#schedule(); }); }, delay);
  }
  async #run(): Promise<void> {
    const data = this.#pending!; this.#pending = undefined; this.#lastAt = Date.now(); this.#controller = new AbortController();
    try {
      const result = await this.options.run(data, this.#controller.signal);
      if (this.#closed) return;
      if (result.timedOut || result.exitCode !== 0) throw new Error(result.timedOut ? "délai dépassé" : `commande en échec${result.stderr.trim() ? ` (${this.options.redact(result.stderr.trim()).slice(0, 200)})` : ""}`);
      this.value = footerSpans(this.options.redact(result.stdout.split(/\r?\n/)[0]!.slice(0, 4096))); this.#warned = false; this.options.changed();
    } catch (error) { if (!this.#closed && !this.#warned) { this.#warned = true; this.options.warn(`Ligne d’état : ${this.options.redact((error as Error).message)}. Dernier affichage conservé.`); } }
    finally { this.#controller = undefined; }
  }
  async close(): Promise<void> { this.#closed = true; if (this.#timer) clearTimeout(this.#timer); this.#timer = undefined; this.#controller?.abort(); await this.#active; }
}
