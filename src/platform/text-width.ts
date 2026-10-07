// Supports: SPEC-IHM-001 (§ 5.3 display width of a character, EF-04)
// Runtime adapter: display width of one grapheme. The runtime function handles the standard width tables (double
// width, zero width, composed sequences); a portable fallback covers the main ranges.

/** Width in columns of a grapheme already free of control characters: 0, 1 or 2. */
export function graphemeWidth(grapheme: string): number {
  if (typeof Bun !== "undefined") return Math.min(2, Bun.stringWidth(grapheme, { ambiguousIsNarrow: true }));
  return fallbackWidth(grapheme);
}

function fallbackWidth(grapheme: string): number {
  const cp = grapheme.codePointAt(0) ?? 0;
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return 0;
  if (/^\p{Mn}+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}/u.test(grapheme) || /\p{Regional_Indicator}/u.test(grapheme)) return 2;
  const wide =
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd);
  return wide ? 2 : 1;
}
