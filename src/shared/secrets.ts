// Supports: SPEC-IHM-008 (RG-04 sensitive values never recorded), SPEC-IHM-012 (CA-06 masking before the context), SPEC-IHM-010 (§ 12 warning before sending a pasted secret)
// Detection and masking of values that look like secrets in a free text: keys and tokens of the usual services, private
// keys, connection strings and assignments of a password or a key.
// Supports: SPEC-OUT-015/CA-02 (also redact token prefixes following literal escaped whitespace), gap E-229.

const PATTERNS: readonly RegExp[] = [
  // Keys and tokens with a recognisable prefix.
  /(?:\b|(?<=\\[nrt]))(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  // Private keys.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Credentials in a connection string.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]{3,}@/gi,
  // Assignments: password=…, api_key: …, token "…".
  /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?key|auth[_-]?token|token)\b\s*[:=]\s*["']?[^\s"']{6,}/gi,
];

export function containsSecret(text: string): boolean {
  return PATTERNS.some((p) => {
    p.lastIndex = 0;
    return p.test(text);
  });
}

/** The text with every value that looks like a secret replaced by a mask. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const p of PATTERNS) {
    p.lastIndex = 0;
    out = out.replace(p, "[masqué]");
  }
  return out;
}
