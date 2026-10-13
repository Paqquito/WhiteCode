// Implements: SPEC-MOT-024 (whole word, case-insensitive, fenced code excluded, turn-local override).
// Supports: SPEC-IHM-007, E-158.
export function keywordRanges(text: string, keyword: string): readonly { start: number; end: number }[] {
  if (!keyword) return [];
  const plain = text.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, match => " ".repeat(match.length));
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...plain.matchAll(new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, "giu"))].map(m => ({ start: m.index, end: m.index + m[0].length }));
}
