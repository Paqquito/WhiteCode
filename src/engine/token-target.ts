// Implements: SPEC-MOT-022 (explicit objective, turn-local output count, cost and iteration precedence).
// Supports: SPEC-MOD-005, E-158.
export const TOKEN_TARGET_EXPLANATION = "An explicit user output-token objective (+number with k, M or B) is a minimum for that request. Product reminders report its measured progress; all cost, time and iteration limits still apply.";
export function tokenTarget(text: string): number | undefined {
  const plain = text.replace(/```[^]*?(?:```|$)|~~~[^]*?(?:~~~|$)/g, "");
  const match = /(?:\+|\b(?:dépense|depense|spend)\s+)(\d+(?:[.,]\d+)?)\s*([kmb])\b/i.exec(plain);
  if (!match) return;
  const value = Number(match[1]!.replace(",", ".")) * ({ k: 1000, m: 1_000_000, b: 1_000_000_000 }[match[2]!.toLowerCase()] ?? 1);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
