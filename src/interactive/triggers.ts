// Implements: SPEC-IHM-007 (FA-06 doubled trigger characters, RG-02, CA-08, CA-11, CA-12), SPEC-IHM-012 (EF-10, CA-09)
// The four trigger characters (`/` and `!` at the start, `@` and `&` at the start or after a blank) give their literal
// character when doubled and immediately followed by a non-blank character. A pair followed by a blank or by the end is
// left unchanged; nothing changes inside a code block. The transformation is shown before sending (RG-02).

export interface TriggerTransform {
  readonly text: string;
  readonly changed: boolean;
}

/** Spans of code (fenced blocks and inline code), where no transformation applies. */
function codeSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const fence = /```[\s\S]*?(```|$)|`[^`\n]*`/g;
  for (const m of text.matchAll(fence)) spans.push([m.index!, m.index! + m[0].length]);
  return spans;
}

export function literalTriggers(text: string): TriggerTransform {
  const code = codeSpans(text);
  const inCode = (i: number) => code.some(([a, b]) => i >= a && i < b);
  let out = "";
  let changed = false;
  const lead = /^\s*/.exec(text)![0].length;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const doubled = text[i + 1] === c && i + 2 < text.length && !/\s/.test(text[i + 2]!);
    const atStart = i === lead;
    const afterBlank = i === 0 || /\s/.test(text[i - 1]!);
    // `//` at the start is handled by the command engine (SPEC-CMD-001 § 5.1); `!!`, `@@` and `&&` here.
    const trigger = (c === "!" && atStart) || ((c === "@" || c === "&") && afterBlank);
    if (trigger && doubled && !inCode(i)) {
      out += c;
      i++;
      changed = true;
      continue;
    }
    out += c;
  }
  return { text: out, changed };
}
