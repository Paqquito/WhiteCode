// Implements: SPEC-CFG-002 (RG-02: durations and sizes with units)

const DURATION_UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000 };
const SIZE_UNITS: Record<string, number> = { b: 1, kb: 1024, ko: 1024, kib: 1024, mb: 1024 ** 2, mo: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, go: 1024 ** 3, gib: 1024 ** 3 };

/** Milliseconds, from a number of milliseconds or a string such as `30s`, `5m`, `1h`, `500ms`. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|min|m|h)\s*$/i.exec(value);
  if (!m) return undefined;
  return Math.round(Number(m[1]) * DURATION_UNITS[m[2]!.toLowerCase()]!);
}

/** Bytes, from a number of bytes or a string such as `40KB`, `10MB`. */
export function parseSize(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value !== "string") return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)?\s*$/i.exec(value);
  if (!m) return undefined;
  const factor = SIZE_UNITS[(m[2] ?? "b").toLowerCase()];
  return factor === undefined ? undefined : Math.round(Number(m[1]) * factor);
}

/** Decimal amount written with a dot, no thousands separator, no currency (SPEC-MOD-005 § 5.5). */
export function parseAmount(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  if (typeof value !== "string" || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  const n = Number(value);
  return n > 0 ? n : undefined;
}

export function parseBoolean(value: string): boolean | undefined {
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return undefined;
}
