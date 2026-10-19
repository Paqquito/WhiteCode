// Supports: SPEC-IHM-037 (local explicit negative statements), gap E-285.
// Only a fixed local signal is retained; no message, model call or telemetry is produced.
export const FRUSTRATION_SURVEY_PREFIX = "Un problème dans cet échange";
export function explicitFrustration(input: string): boolean {
  if (input.length > 160 || /[\r\n\u2028\u2029]/.test(input)) return false;
  const text = input.trim();
  if (!text) return false;
  return /^(?:(?:ça|cela) ne (?:marche|fonctionne)(?: toujours)? pas|this (?:does not|doesn't|still does not) work|still broken)[ \t]*[.!]*$/iu.test(text);
}
