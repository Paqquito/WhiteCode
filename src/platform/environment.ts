// Supports: SPEC-CFG-007 (EF-02 public variables read under their standard names)
// Runtime adapter: snapshot of the process environment. Only the `config` module may import this file (P-07).

export function readProcessEnvironment(): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
  return out;
}
