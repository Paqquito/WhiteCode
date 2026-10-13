// Implements: SPEC-EXT-024 (EF-02, validated user syntax), gap E-153.
export function parseLoop(args: string): { seconds: number; prompt: string } {
  const text = args.trim(), match = /^(\d+(?:\.\d+)?)(s|m|h)\s+([\s\S]+)$/.exec(text);
  const seconds = match ? Number(match[1]) * ({ s: 1, m: 60, h: 3600 }[match[2] as "s" | "m" | "h"]) : 600;
  if (!text || (!match && /^\d/.test(text)) || !Number.isInteger(seconds) || seconds < 30 || seconds > 86400) throw new Error("Usage : /loop [30s à 24h] <consigne> ; défaut : 10m.");
  return { seconds, prompt: match ? match[3]!.trim() : text };
}
